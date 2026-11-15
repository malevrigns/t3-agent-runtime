import type { ContentBlock, Id, Message, Run, Session } from '../core/types.js';
import type { ModelAdapter, ModelCallOptions, ModelFinishReason, ModelRequest, ModelResponse } from '../model/ports.js';
import type { PersistedEvent, SessionStore, ToolExecutionRecord } from '../store/ports.js';
import { DomainError } from '../core/errors.js';

export interface TrajectoryModelStep {
  stepIndex: number;
  messageId: Id;
  model: string;
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
  };
  finishReason: ModelFinishReason;
}

export interface RunTrajectory {
  version: 1;
  run: Run;
  session: Session | null;
  messages: Message[];
  toolExecutions: ToolExecutionRecord[];
  events: PersistedEvent[];
  modelSteps: TrajectoryModelStep[];
}

export async function exportRunTrajectory(store: SessionStore, runId: Id): Promise<RunTrajectory> {
  const run = await store.getRun(runId);
  if (!run) {
    throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
  }

  const [session, allMessages, toolExecutions, events] = await Promise.all([
    store.getSession(run.sessionId),
    store.listMessages(run.sessionId, { includeExcluded: true }),
    store.listToolExecutions(runId),
    store.listEvents(runId),
  ]);

  const messages = allMessages.filter((message) => message.runId === runId);

  const finishReasonsByStep = new Map<number, ModelFinishReason>();
  for (const event of events) {
    if (event.type === 'model_call_finished' && event.payload && typeof event.payload === 'object') {
      const payload = event.payload as { stepIndex?: number; finishReason?: ModelFinishReason };
      if (typeof payload.stepIndex === 'number' && payload.finishReason) {
        finishReasonsByStep.set(payload.stepIndex, payload.finishReason);
      }
    }
  }

  const modelSteps: TrajectoryModelStep[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const stepIndex = message.stepIndex ?? modelSteps.length;
    const hasToolCalls = message.content.some((block) => block.type === 'tool_call');
    modelSteps.push({
      stepIndex,
      messageId: message.id,
      model: message.model ?? session?.config.model ?? 'recorded',
      content: message.content,
      usage: message.usage ?? { inputTokens: 0, outputTokens: 0 },
      finishReason: finishReasonsByStep.get(stepIndex) ?? (hasToolCalls ? 'tool_use' : 'stop'),
    });
  }

  return {
    version: 1,
    run,
    session,
    messages,
    toolExecutions,
    events,
    modelSteps,
  };
}

export interface ReplayModelOptions {
  strictModelName?: boolean;
  onRequest?: (req: ModelRequest, step: TrajectoryModelStep, callIndex: number) => void;
}

/**
 * Deterministic ModelAdapter that replays recorded assistant steps from a RunTrajectory.
 */
export class ReplayModelAdapter implements ModelAdapter {
  readonly providerId = 'replay';
  readonly capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    contextWindow: number;
  };

  private cursor = 0;
  private readonly steps: TrajectoryModelStep[];

  constructor(trajectory: RunTrajectory, private readonly options: ReplayModelOptions = {}) {
    this.steps = [...trajectory.modelSteps];
    this.capabilities = {
      toolCalling: true,
      streaming: true,
      contextWindow: trajectory.session?.config.contextWindow ?? 128_000,
    };
  }

  get remainingSteps(): number {
    return Math.max(0, this.steps.length - this.cursor);
  }

  reset(): void {
    this.cursor = 0;
  }

  async generate(req: ModelRequest, opts: ModelCallOptions): Promise<ModelResponse> {
    if (opts.signal.aborted) {
      throw new DomainError('Replay aborted by signal', 'ABORTED');
    }

    const step = this.steps[this.cursor];
    if (!step) {
      throw new DomainError(
        `ReplayModelAdapter exhausted after ${this.steps.length} recorded steps`,
        'REPLAY_EXHAUSTED'
      );
    }

    if (this.options.strictModelName && req.model !== step.model) {
      throw new DomainError(
        `Replay model mismatch: expected '${step.model}', got '${req.model}'`,
        'REPLAY_MODEL_MISMATCH'
      );
    }

    this.options.onRequest?.(req, step, this.cursor);
    this.cursor += 1;

    for (const block of step.content) {
      if (block.type === 'text' && block.text) {
        opts.onDelta?.({ type: 'text_delta', text: block.text });
      }
    }

    return {
      content: structuredClone(step.content),
      finishReason: step.finishReason,
      usage: { ...step.usage },
      model: step.model,
    };
  }
}
