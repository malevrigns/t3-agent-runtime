import type { Id, PendingInput, Role, RunStatus, RuntimeErrorInfo, StopReason, TokenUsage } from '../core/types.js';
import type { ContextManifest } from '../memory/ports.js';

export type RunEvent =
  | { type: 'run_started'; runId: Id; sessionId: Id }
  | { type: 'step_started'; runId: Id; stepIndex: number }
  | { type: 'context_built'; runId: Id; stepIndex: number; manifest: ContextManifest; estimatedTokens: number }
  | { type: 'model_call_started'; runId: Id; stepIndex: number }
  | { type: 'model_reasoning_delta'; runId: Id; stepIndex: number; text: string } // 临时思考流式事件，不落库
  | { type: 'model_delta'; runId: Id; stepIndex: number; text: string } // 临时流式事件，不落库
  | { type: 'model_call_finished'; runId: Id; stepIndex: number; usage: TokenUsage; finishReason: string }
  | { type: 'model_call_failed'; runId: Id; stepIndex: number; error: RuntimeErrorInfo }
  | { type: 'message_appended'; runId: Id; messageId: Id; seq: number; role: Role }
  | {
      type: 'tool_speculative_prefetched';
      runId: Id;
      stepIndex: number;
      toolCallId: string;
      toolName: string;
      source?: 'tool_call_delta' | 'reasoning_intent';
    }
  | { type: 'tool_execution_started'; runId: Id; toolExecutionId: Id; toolCallId: string; toolName: string }
  | {
      type: 'tool_execution_finished';
      runId: Id;
      toolExecutionId: Id;
      toolCallId: string;
      status: string;
      errorCode?: string;
      durationMs: number;
      fromCache?: boolean;
      speculativeHit?: boolean;
      speculativeSource?: 'tool_call_delta' | 'reasoning_intent';
      savedMs?: number;
    }
  | { type: 'run_waiting_input'; runId: Id; pending: PendingInput }
  | { type: 'run_resumed'; runId: Id }
  | { type: 'run_cancel_requested'; runId: Id }
  | { type: 'run_interrupted'; runId: Id }
  | {
      type: 'run_finished';
      runId: Id;
      status: RunStatus;
      stopReason: StopReason;
      usage: TokenUsage;
      speculativeStats?: {
        hits: number;
        reasoningHits: number;
        toolDeltaHits: number;
        savedMs: number;
      };
    };

export interface EventBus {
  publish(e: RunEvent): void;
  subscribe(filter: { runId?: Id; sessionId?: Id }, fn: (e: RunEvent) => void): () => void;
  registerRunSession?(runId: Id, sessionId: Id): void;
}
