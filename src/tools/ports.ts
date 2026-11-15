import type { Id, Principal } from '../core/types.js';

export type SideEffect = 'none' | 'idempotent' | 'non_idempotent';

export interface ToolContext {
  sessionId: Id;
  runId: Id;
  toolCallId: string;
  toolExecutionId: Id;
  idempotencyKey: string;
  signal: AbortSignal;
  principal: Principal;
  logger: {
    debug(msg: string, extra?: unknown): void;
    info(msg: string, extra?: unknown): void;
    warn(msg: string, extra?: unknown): void;
    error(msg: string, extra?: unknown): void;
  };
  // 撤销/补偿钩子注册 (Saga)
  registerUndo?: (undoFn: () => Promise<void>) => void;
}

export interface ToolOutput {
  content: string; // 回传给模型的安全视口
  data?: unknown;  // 结构化数据
  isError?: boolean;
  fatal?: boolean;
  // 前置状态指纹（文件 mtime、哈希等），用于 HITL 防漂移
  preconditionHash?: string;
}

export interface ToolDefinition<A = any> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: SideEffect;
  requiredPermissions: string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  execute(args: A, ctx: ToolContext): Promise<ToolOutput>;
  // 可选：反向补偿能力 (Saga Rollback)
  rollback?(snapshot: unknown, ctx: ToolContext): Promise<void>;
}

export interface RegisteredTool {
  def: ToolDefinition;
  validate: (args: unknown) => { valid: boolean; errors?: string[] };
}

export interface ToolRegistry {
  register(def: ToolDefinition): void;
  get(name: string): RegisteredTool | undefined;
  list(filter?: { names?: string[] }): RegisteredTool[];
  toModelSpecs(names?: string[]): { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGS'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'EXECUTION_ERROR'
  | 'TOOL_REPORTED_ERROR'
  | 'CANCELLED'
  | 'PRECONDITION_FAILED'
  | 'OUTCOME_UNKNOWN';

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  status: 'success' | 'error' | 'awaiting_approval';
  content: string;
  data?: unknown;
  error?: {
    code: ToolErrorCode;
    message: string;
    retryable: boolean;
  };
  fatal?: boolean;
  durationMs: number;
  fromCache?: boolean;
  preconditionHash?: string;
}

export interface ToolCallRequest {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ExecutionScope {
  sessionId: Id;
  runId: Id;
  toolExecutionId: Id;
  idempotencyKey: string;
  principal: Principal;
  signal: AbortSignal;
  /** User already approved this call. Skip the ask decision and run the tool. */
  approvalGranted?: boolean;
}

export interface PermissionPolicy {
  check(input: {
    tool: ToolDefinition;
    args: unknown;
    principal: Principal;
    sessionId: Id;
  }): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string }>;
}

export interface ToolExecutor {
  execute(call: ToolCallRequest, scope: ExecutionScope): Promise<ToolResult>;
}
