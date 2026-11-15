import type {
  ContentBlock,
  Id,
  Principal,
  RunLimits,
  RunStatus,
  RuntimeErrorInfo,
  Session,
  StopReason,
  TokenUsage,
} from '../core/types.js';
import { DEFAULT_RUN_LIMITS } from '../core/types.js';
import { DomainError } from '../core/errors.js';
import type { SessionStore } from '../store/ports.js';
import type { ToolDefinition, ToolRegistry } from '../tools/ports.js';
import type { AgentRuntime } from './agent-runtime.js';

export interface SpawnSubagentInput {
  prompt: string | ContentBlock[];
  principal: Principal;
  parentSessionId?: Id;
  parentRunId?: Id;
  title?: string;
  systemPrompt?: string;
  model?: string;
  tools?: string[];
  maxOutputTokens?: number;
  limits?: Partial<RunLimits>;
  leaseMs?: number;
  maxDepth?: number;
  forkFromParent?: boolean;
  forkAtSeq?: number;
  signal?: AbortSignal;
  /** Optional handler if child run suspends for waiting_input; otherwise cancels child wait and returns error */
  onWaitingInput?: (info: {
    sessionId: Id;
    runId: Id;
    pendingInput: NonNullable<import('../core/types.js').Run['pendingInput']>;
  }) => Promise<'approve' | 'deny' | 'cancel'>;
}

export interface SubagentResult {
  sessionId: Id;
  runId: Id;
  status: RunStatus;
  stopReason: StopReason | null;
  finalText: string | null;
  usage: TokenUsage;
  error?: RuntimeErrorInfo;
  depth: number;
}

async function computeSessionDepth(store: SessionStore, sessionId: Id): Promise<number> {
  let depth = 0;
  let currentId: Id | undefined = sessionId;
  const seen = new Set<Id>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const sess = await store.getSession(currentId);
    if (!sess?.parentSessionId) break;
    depth += 1;
    currentId = sess.parentSessionId;
  }
  return depth;
}

function intersectToolLists(parentTools: string[] | undefined, requestedTools: string[] | undefined): string[] | undefined {
  if (!parentTools && !requestedTools) return undefined;
  if (!parentTools) return requestedTools ? [...requestedTools] : undefined;
  if (!requestedTools) return [...parentTools];
  const allowed = new Set(parentTools);
  return requestedTools.filter((name) => allowed.has(name));
}

export async function runSubagent(
  runtime: AgentRuntime,
  store: SessionStore,
  input: SpawnSubagentInput
): Promise<SubagentResult> {
  if (input.signal?.aborted) {
    throw new DomainError('Subagent aborted before start', 'ABORTED');
  }

  const maxDepth = input.maxDepth ?? 3;
  let parentSession: Session | null = null;
  let childDepth = 0;

  if (input.parentSessionId) {
    parentSession = await store.getSession(input.parentSessionId);
    if (!parentSession) {
      throw new DomainError(`Parent session ${input.parentSessionId} not found`, 'SESSION_NOT_FOUND');
    }
    const parentDepth = await computeSessionDepth(store, input.parentSessionId);
    childDepth = parentDepth + 1;
    if (childDepth > maxDepth) {
      throw new DomainError(
        `Subagent nesting depth ${childDepth} exceeds maxDepth (${maxDepth})`,
        'SUBAGENT_MAX_DEPTH'
      );
    }
  }

  const inheritedTools = intersectToolLists(parentSession?.config.tools, input.tools);
  const childConfig = {
    model: input.model ?? parentSession?.config.model ?? 'gpt-4o-mini',
    systemPrompt:
      input.systemPrompt ??
      'You are a focused subagent. Solve the assigned task concisely and return factual results.',
    maxOutputTokens: input.maxOutputTokens ?? parentSession?.config.maxOutputTokens ?? 2000,
    ...(inheritedTools ? { tools: inheritedTools } : {}),
    ...(parentSession?.config.contextWindow ? { contextWindow: parentSession.config.contextWindow } : {}),
    ...(parentSession?.config.approvalMode ? { approvalMode: parentSession.config.approvalMode } : {}),
  };

  let childSession: Session;
  if (input.forkFromParent && input.parentSessionId) {
    childSession = await store.forkSession(input.parentSessionId, {
      atSeq: input.forkAtSeq,
      title: input.title ?? 'Subagent Branch',
      config: childConfig,
    });
  } else {
    childSession = await store.createSession({
      title: input.title ?? 'Subagent Session',
      config: childConfig,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
    });
  }

  let effectiveLimits: Partial<RunLimits> = { ...input.limits };
  if (input.parentRunId) {
    const parentRun = await store.getRun(input.parentRunId);
    if (parentRun) {
      const remainingMs = Math.max(1000, parentRun.limits.runTimeoutMs - parentRun.activeElapsedMs);
      const usedTokens = parentRun.usage.inputTokens + parentRun.usage.outputTokens;
      const remainingTokens = Math.max(1000, parentRun.limits.tokenBudget - usedTokens);
      effectiveLimits = {
        ...effectiveLimits,
        runTimeoutMs: Math.min(effectiveLimits.runTimeoutMs ?? DEFAULT_RUN_LIMITS.runTimeoutMs, remainingMs),
        tokenBudget: Math.min(effectiveLimits.tokenBudget ?? DEFAULT_RUN_LIMITS.tokenBudget, remainingTokens),
      };
    }
  }

  const handle = await runtime.startRun({
    sessionId: childSession.id,
    userInput: input.prompt,
    principal: input.principal,
    limits: effectiveLimits,
    leaseMs: input.leaseMs,
  });

  const onAbort = () => {
    void handle.cancel();
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    let outcome = await handle.result;
    while (outcome.status === 'waiting_input' && outcome.pendingInput?.kind === 'approval') {
      if (!input.onWaitingInput) {
        await runtime.cancelRun(outcome.runId);
        return {
          sessionId: childSession.id,
          runId: outcome.runId,
          status: 'cancelled',
          stopReason: 'cancelled',
          finalText: null,
          usage: outcome.usage,
          error: {
            code: 'SUBAGENT_APPROVAL_REQUIRED',
            message: `Subagent requires interactive approval for tool '${outcome.pendingInput.toolName}'`,
            retryable: false,
          },
          depth: childDepth,
        };
      }
      const action = await input.onWaitingInput({
        sessionId: childSession.id,
        runId: outcome.runId,
        pendingInput: outcome.pendingInput,
      });
      if (action === 'cancel') {
        await runtime.cancelRun(outcome.runId);
        return {
          sessionId: childSession.id,
          runId: outcome.runId,
          status: 'cancelled',
          stopReason: 'cancelled',
          finalText: null,
          usage: outcome.usage,
          depth: childDepth,
        };
      }
      const resumed = await runtime.submitToolDecision(outcome.runId, action, input.principal, input.leaseMs);
      outcome = await resumed.result;
    }

    return {
      sessionId: childSession.id,
      runId: outcome.runId,
      status: outcome.status,
      stopReason: outcome.stopReason,
      finalText: outcome.finalText,
      usage: outcome.usage,
      error: outcome.error,
      depth: childDepth,
    };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
  }
}

export async function runSubagentsParallel(
  runtime: AgentRuntime,
  store: SessionStore,
  inputs: SpawnSubagentInput[]
): Promise<SubagentResult[]> {
  return Promise.all(inputs.map((input) => runSubagent(runtime, store, input)));
}

export interface SubagentToolOptions {
  toolName?: string;
  description?: string;
  registry?: ToolRegistry;
  defaultSystemPrompt?: string;
  defaultModel?: string;
  maxDepth?: number;
  requiredPermissions?: string[];
  onWaitingInput?: SpawnSubagentInput['onWaitingInput'];
}

export function createSubagentTool(
  runtime: AgentRuntime,
  store: SessionStore,
  options: SubagentToolOptions = {}
): ToolDefinition<{
  task: string;
  systemPrompt?: string;
  tools?: string[];
  inheritContext?: boolean;
  title?: string;
}> {
  const toolName = options.toolName ?? 'spawn_subagent';
  const maxDepth = options.maxDepth ?? 3;

  return {
    name: toolName,
    description:
      options.description ??
      'Delegate a focused subtask to an isolated child subagent and return its final answer.',
    inputSchema: {
      type: 'object',
      required: ['task'],
      properties: {
        task: { type: 'string', description: 'Clear, self-contained task description for the subagent.' },
        systemPrompt: { type: 'string', description: 'Optional system prompt override for the subagent.' },
        tools: { type: 'array', description: 'Optional subset of tool names the subagent may call.' },
        inheritContext: { type: 'boolean', description: 'If true, fork the current session history into the subagent.' },
        title: { type: 'string', description: 'Optional title for the child subagent session.' },
      },
    },
    sideEffect: 'none',
    requiredPermissions: options.requiredPermissions ?? [],
    timeoutMs: 300_000,
    async execute(args, ctx) {
      try {
        const parentDepth = await computeSessionDepth(store, ctx.sessionId);
        let childTools = args.tools;
        if (parentDepth + 1 >= maxDepth && options.registry) {
          const allExceptSelf = options.registry
            .list(childTools ? { names: childTools } : undefined)
            .map((entry) => entry.def.name)
            .filter((name) => name !== toolName);
          childTools = allExceptSelf;
        }

        const result = await runSubagent(runtime, store, {
          prompt: args.task,
          principal: ctx.principal,
          parentSessionId: ctx.sessionId,
          parentRunId: ctx.runId,
          title: args.title,
          systemPrompt: args.systemPrompt ?? options.defaultSystemPrompt,
          model: options.defaultModel,
          tools: childTools,
          maxDepth,
          forkFromParent: Boolean(args.inheritContext),
          signal: ctx.signal,
          onWaitingInput: options.onWaitingInput,
        });

        const isError = result.status !== 'completed';
        const summaryText = isError
          ? `Subagent (${result.sessionId}) ended with status=${result.status}: ${result.error?.message ?? result.stopReason ?? 'failed'}`
          : result.finalText ?? '';

        return {
          content: summaryText,
          isError,
          data: {
            sessionId: result.sessionId,
            runId: result.runId,
            status: result.status,
            stopReason: result.stopReason,
            usage: result.usage,
            depth: result.depth,
          },
        };
      } catch (err: any) {
        return {
          content: `Subagent error: ${err?.message ?? String(err)}`,
          isError: true,
        };
      }
    },
  };
}
