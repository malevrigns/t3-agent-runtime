import { createHash } from 'node:crypto';
import type {
  ContentBlock,
  Message,
  PendingInput,
  Principal,
  Run,
  RunStatus,
  RuntimeErrorInfo,
  StopReason,
  TokenUsage,
} from '../core/types.js';
import type { ModelAdapter, ModelRequest } from '../model/ports.js';
import type { ToolExecutor, ToolRegistry, ToolResult } from '../tools/ports.js';
import type { MemoryManager } from '../memory/ports.js';
import type { QueuedTurnMessage, SessionStore, ToolExecutionRecord } from '../store/ports.js';
import type { EventBus, RunEvent } from '../events/ports.js';
import type { RuntimeHook } from './hooks.js';
import { SpeculativeToolEngine, type SpeculativeSource } from './speculative.js';

export interface SpeculativeStats {
  hits: number;
  reasoningHits: number;
  toolDeltaHits: number;
  savedMs: number;
}

export interface LoopDeps {
  store: SessionStore;
  model: ModelAdapter;
  registry: ToolRegistry;
  executor: ToolExecutor;
  memory: MemoryManager;
  bus: EventBus;
  hooks?: RuntimeHook[];
  enableSpeculativePrefetch?: boolean;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  stopReason: StopReason | null;
  finalText: string | null;
  usage: TokenUsage;
  error?: RuntimeErrorInfo;
  pendingInput?: PendingInput;
  releasedQueue?: QueuedTurnMessage[];
  speculativeStats?: SpeculativeStats;
}

type ToolCallBlock = Extract<ContentBlock, { type: 'tool_call' }>;

function argsHash(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}

export class AgentLoop {
  constructor(private deps: LoopDeps) {}

  async executeRun(
    run: Run,
    principal: Principal,
    cancelSignal: AbortSignal,
    options?: { leaseMs?: number }
  ): Promise<RunOutcome> {
    const { store, model, registry, executor, memory, bus } = this.deps;
    const startedAt = Date.now();
    const elapsed = () => run.activeElapsedMs + (Date.now() - startedAt);
    const leaseMs = options?.leaseMs ?? 60_000;
    let leaseLost = false;

    const remainingRunMs = Math.max(0, run.limits.runTimeoutMs - run.activeElapsedMs);
    const runTimeoutSignal = AbortSignal.timeout(remainingRunMs);
    const combinedRunSignal = AbortSignal.any([cancelSignal, runTimeoutSignal]);

    const heartbeatInterval = setInterval(() => {
      if (!run.leaseOwner || leaseLost) return;
      store.heartbeat(run.id, run.leaseOwner, leaseMs).catch((err) => {
        if (err?.code === 'LEASE_LOST') {
          leaseLost = true;
          return;
        }
        console.warn(`[AgentLoop] Heartbeat failed for run ${run.id}:`, err);
      });
    }, Math.max(250, Math.floor(leaseMs / 3)));
    heartbeatInterval.unref();

    let step = await store.nextStepIndex(run.id);
    let consecutiveToolErrors = 0;
    let announcedResume = false;
    const runSpeculativeStats: SpeculativeStats = {
      hits: 0,
      reasoningHits: 0,
      toolDeltaHits: 0,
      savedMs: 0,
    };
    bus.registerRunSession?.(run.id, run.sessionId);

    const emit = async (event: RunEvent) => {
      if (event.type !== 'model_delta') {
        await store.appendEvent({
          runId: run.id,
          sessionId: run.sessionId,
          type: event.type,
          payload: event,
        });
      }
      bus.publish(event);
    };

    const hooks = this.deps.hooks ?? [];

    const finish = async (
      status: 'completed' | 'failed' | 'cancelled',
      stopReason: StopReason,
      finalText: string | null = null,
      error?: RuntimeErrorInfo
    ): Promise<RunOutcome> => {
      const releasedQueue = await store.takeQueuedMessages(run.sessionId);
      const finalRun = await store.finishRun(run.id, {
        status,
        stopReason,
        error,
        elapsedMs: elapsed(),
      });
      const statsSnapshot = runSpeculativeStats.hits > 0 ? { ...runSpeculativeStats } : undefined;
      await emit({
        type: 'run_finished',
        runId: run.id,
        status: finalRun.status,
        stopReason,
        usage: finalRun.usage,
        ...(statsSnapshot ? { speculativeStats: statsSnapshot } : {}),
      });
      const outcome: RunOutcome = {
        runId: run.id,
        status: finalRun.status,
        stopReason,
        finalText,
        usage: finalRun.usage,
        error,
        releasedQueue: releasedQueue.length > 0 ? releasedQueue : undefined,
        ...(statsSnapshot ? { speculativeStats: statsSnapshot } : {}),
      };
      for (const hook of hooks) {
        await hook.onRunFinished?.({ sessionId: run.sessionId, outcome });
      }
      return outcome;
    };

    const closeRemainingCalls = async (
      remainingCalls: ToolCallBlock[],
      reasonMessage: string,
      stepIndex: number
    ) => {
      for (const call of remainingCalls) {
        await store.appendSyntheticToolResult(run.id, call.toolCallId, call.toolName, reasonMessage, stepIndex);
      }
    };

    const suspendForApproval = async (
      execution: ToolExecutionRecord,
      call: ToolCallBlock,
      reason: string,
      preconditionHash: string
    ): Promise<RunOutcome> => {
      await store.markAwaitingApproval(execution.id, preconditionHash);
      const pending: PendingInput = {
        kind: 'approval',
        toolExecutionId: execution.id,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.args,
        reason,
        preconditionHash,
      };
      const suspendedRun = await store.suspendForInput(run.id, pending, elapsed());
      await emit({ type: 'run_waiting_input', runId: run.id, pending });
      return {
        runId: run.id,
        status: suspendedRun.status,
        stopReason: null,
        finalText: null,
        usage: suspendedRun.usage,
        pendingInput: pending,
      };
    };

    const findOpenToolCalls = async (): Promise<{ calls: ToolCallBlock[]; stepIndex: number } | null> => {
      const messages = await store.listMessages(run.sessionId, { includeExcluded: true });
      let assistant: Message | null = null;
      for (const message of messages) {
        if (message.runId !== run.id || message.role !== 'assistant') continue;
        if (message.content.some((block) => block.type === 'tool_call')) assistant = message;
      }
      if (!assistant) return null;
      const answered = new Set<string>();
      for (const message of messages) {
        if (message.role !== 'tool') continue;
        for (const block of message.content) {
          if (block.type === 'tool_result') answered.add(block.toolCallId);
        }
      }
      const calls = assistant.content.filter(
        (block): block is ToolCallBlock => block.type === 'tool_call' && !answered.has(block.toolCallId)
      );
      if (calls.length === 0) return null;
      return { calls, stepIndex: assistant.stepIndex ?? step };
    };

    const drain = async (kind: 'steer' | 'follow_up'): Promise<number> => {
      const queued = await store.takeQueuedMessages(run.sessionId, kind);
      for (const item of queued) {
        const saved = await store.appendRunMessage({ runId: run.id, content: item.content });
        await emit({
          type: 'message_appended',
          runId: run.id,
          messageId: saved.id,
          seq: saved.seq,
          role: 'user',
        });
      }
      return queued.length;
    };

    let activeSpeculative: SpeculativeToolEngine | null = null;

    const executeSingleCall = async (
      call: ToolCallBlock,
      execution: ToolExecutionRecord,
      existing: boolean,
      idempotencyKey: string,
      stepIndex: number,
      speculative?: SpeculativeToolEngine | null
    ): Promise<{
      result: ToolResult;
      speculativeSource?: SpeculativeSource;
      savedMs?: number;
    }> => {
      if (existing && execution.status === 'succeeded' && execution.result) {
        return { result: execution.result };
      }
      if (existing && execution.status === 'awaiting_approval') {
        if (!execution.approvalDecision) {
          return {
            result: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'awaiting_approval',
              content: execution.result?.content || 'Approval required',
              durationMs: 0,
              preconditionHash: execution.preconditionHash ?? argsHash(call.args),
            },
          };
        }
        const currentHash = argsHash(call.args);
        if (execution.preconditionHash && execution.preconditionHash !== currentHash) {
          return {
            result: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'error',
              content: 'Approval precondition failed because the tool arguments changed.',
              error: { code: 'PRECONDITION_FAILED', message: 'Arguments changed after approval', retryable: false },
              durationMs: 0,
            },
          };
        }
        if (execution.approvalDecision === 'deny') {
          return {
            result: {
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              status: 'error',
              content: `User denied execution of tool '${call.toolName}'.`,
              error: { code: 'PERMISSION_DENIED', message: 'User denied tool execution', retryable: false },
              durationMs: 0,
            },
          };
        }
        const result = await executor.execute(
          { toolCallId: call.toolCallId, toolName: call.toolName, args: call.args },
          {
            sessionId: run.sessionId,
            runId: run.id,
            toolExecutionId: execution.id,
            idempotencyKey,
            principal,
            signal: combinedRunSignal,
            approvalGranted: true,
          }
        );
        return { result };
      }
      if (existing && execution.result && execution.status !== 'running') {
        return { result: execution.result };
      }

      let effectiveArgs = call.args;
      let blockedReason: string | null = null;
      let blockingHookName = '';

      if (hooks.length > 0) {
        const hookSession = await store.getSession(run.sessionId);
        if (hookSession) {
          for (const hook of hooks) {
            if (!hook.beforeToolCall) continue;
            const decision = await hook.beforeToolCall({
              session: hookSession,
              run,
              stepIndex,
              call: { toolCallId: call.toolCallId, toolName: call.toolName, args: effectiveArgs },
              principal,
            });
            if (!decision) continue;
            if (decision.action === 'block') {
              blockedReason = decision.reason;
              blockingHookName = hook.name;
              break;
            }
            if (decision.action === 'allow' && decision.args !== undefined) {
              effectiveArgs = decision.args;
            }
          }
        }
      }

      if (blockedReason !== null) {
        return {
          result: {
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            status: 'error',
            content: `Blocked by hook '${blockingHookName}': ${blockedReason}`,
            error: { code: 'PERMISSION_DENIED', message: blockedReason, retryable: false },
            durationMs: 0,
          },
        };
      }

      const cached = speculative
        ? await speculative.consume({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: effectiveArgs,
          })
        : null;
      if (cached) {
        return {
          result: cached.result,
          speculativeSource: cached.source,
          savedMs: cached.savedMs,
        };
      }

      const result = await executor.execute(
        { toolCallId: call.toolCallId, toolName: call.toolName, args: effectiveArgs },
        {
          sessionId: run.sessionId,
          runId: run.id,
          toolExecutionId: execution.id,
          idempotencyKey,
          principal,
          signal: combinedRunSignal,
        }
      );
      return { result };
    };

    const executeToolBatch = async (
      toolCalls: ToolCallBlock[],
      stepIndex: number,
      speculative?: SpeculativeToolEngine | null
    ): Promise<RunOutcome | null> => {
      let i = 0;
      while (i < toolCalls.length) {
        const fresh = await store.getRun(run.id);
        if (fresh) run = fresh;

        if (leaseLost) {
          return {
            runId: run.id,
            status: 'interrupted',
            stopReason: 'crashed',
            finalText: null,
            usage: run.usage,
            error: { code: 'LEASE_LOST', message: 'Lost run lease', retryable: false },
          };
        }
        if (cancelSignal.aborted) {
          await closeRemainingCalls(toolCalls.slice(i), 'Execution cancelled by user', stepIndex);
          return finish('cancelled', 'cancelled');
        }
        if (runTimeoutSignal.aborted || elapsed() >= run.limits.runTimeoutMs) {
          await closeRemainingCalls(toolCalls.slice(i), 'Execution aborted: run timeout exceeded', stepIndex);
          return finish('failed', 'timeout', null, {
            code: 'TIMEOUT',
            message: 'Run total execution timeout exceeded',
            retryable: false,
          });
        }
        if (run.toolCalls >= run.limits.maxToolCalls) {
          await closeRemainingCalls(toolCalls.slice(i), 'Execution aborted: max tool calls limit reached', stepIndex);
          return finish('failed', 'max_tool_calls', null, {
            code: 'MAX_TOOL_CALLS',
            message: `Maximum tool calls limit reached (${run.limits.maxToolCalls})`,
            retryable: false,
          });
        }

        const firstDef = registry.get(toolCalls[i].toolName);
        const hasSequentialBeforeHook = hooks.some(
          (h) => Boolean(h.beforeToolCall) && h.name !== 'shadow-fs-time-machine'
        );
        const isFirstReadOnly = firstDef?.def.sideEffect === 'none' && !hasSequentialBeforeHook;

        let batchEnd = i + 1;
        if (isFirstReadOnly) {
          const remainingBudget = Math.max(1, run.limits.maxToolCalls - run.toolCalls);
          const maxEnd = Math.min(toolCalls.length, i + remainingBudget);
          while (batchEnd < maxEnd) {
            const nextDef = registry.get(toolCalls[batchEnd].toolName);
            if (nextDef?.def.sideEffect !== 'none') break;
            batchEnd++;
          }
        }

        const segment = toolCalls.slice(i, batchEnd);
        const prepared: Array<{
          call: ToolCallBlock;
          execution: ToolExecutionRecord;
          existing: boolean;
          idempotencyKey: string;
        }> = [];

        for (const call of segment) {
          const def = registry.get(call.toolName);
          const idempotencyKey = `${run.sessionId}:${run.id}:${call.toolCallId}`;
          const { execution, existing } = await store.beginToolExecution({
            runId: run.id,
            sessionId: run.sessionId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
            sideEffect: def?.def.sideEffect ?? 'none',
            idempotencyKey,
          });

          await emit({
            type: 'tool_execution_started',
            runId: run.id,
            toolExecutionId: execution.id,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          });

          prepared.push({ call, execution, existing, idempotencyKey });
        }

        const executed = await Promise.all(
          prepared.map((item) =>
            executeSingleCall(
              item.call,
              item.execution,
              item.existing,
              item.idempotencyKey,
              stepIndex,
              speculative
            )
          )
        );

        for (let k = 0; k < prepared.length; k++) {
          const { call, execution } = prepared[k];
          const { result, speculativeSource, savedMs } = executed[k];

          if (result.status === 'awaiting_approval') {
            return suspendForApproval(
              execution,
              call,
              result.content,
              result.preconditionHash ?? argsHash(call.args)
            );
          }

          await store.completeToolExecution(execution.id, result, stepIndex);
          run = (await store.getRun(run.id))!;

          if (hooks.length > 0) {
            const hookSession = await store.getSession(run.sessionId);
            if (hookSession) {
              for (const hook of hooks) {
                await hook.afterToolCall?.({
                  session: hookSession,
                  run,
                  stepIndex,
                  call: { toolCallId: call.toolCallId, toolName: call.toolName, args: call.args },
                  result,
                });
              }
            }
          }

          if (result.fromCache && speculativeSource) {
            runSpeculativeStats.hits++;
            if (speculativeSource === 'reasoning_intent') {
              runSpeculativeStats.reasoningHits++;
            } else {
              runSpeculativeStats.toolDeltaHits++;
            }
            runSpeculativeStats.savedMs += savedMs ?? 0;
          }

          await emit({
            type: 'tool_execution_finished',
            runId: run.id,
            toolExecutionId: execution.id,
            toolCallId: call.toolCallId,
            status: result.status,
            errorCode: result.error?.code,
            durationMs: result.durationMs,
            ...(result.fromCache
              ? {
                  fromCache: true,
                  speculativeHit: true,
                  speculativeSource,
                  savedMs,
                }
              : {}),
          });

          const uncommittedAfter = toolCalls.slice(i + k + 1);
          if (cancelSignal.aborted || result.error?.code === 'CANCELLED') {
            await closeRemainingCalls(uncommittedAfter, 'Execution cancelled by user', stepIndex);
            return finish('cancelled', 'cancelled');
          }

          if (result.status === 'error' && result.error?.code !== 'PERMISSION_DENIED') {
            consecutiveToolErrors++;
            if (result.fatal || consecutiveToolErrors >= run.limits.maxConsecutiveToolErrors) {
              await closeRemainingCalls(
                uncommittedAfter,
                'Execution aborted: max consecutive tool errors exceeded',
                stepIndex
              );
              return finish('failed', 'tool_error', null, {
                code: result.error?.code ?? 'TOOL_ERROR',
                message: `Exceeded max consecutive tool errors (${run.limits.maxConsecutiveToolErrors}): ${result.content}`,
                retryable: false,
              });
            }
          } else {
            consecutiveToolErrors = 0;
          }
        }

        if (firstDef?.def.sideEffect !== 'none') {
          // Mutating tool barrier: discard any speculative pre-write reads for subsequent calls in this step
          speculative?.invalidateAfterWrite();
        }

        i = batchEnd;
      }
      return null;
    };

    try {
      const initialOpen = await findOpenToolCalls();
      if (initialOpen) {
        announcedResume = true;
        await emit({ type: 'run_resumed', runId: run.id });
      } else {
        await emit({ type: 'run_started', runId: run.id, sessionId: run.sessionId });
      }

      while (true) {
        if (leaseLost) {
          return {
            runId: run.id,
            status: 'interrupted',
            stopReason: 'crashed',
            finalText: null,
            usage: run.usage,
            error: { code: 'LEASE_LOST', message: 'Lost run lease', retryable: false },
          };
        }
        if (cancelSignal.aborted) return finish('cancelled', 'cancelled');
        if (runTimeoutSignal.aborted || elapsed() >= run.limits.runTimeoutMs) {
          return finish('failed', 'timeout', null, {
            code: 'TIMEOUT',
            message: 'Run total execution timeout exceeded',
            retryable: false,
          });
        }
        if (run.modelCalls >= run.limits.maxModelCalls) {
          return finish('failed', 'max_model_calls', null, {
            code: 'MAX_MODEL_CALLS',
            message: `Maximum model calls (${run.limits.maxModelCalls}) reached`,
            retryable: false,
          });
        }
        const totalTokens = run.usage.inputTokens + run.usage.outputTokens;
        if (totalTokens >= run.limits.tokenBudget) {
          return finish('failed', 'token_budget_exceeded', null, {
            code: 'TOKEN_BUDGET_EXCEEDED',
            message: `Token budget (${run.limits.tokenBudget}) exceeded`,
            retryable: false,
          });
        }

        const openBatch = await findOpenToolCalls();
        if (openBatch) {
          if (!announcedResume) {
            announcedResume = true;
            await emit({ type: 'run_resumed', runId: run.id });
          }
          const resumedOutcome = await executeToolBatch(openBatch.calls, openBatch.stepIndex);
          if (resumedOutcome) return resumedOutcome;
          step = openBatch.stepIndex + 1;
        }

        await drain('steer');

        let session = await store.getSession(run.sessionId);
        if (!session) throw new Error(`Session ${run.sessionId} not found`);
        if (!session.config.contextWindow) {
          session = await store.updateSessionConfig(session.id, {
            ...session.config,
            contextWindow: model.capabilities.contextWindow,
          });
        }

        try {
          await memory.maintain(session.id, combinedRunSignal);
        } catch (err: any) {
          if (cancelSignal.aborted) return finish('cancelled', 'cancelled');
          return finish('failed', 'model_error', null, {
            code: 'CONTEXT_COMPACTION_FAILED',
            message: err?.message || 'Context compaction failed',
            retryable: true,
          });
        }

        await emit({ type: 'step_started', runId: run.id, stepIndex: step });
        const toolSpecs = registry.toModelSpecs(session.config.tools);
        const contextWindow = session.config.contextWindow ?? model.capabilities.contextWindow;
        const ctx = await memory.buildContext({
          session,
          runId: run.id,
          systemPrompt: session.config.systemPrompt,
          tools: toolSpecs,
          budget: {
            maxInputTokens: contextWindow,
            reserveForOutput: session.config.maxOutputTokens,
          },
        });
        await emit({
          type: 'context_built',
          runId: run.id,
          stepIndex: step,
          manifest: ctx.manifest,
          estimatedTokens: ctx.estimatedTokens,
        });

        let modelRequest: ModelRequest = {
          model: session.config.model,
          system: ctx.system,
          messages: ctx.messages,
          tools: toolSpecs,
          maxOutputTokens: session.config.maxOutputTokens,
        };
        for (const hook of hooks) {
          if (!hook.beforeModelCall) continue;
          const updated = await hook.beforeModelCall({
            session,
            run,
            stepIndex: step,
            request: modelRequest,
          });
          if (updated) modelRequest = updated;
        }

        await emit({ type: 'model_call_started', runId: run.id, stepIndex: step });
        const modelTimeoutSignal = AbortSignal.timeout(run.limits.modelCallTimeoutMs);
        const combinedModelSignal = AbortSignal.any([combinedRunSignal, modelTimeoutSignal]);

        const speculative =
          this.deps.enableSpeculativePrefetch !== false
            ? new SpeculativeToolEngine({
                registry,
                executor,
                session,
                run,
                principal,
                signal: combinedRunSignal,
                onPrefetched: ({ toolCallId, toolName, source }) => {
                  bus.publish({
                    type: 'tool_speculative_prefetched',
                    runId: run.id,
                    stepIndex: step,
                    toolCallId,
                    toolName,
                    source,
                  });
                },
              })
            : null;
        activeSpeculative = speculative;

        let response;
        try {
          response = await model.generate(modelRequest, {
            signal: combinedModelSignal,
            onDelta: (delta) => {
              if (delta.type === 'reasoning_delta') {
                bus.publish({
                  type: 'model_reasoning_delta',
                  runId: run.id,
                  stepIndex: step,
                  text: delta.text,
                });
                speculative?.onDelta(delta);
              } else if (delta.type === 'text_delta') {
                bus.publish({
                  type: 'model_delta',
                  runId: run.id,
                  stepIndex: step,
                  text: delta.text,
                });
              } else if (delta.type === 'tool_call_delta') {
                speculative?.onDelta(delta);
              }
            },
          });
          speculative?.markStreamFinished();
        } catch (err: any) {
          speculative?.abortAll();
          activeSpeculative = null;
          if (cancelSignal.aborted) return finish('cancelled', 'cancelled');
          if (runTimeoutSignal.aborted) {
            return finish('failed', 'timeout', null, {
              code: 'RUN_TIMEOUT',
              message: `Run total execution timeout exceeded (${run.limits.runTimeoutMs}ms)`,
              retryable: false,
            });
          }
          if (modelTimeoutSignal.aborted) {
            return finish('failed', 'timeout', null, {
              code: 'MODEL_TIMEOUT',
              message: `Model call timed out after ${run.limits.modelCallTimeoutMs}ms`,
              retryable: true,
            });
          }
          const errInfo: RuntimeErrorInfo = {
            code: 'MODEL_ERROR',
            message: err.message || 'Model call failed',
            retryable: false,
          };
          await emit({ type: 'model_call_failed', runId: run.id, stepIndex: step, error: errInfo });
          return finish('failed', 'model_error', null, errInfo);
        }

        for (const hook of hooks) {
          await hook.afterModelCall?.({
            session,
            run,
            stepIndex: step,
            request: modelRequest,
            response,
          });
        }

        await store.appendAssistantMessage(run.id, {
          stepIndex: step,
          content: response.content,
          usage: response.usage,
          model: response.model,
          elapsedMs: elapsed(),
        });
        run = (await store.getRun(run.id))!;
        await emit({
          type: 'model_call_finished',
          runId: run.id,
          stepIndex: step,
          usage: response.usage,
          finishReason: response.finishReason,
        });

        const toolCalls = response.content.filter((block): block is ToolCallBlock => block.type === 'tool_call');
        speculative?.reconcile(toolCalls);
        if (toolCalls.length === 0) {
          speculative?.abortAll();
          activeSpeculative = null;
          if (await drain('steer')) continue;
          if (await drain('follow_up')) continue;
          const textBlock = response.content.find(
            (block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text'
          );
          return finish('completed', 'completed', textBlock?.text ?? '');
        }

        const batchOutcome = await executeToolBatch(toolCalls, step, speculative);
        speculative?.abortAll();
        activeSpeculative = null;
        if (batchOutcome) return batchOutcome;
        step++;
      }
    } catch (err: any) {
      console.error('[AgentLoop] Fatal error:', err);
      throw err;
    } finally {
      activeSpeculative?.abortAll();
      clearInterval(heartbeatInterval);
    }
  }
}
