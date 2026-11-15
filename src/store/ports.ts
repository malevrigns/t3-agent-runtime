import type {
  ContentBlock,
  Id,
  Message,
  NewSession,
  PendingInput,
  Role,
  Run,
  RunLimits,
  RunStatus,
  RuntimeErrorInfo,
  Session,
  SessionConfig,
  StopReason,
  TokenUsage,
} from '../core/types.js';
import type { SideEffect, ToolResult } from '../tools/ports.js';
import type { ContextManifest, MemoryRecallQuery, MemoryRecord, NewMemory } from '../memory/ports.js';


export interface Episode {
  id: Id;
  sessionId: Id;
  summaryId?: Id;
  fromSeq: number;
  toSeq: number;
  title: string;
  content: string;
  entities: string[];
  tokenEstimate: number;
  createdAt: number;
}

export interface NewEpisode {
  sessionId: Id;
  summaryId?: Id;
  fromSeq: number;
  toSeq: number;
  title: string;
  content: string;
  entities: string[];
  tokenEstimate: number;
}

export interface ToolExecutionRecord {
  id: Id;
  runId: Id;
  sessionId: Id;
  toolCallId: string;
  toolName: string;
  args: unknown;
  sideEffect: SideEffect;
  idempotencyKey: string;
  status: 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'unknown';
  result?: ToolResult;
  errorCode?: string;
  approvalDecision?: 'approve' | 'deny';
  preconditionHash?: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface QueuedTurnMessage {
  id: Id;
  sessionId: Id;
  kind: 'steer' | 'follow_up';
  content: ContentBlock[];
  createdAt: number;
}

export interface BeginToolExecution {
  runId: Id;
  sessionId: Id;
  toolCallId: string;
  toolName: string;
  args: unknown;
  sideEffect: SideEffect;
  idempotencyKey: string;
}

export interface Summary {
  id: Id;
  sessionId: Id;
  fromSeq: number;
  toSeq: number;
  content: string;
  tokenEstimate: number;
  model: string;
  promptVersion: string;
  status: 'active' | 'stale' | 'superseded';
  supersedesId?: Id;
  createdAt: number;
}

export interface NewSummary {
  sessionId: Id;
  fromSeq: number;
  toSeq: number;
  content: string;
  tokenEstimate: number;
  model: string;
  promptVersion: string;
  supersedesId?: Id;
}

export interface PersistedEvent {
  id: number;
  runId: Id;
  sessionId: Id;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface ToolResolution {
  toolExecutionId: Id;
  status: 'failed' | 'unknown';
  errorCode: string;
  syntheticMessage: {
    toolCallId: string;
    toolName: string;
    content: string;
  };
}

export interface ForkSessionOptions {
  atSeq?: number;
  title?: string;
  config?: Partial<SessionConfig>;
}

export type FileChangeType = 'created' | 'modified' | 'deleted';

export interface StepFileSnapshot {
  id: Id;
  sessionId: Id;
  runId: Id;
  stepIndex: number;
  /** Session MAX(seq) immediately before this tool mutated the file. */
  checkpointSeq: number;
  toolExecutionId: Id;
  toolCallId: string;
  toolName: string;
  filePath: string;
  changeType: FileChangeType;
  existedBefore: boolean;
  beforeContentB64?: string;
  beforeHash?: string;
  afterHash?: string;
  createdAt: number;
}

export interface NewStepFileSnapshot {
  sessionId: Id;
  runId: Id;
  stepIndex: number;
  checkpointSeq: number;
  toolExecutionId: Id;
  toolCallId: string;
  toolName: string;
  filePath: string;
  changeType: FileChangeType;
  existedBefore: boolean;
  beforeContentB64?: string | null;
  beforeHash?: string | null;
  afterHash?: string | null;
}

export interface SessionStore {
  // Session
  createSession(input: NewSession): Promise<Session>;
  getSession(id: Id): Promise<Session | null>;
  listSessions(limit?: number): Promise<Session[]>;
  updateSessionConfig(sessionId: Id, config: SessionConfig): Promise<Session>;
  forkSession(sessionId: Id, opts?: ForkSessionOptions): Promise<Session>;
  listSessionBranches(sessionId: Id): Promise<Session[]>;
  saveFileSnapshot(input: NewStepFileSnapshot): Promise<StepFileSnapshot>;
  listFileSnapshots(sessionId: Id, opts?: { afterSeq?: number; runId?: Id }): Promise<StepFileSnapshot[]>;
  /**
   * Drop transcript rows after `targetSeq` and any file snapshots whose
   * checkpoint is strictly newer. Refuses while a run is still active.
   */
  revertSessionToSeq(
    sessionId: Id,
    targetSeq: number
  ): Promise<{
    deletedMessages: number;
    invalidatedSummaries: number;
    deletedSnapshots: number;
    deletedEpisodes: number;
    forgottenMemories: number;
  }>;

  // Run Lifecycle
  startRun(input: {
    sessionId: Id;
    userContent: ContentBlock[];
    limits: RunLimits;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<{ run: Run; userMessage: Message }>;

  getRun(id: Id): Promise<Run | null>;
  getActiveRun(sessionId: Id): Promise<Run | null>;

  appendAssistantMessage(
    runId: Id,
    input: {
      stepIndex: number;
      content: ContentBlock[];
      usage: TokenUsage;
      model: string;
      elapsedMs: number;
    }
  ): Promise<Message>;

  beginToolExecution(input: BeginToolExecution): Promise<{ execution: ToolExecutionRecord; existing: boolean }>;

  completeToolExecution(executionId: Id, result: ToolResult, stepIndex: number): Promise<Message>;

  appendSyntheticToolResult(
    runId: Id,
    toolCallId: string,
    toolName: string,
    content: string,
    stepIndex: number
  ): Promise<void>;

  appendRunMessage(input: { runId: Id; content: ContentBlock[] }): Promise<Message>;

  markAwaitingApproval(executionId: Id, preconditionHash: string): Promise<ToolExecutionRecord>;

  setApprovalDecision(executionId: Id, decision: 'approve' | 'deny'): Promise<ToolExecutionRecord>;

  markToolClosed(executionId: Id, status: 'cancelled' | 'failed' | 'unknown', errorCode: string): Promise<void>;

  suspendForInput(runId: Id, pending: PendingInput, elapsedMs: number): Promise<Run>;

  resumeFromInput(runId: Id, leaseOwner: string, leaseMs: number): Promise<Run>;

  abortOpenWait(runId: Id, input: {
    status: 'cancelled' | 'interrupted';
    stopReason: StopReason;
    message: string;
    resolveToolsAs: 'cancelled' | 'recovery';
  }): Promise<Run>;

  enqueueTurnMessage(input: {
    sessionId: Id;
    kind: 'steer' | 'follow_up';
    content: ContentBlock[];
  }): Promise<QueuedTurnMessage>;

  takeQueuedMessages(sessionId: Id, kind?: 'steer' | 'follow_up'): Promise<QueuedTurnMessage[]>;

  listWaitingRuns(): Promise<Run[]>;

  requestCancel(runId: Id): Promise<Run>;

  finishRun(
    runId: Id,
    input: {
      status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
      stopReason: StopReason;
      error?: RuntimeErrorInfo;
      elapsedMs: number;
    }
  ): Promise<Run>;

  heartbeat(runId: Id, leaseOwner: string, leaseMs: number): Promise<void>;

  nextStepIndex(runId: Id): Promise<number>;

  // Messages
  listMessages(sessionId: Id, range?: { fromSeq?: number; toSeq?: number; includeExcluded?: boolean }): Promise<Message[]>;
  listRecentMessages(sessionId: Id, opts: { afterSeq?: number; limit: number }): Promise<Message[]>;
  excludeMessages(sessionId: Id, seqs: number[], reason: string): Promise<void>;

  // Summaries
  getActiveSummary(sessionId: Id): Promise<Summary | null>;
  saveSummary(input: NewSummary): Promise<Summary>;

  // Long-Term Memories and episodic index
  insertMemory(input: NewMemory): Promise<MemoryRecord>;
  queryMemories(q: MemoryRecallQuery): Promise<MemoryRecord[]>;
  correctMemory(id: Id, input: { content: string; reason: string; by: string }): Promise<MemoryRecord>;
  forgetMemory(id: Id, input: { reason: string; by: string }): Promise<void>;
  getMemoryHistory(id: Id): Promise<MemoryRecord[]>;
  touchMemories(ids: Id[]): Promise<void>;
  saveEpisode(input: NewEpisode): Promise<Episode>;
  listEpisodes(sessionId: Id): Promise<Episode[]>;

  // Events & Crash Recovery
  appendEvent(e: { runId: Id; sessionId: Id; type: string; payload: unknown }): Promise<PersistedEvent>;
  listEvents(runId: Id, afterId?: number): Promise<PersistedEvent[]>;
  listToolExecutions(runId: Id): Promise<ToolExecutionRecord[]>;
  findRunsNeedingRecovery(now: number): Promise<Run[]>;
  listOpenToolExecutions(runId: Id): Promise<ToolExecutionRecord[]>;
  markInterrupted(runId: Id, resolutions: ToolResolution[]): Promise<Run>;
}
