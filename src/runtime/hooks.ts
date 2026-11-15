import type { Id, Principal, Run, Session } from '../core/types.js';
import type { ModelRequest, ModelResponse } from '../model/ports.js';
import type { ToolCallRequest, ToolResult } from '../tools/ports.js';
import type { RunOutcome } from './agent-loop.js';

export type BeforeToolCallDecision =
  | { action: 'allow'; args?: unknown }
  | { action: 'block'; reason: string };

export interface RuntimeHook {
  readonly name: string;

  beforeModelCall?(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    request: ModelRequest;
  }): Promise<ModelRequest | void> | ModelRequest | void;

  afterModelCall?(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    request: ModelRequest;
    response: ModelResponse;
  }): Promise<void> | void;

  beforeToolCall?(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    call: ToolCallRequest;
    principal: Principal;
  }): Promise<BeforeToolCallDecision | void> | BeforeToolCallDecision | void;

  afterToolCall?(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    call: ToolCallRequest;
    result: ToolResult;
  }): Promise<void> | void;

  onRunFinished?(ctx: {
    sessionId: Id;
    outcome: RunOutcome;
  }): Promise<void> | void;
}
