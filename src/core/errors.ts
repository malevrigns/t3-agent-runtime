/**
 * Core Domain Errors
 */

export class DomainError extends Error {
  constructor(message: string, public readonly code: string, public readonly details?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class SessionBusyError extends DomainError {
  constructor(public readonly sessionId: string, public readonly activeRunId: string) {
    super(`Session ${sessionId} already has an active run ${activeRunId}`, 'SESSION_BUSY', { sessionId, activeRunId });
  }
}

export class InvalidRunStateError extends DomainError {
  constructor(public readonly runId: string, public readonly currentStatus: string, public readonly targetStatus: string) {
    super(`Invalid run state transition from ${currentStatus} to ${targetStatus} for run ${runId}`, 'INVALID_RUN_STATE', { runId, currentStatus, targetStatus });
  }
}

export class ConcurrentModificationError extends DomainError {
  constructor(public readonly entity: string, public readonly id: string) {
    super(`Concurrent modification detected on ${entity}:${id}`, 'CONCURRENT_MODIFICATION', { entity, id });
  }
}

export class InfrastructureError extends DomainError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message, 'INFRASTRUCTURE_ERROR', { cause: String(cause) });
  }
}

export class ContextOverflowError extends DomainError {
  constructor(message: string) {
    super(message, 'CONTEXT_OVERFLOW');
  }
}
