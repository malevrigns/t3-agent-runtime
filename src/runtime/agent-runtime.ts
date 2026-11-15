import type {
  ContentBlock,
  Id,
  NewSession,
  Principal,
  RunLimits,
  Session,
} from '../core/types.js';
import { DEFAULT_RUN_LIMITS } from '../core/types.js';
import { DomainError, InvalidRunStateError } from '../core/errors.js';
import type { ForkSessionOptions, QueuedTurnMessage, SessionStore, StepFileSnapshot } from '../store/ports.js';
import type { EventBus, RunEvent } from '../events/ports.js';
import { AgentLoop, type RunOutcome } from './agent-loop.js';
import { RecoveryService, type RecoveryReport } from './recovery.js';
import { exportRunTrajectory, type RunTrajectory } from './trajectory.js';
import { ShadowFsTimeMachine, type RevertOptions, type RevertReport } from './time-machine.js';
import {
  runSubagent,
  runSubagentsParallel,
  type SpawnSubagentInput,
  type SubagentResult,
} from './subagent.js';

export interface RunHandle {
  runId: Id;
  result: Promise<RunOutcome>;
  cancel: () => Promise<QueuedTurnMessage[]>;
}

export type TurnPushResult =
  | { queued: true; id: Id }
  | { queued: false; handle: RunHandle };

export class AgentRuntime {
  private activeControllers = new Map<Id, AbortController>();
  private readonly timeMachine: ShadowFsTimeMachine;

  constructor(
    private store: SessionStore,
    private loop: AgentLoop,
    private bus: EventBus,
    private recovery: RecoveryService,
    private leaseOwner: string = `worker_${process.pid}`
  ) {
    this.timeMachine = new ShadowFsTimeMachine(store);
  }

  async createSession(input: NewSession): Promise<Session> {
    return this.store.createSession(input);
  }

  async forkSession(sessionId: Id, opts?: ForkSessionOptions): Promise<Session> {
    return this.store.forkSession(sessionId, opts);
  }

  async listSessionBranches(sessionId: Id): Promise<Session[]> {
    return this.store.listSessionBranches(sessionId);
  }

  async listFileSnapshots(
    sessionId: Id,
    opts?: { afterSeq?: number; runId?: Id }
  ): Promise<StepFileSnapshot[]> {
    return this.timeMachine.listFileSnapshots(sessionId, opts);
  }

  async revertToSeq(sessionId: Id, targetSeq: number, opts?: RevertOptions): Promise<RevertReport> {
    return this.timeMachine.revertToSeq(sessionId, targetSeq, opts);
  }

  async revertToStep(
    sessionId: Id,
    runId: Id,
    targetStepIndex: number,
    opts?: RevertOptions
  ): Promise<RevertReport> {
    return this.timeMachine.revertToStep(sessionId, runId, targetStepIndex, opts);
  }

  async startRun(input: {
    sessionId: Id;
    userInput: string | ContentBlock[];
    principal: Principal;
    limits?: Partial<RunLimits>;
    leaseMs?: number;
  }): Promise<RunHandle> {
    const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, ...input.limits };
    const content: ContentBlock[] =
      typeof input.userInput === 'string'
        ? [{ type: 'text', text: input.userInput }]
        : input.userInput;

    const leaseMs = input.leaseMs ?? 60_000;
    const { run } = await this.store.startRun({
      sessionId: input.sessionId,
      userContent: content,
      limits,
      leaseOwner: this.leaseOwner,
      leaseMs,
    });

    const abortController = new AbortController();
    this.activeControllers.set(run.id, abortController);

    const executePromise = (async () => {
      try {
        return await this.loop.executeRun(run, input.principal, abortController.signal, { leaseMs });
      } finally {
        this.activeControllers.delete(run.id);
      }
    })();

    return {
      runId: run.id,
      result: executePromise,
      cancel: () => this.cancelRun(run.id),
    };
  }

  async submitToolDecision(
    runId: Id,
    decision: 'approve' | 'deny',
    principal: Principal,
    leaseMs = 60_000
  ): Promise<RunHandle> {
    const existing = await this.store.getRun(runId);
    if (!existing) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
    if (existing.status !== 'waiting_input' || existing.pendingInput?.kind !== 'approval') {
      throw new InvalidRunStateError(runId, existing.status, 'running');
    }
    await this.store.setApprovalDecision(existing.pendingInput.toolExecutionId, decision);
    const run = await this.store.resumeFromInput(runId, this.leaseOwner, leaseMs);
    return this.continueRun(run, principal, leaseMs);
  }

  async steer(
    sessionId: Id,
    userInput: string | ContentBlock[],
    principal: Principal,
    limits?: Partial<RunLimits>
  ): Promise<TurnPushResult> {
    return this.pushTurn(sessionId, userInput, principal, 'steer', limits);
  }

  async followUp(
    sessionId: Id,
    userInput: string | ContentBlock[],
    principal: Principal,
    limits?: Partial<RunLimits>
  ): Promise<TurnPushResult> {
    return this.pushTurn(sessionId, userInput, principal, 'follow_up', limits);
  }

  async cancelRun(runId: Id): Promise<QueuedTurnMessage[]> {
    const ctl = this.activeControllers.get(runId);
    if (ctl) {
      ctl.abort();
      await this.store.requestCancel(runId);
      return [];
    }

    const run = await this.store.getRun(runId);
    if (!run) return [];
    if (run.status === 'waiting_input') {
      const settled = await this.store.abortOpenWait(runId, {
        status: 'cancelled',
        stopReason: 'cancelled',
        message: 'Execution cancelled by user',
        resolveToolsAs: 'cancelled',
      });
      const released = await this.store.takeQueuedMessages(run.sessionId);
      this.bus.publish({
        type: 'run_finished',
        runId,
        status: settled.status,
        stopReason: 'cancelled',
        usage: settled.usage,
      });
      return released;
    }
    if (run.status === 'running' || run.status === 'cancelling') {
      await this.store.requestCancel(runId);
    }
    return [];
  }

  private continueRun(run: { id: Id; sessionId: Id }, principal: Principal, leaseMs: number): RunHandle {
    const abortController = new AbortController();
    this.activeControllers.set(run.id, abortController);
    const executePromise = (async () => {
      try {
        const current = await this.store.getRun(run.id);
        if (!current) throw new DomainError(`Run ${run.id} not found`, 'RUN_NOT_FOUND');
        return await this.loop.executeRun(current, principal, abortController.signal, { leaseMs });
      } finally {
        this.activeControllers.delete(run.id);
      }
    })();
    return {
      runId: run.id,
      result: executePromise,
      cancel: () => this.cancelRun(run.id),
    };
  }

  private async pushTurn(
    sessionId: Id,
    userInput: string | ContentBlock[],
    principal: Principal,
    kind: 'steer' | 'follow_up',
    limits?: Partial<RunLimits>
  ): Promise<TurnPushResult> {
    const content: ContentBlock[] =
      typeof userInput === 'string' ? [{ type: 'text', text: userInput }] : userInput;
    const active = await this.store.getActiveRun(sessionId);
    if (active) {
      const queued = await this.store.enqueueTurnMessage({ sessionId, kind, content });
      return { queued: true, id: queued.id };
    }
    const handle = await this.startRun({ sessionId, userInput: content, principal, limits });
    return { queued: false, handle };
  }

  async recover(now = Date.now()): Promise<RecoveryReport> {
    return this.recovery.recover(now);
  }

  async spawnSubagent(input: SpawnSubagentInput): Promise<SubagentResult> {
    return runSubagent(this, this.store, input);
  }

  async spawnSubagents(inputs: SpawnSubagentInput[]): Promise<SubagentResult[]> {
    return runSubagentsParallel(this, this.store, inputs);
  }

  async exportTrajectory(runId: Id): Promise<RunTrajectory> {
    return exportRunTrajectory(this.store, runId);
  }

  subscribe(filter: { runId?: Id; sessionId?: Id }, fn: (e: RunEvent) => void): () => void {
    return this.bus.subscribe(filter, fn);
  }
}
