import type { ContextMessage, ModelToolSpec } from '../model/ports.js';
import type { Id, Message, Session } from '../core/types.js';

export interface ContextBudget {
  maxInputTokens: number;
  reserveForOutput: number;
}

/**
 * Four planes. The transcript is the only source of truth.
 * - Working summary: one active fold of older turns, injected for continuity.
 * - Episodes: one derived index row per compacted span. Recalled by overlap.
 *   They never replace the messages they describe.
 * - Semantic facts: scoped, sourced, correctable memories with dedup keys.
 */
export interface ContextManifest {
  summaryId: Id | null;
  summaryRange: [number, number] | null;
  /** Sequence range actually sent to the model, not the full listed transcript. */
  messageSeqRange: [number, number] | null;
  memoryIds: Id[];
  episodeIds: Id[];
  droppedMessageCount: number;
}

export interface BuiltContext {
  system: string;
  messages: ContextMessage[];
  manifest: ContextManifest;
  estimatedTokens: number;
}

export type MemoryScope = 'session' | 'user' | 'agent' | 'global';

export interface MemoryRecord {
  id: Id;
  scopeType: MemoryScope;
  scopeId: string;
  kind: string;
  content: string;
  sourceType: 'message' | 'tool_result' | 'user_explicit' | 'system';
  sourceRef?: string;
  sourceSessionId?: string;
  confidence: number;
  /** 0..1 importance. Rises when the fact is reinforced or injected. */
  salience: number;
  pinned: boolean;
  contentKey?: string;
  accessCount: number;
  lastAccessedAt?: number;
  tags: string[];
  status: 'active' | 'corrected' | 'deleted';
  supersedesId?: string;
  statusReason?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface NewMemory {
  scopeType: MemoryScope;
  scopeId: string;
  kind: string;
  content: string;
  sourceType: 'message' | 'tool_result' | 'user_explicit' | 'system';
  sourceRef?: string;
  sourceSessionId?: string;
  confidence?: number;
  salience?: number;
  pinned?: boolean;
  contentKey?: string;
  tags?: string[];
  createdBy: string;
  /** Transcript time of the fact. Defaults to the insert time. */
  createdAt?: number;
}

export interface ScopeBinding {
  scopeType: MemoryScope;
  scopeId: string;
}

export interface MemoryRecallQuery {
  scopes: MemoryScope[];
  /** Legacy: one id applied to every requested scope. */
  scopeId?: string;
  /** Preferred: each scope carries its own id, so user facts cannot cross users. */
  bindings?: ScopeBinding[];
  query?: string;
  limit: number;
}

export interface LongTermMemory {
  remember(input: NewMemory): Promise<MemoryRecord>;
  recall(q: MemoryRecallQuery): Promise<MemoryRecord[]>;
  correct(id: Id, input: { content: string; reason: string; by: string }): Promise<MemoryRecord>;
  forget(id: Id, input: { reason: string; by: string }): Promise<void>;
  history(id: Id): Promise<MemoryRecord[]>;
}

export interface Summarizer {
  summarize(
    input: { previousSummary?: string; messages: Message[] },
    signal: AbortSignal
  ): Promise<{ content: string; model: string; promptVersion: string }>;
}

export interface MemoryManager {
  buildContext(input: {
    session: Session;
    runId: Id;
    systemPrompt: string;
    tools: ModelToolSpec[];
    budget: ContextBudget;
  }): Promise<BuiltContext>;

  maintain(sessionId: Id, signal: AbortSignal): Promise<{ summaryCreated?: Id }>;

  readonly longTerm: LongTermMemory;
}
