import type { ContentBlock, TokenUsage } from '../core/types.js';

export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ContextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ContextMessage[];
  tools: ModelToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
}

export type ModelFinishReason = 'stop' | 'tool_use' | 'max_tokens' | 'content_filter' | 'other';

export interface ModelResponse {
  content: ContentBlock[];
  finishReason: ModelFinishReason;
  usage: TokenUsage;
  model: string;
  providerRequestId?: string;
}

export type ModelDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      toolCallId?: string;
      toolName?: string;
      argsDelta?: string;
      argsText?: string;
    };

export interface ModelCallOptions {
  signal: AbortSignal;
  onDelta?: (d: ModelDelta) => void;
}

export type ModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'context_overflow'
  | 'invalid_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'malformed_response';

export class ModelError extends Error {
  constructor(
    public readonly kind: ModelErrorKind,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ModelError';
  }
}

export interface ModelAdapter {
  readonly providerId: string;
  readonly capabilities: {
    toolCalling: boolean;
    streaming: boolean;
    contextWindow: number;
  };
  generate(req: ModelRequest, opts: ModelCallOptions): Promise<ModelResponse>;
  countTokens?(req: ModelRequest): Promise<number>;
}
