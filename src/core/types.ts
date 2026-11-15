/**
 * Core Domain Types for Pi-style Agent Runtime
 */

export type Id = string;

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type ImageContentBlock = {
  type: 'image';
  mimeType: string;
  /** Base64 payload without data: prefix */
  data?: string;
  /** External HTTPS URL or data: URI */
  url?: string;
  alt?: string;
  sizeBytes?: number;
};

export type FileContentBlock = {
  type: 'file';
  name: string;
  mimeType: string;
  /** Inline UTF-8 text content for text/code files */
  text?: string;
  /** Base64 payload for binary attachments */
  data?: string;
  path?: string;
  sizeBytes?: number;
};

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: string; // 截断后的安全视图，传给模型
      data?: unknown;  // 结构化原数据（仅持久化或按需检索）
    }
  | ImageContentBlock
  | FileContentBlock;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
}

export interface Message {
  id: Id;
  sessionId: Id;
  runId: Id | null;
  seq: number;
  stepIndex: number | null;
  role: Role;
  content: ContentBlock[];
  usage?: TokenUsage;
  model?: string;
  synthetic: boolean;
  excludedFromContext: boolean;
  exclusionReason?: string;
  createdAt: number;
}

export interface RunLimits {
  maxModelCalls: number;
  maxToolCalls: number;
  tokenBudget: number;
  runTimeoutMs: number;
  modelCallTimeoutMs: number;
  defaultToolTimeoutMs: number;
  maxConsecutiveToolErrors: number;
}

export const DEFAULT_RUN_LIMITS: RunLimits = {
  maxModelCalls: 20,
  maxToolCalls: 50,
  tokenBudget: 200_000,
  runTimeoutMs: 600_000,
  modelCallTimeoutMs: 120_000,
  defaultToolTimeoutMs: 30_000,
  maxConsecutiveToolErrors: 3,
};

export type RunStatus =
  | 'running'
  | 'waiting_input'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type StopReason =
  | 'completed'
  | 'max_model_calls'
  | 'max_tool_calls'
  | 'token_budget_exceeded'
  | 'timeout'
  | 'model_error'
  | 'tool_error'
  | 'cancelled'
  | 'crashed';

export interface RuntimeErrorInfo {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export type PendingInput =
  | {
      kind: 'approval';
      toolExecutionId: Id;
      toolCallId: string;
      toolName: string;
      args: unknown;
      reason: string;
      preconditionHash?: string; // 防漂移前置指纹
    }
  | {
      kind: 'user_answer';
      toolExecutionId: Id;
      toolCallId: string;
      question: string;
    };

export interface Run {
  id: Id;
  sessionId: Id;
  status: RunStatus;
  stopReason: StopReason | null;
  error: RuntimeErrorInfo | null;
  limits: RunLimits;
  modelCalls: number;
  toolCalls: number;
  usage: TokenUsage;
  activeElapsedMs: number;
  pendingInput: PendingInput | null;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  version: number;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface CompactionSettings {
  /** False skips summarization. Default true. */
  enabled?: boolean;
  /** Tokens reserved below the context window before summarization starts. Default 16384. */
  reserveTokens?: number;
  /** Recent transcript tokens kept verbatim. Default 20000. */
  keepRecentTokens?: number;
}

export interface MemoryRecallSettings {
  enabled?: boolean;
  limit?: number;
  scopes?: Array<'session' | 'user' | 'agent' | 'global'>;
}

export interface MemoryIdentity {
  /** User-scoped facts are recalled only for this id. Unset skips the user plane. */
  userId?: string;
  /** Agent-scoped facts are recalled only for this id. Unset skips the agent plane. */
  agentId?: string;
  /** Global scope id. Default "global". */
  globalId?: string;
  /** During compaction, write an episode and extract durable facts. Default true. */
  consolidate?: boolean;
}

export interface SessionConfig {
  model: string;
  systemPrompt: string;
  tools?: string[]; // 白名单，如果不填则全部允许
  maxOutputTokens: number;
  approvalMode?: 'always' | 'ask_for_side_effects' | 'never';
  /** Projection window. Defaults to the model adapter window when a run starts. */
  contextWindow?: number;
  compaction?: CompactionSettings;
  memoryRecall?: MemoryRecallSettings;
  memory?: MemoryIdentity;
}

export interface Session {
  id: Id;
  title?: string;
  config: SessionConfig;
  nextSeq: number;
  status: 'active' | 'archived';
  parentSessionId?: Id;
  forkedFromSeq?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Principal {
  id: string;
  kind: 'user' | 'service';
  grants: string[];
}

export interface NewSession {
  id?: Id;
  title?: string;
  config: SessionConfig;
  parentSessionId?: Id;
}
