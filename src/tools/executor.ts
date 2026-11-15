import type {
  ExecutionScope,
  PermissionPolicy,
  ToolCallRequest,
  ToolContext,
  ToolExecutor,
  ToolResult,
  ToolRegistry,
} from './ports.js';

export class StandardToolExecutor implements ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private permissionPolicy: PermissionPolicy,
    private defaultTimeoutMs: number = 30_000
  ) {}

  async execute(call: ToolCallRequest, scope: ExecutionScope): Promise<ToolResult> {
    const startedAt = Date.now();
    const registered = this.registry.get(call.toolName);

    // 1. 查找工具
    if (!registered) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: 'error',
        content: `Error: Tool '${call.toolName}' not found.`,
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Tool '${call.toolName}' is not registered`,
          retryable: false,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    const { def, validate } = registered;

    // 2. 参数 Schema 校验
    const validation = validate(call.args);
    if (!validation.valid) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: 'error',
        content: `Error: Invalid arguments for '${call.toolName}': ${validation.errors?.join(', ')}`,
        error: {
          code: 'INVALID_ARGS',
          message: validation.errors?.join('; ') ?? 'Invalid args',
          retryable: true,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    // 3. 权限判断
    const perm = await this.permissionPolicy.check({
      tool: def,
      args: call.args,
      principal: scope.principal,
      sessionId: scope.sessionId,
    });

    if (perm.decision === 'deny') {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: 'error',
        content: `Error: Permission denied for '${call.toolName}': ${perm.reason}`,
        error: {
          code: 'PERMISSION_DENIED',
          message: perm.reason,
          retryable: false,
        },
        durationMs: Date.now() - startedAt,
      };
    }

    if (perm.decision === 'ask' && !scope.approvalGranted) {
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: 'awaiting_approval',
        content: perm.reason,
        durationMs: Date.now() - startedAt,
      };
    }

    // 4. 超时控制与执行
    const timeoutMs = def.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([scope.signal, timeoutSignal]);

    const ctx: ToolContext = {
      sessionId: scope.sessionId,
      runId: scope.runId,
      toolCallId: call.toolCallId,
      toolExecutionId: scope.toolExecutionId,
      idempotencyKey: scope.idempotencyKey,
      signal: combinedSignal,
      principal: scope.principal,
      logger: console,
    };

    try {
      if (scope.signal.aborted) {
        return {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          status: 'error',
          content: 'Error: Tool execution cancelled.',
          error: { code: 'CANCELLED', message: 'Cancelled by user or run abort', retryable: false },
          durationMs: Date.now() - startedAt,
        };
      }

      // 执行工具
      const output = await def.execute(call.args, ctx);

      // 安全截断
      const maxChars = def.maxOutputChars ?? 20_000;
      let safeContent = output.content;
      if (safeContent.length > maxChars) {
        const head = safeContent.slice(0, Math.floor(maxChars * 0.7));
        const tail = safeContent.slice(-Math.floor(maxChars * 0.3));
        safeContent = `${head}\n... [Truncated ${safeContent.length - maxChars} chars] ...\n${tail}`;
      }

      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: output.isError ? 'error' : 'success',
        content: safeContent,
        data: output.data,
        fatal: output.fatal,
        preconditionHash: output.preconditionHash,
        error: output.isError
          ? { code: 'TOOL_REPORTED_ERROR', message: safeContent, retryable: true }
          : undefined,
        durationMs: Date.now() - startedAt,
      };
    } catch (err: any) {
      if (timeoutSignal.aborted) {
        return {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          status: 'error',
          content: `Error: Tool '${call.toolName}' timed out after ${timeoutMs}ms.`,
          error: { code: 'TIMEOUT', message: 'Execution timed out', retryable: true },
          durationMs: Date.now() - startedAt,
        };
      }

      if (scope.signal.aborted) {
        return {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          status: 'error',
          content: `Error: Tool '${call.toolName}' was cancelled.`,
          error: { code: 'CANCELLED', message: 'Cancelled by signal', retryable: false },
          durationMs: Date.now() - startedAt,
        };
      }

      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        status: 'error',
        content: `Error executing '${call.toolName}': ${err.message || String(err)}`,
        error: { code: 'EXECUTION_ERROR', message: err.message || 'Execution failed', retryable: true },
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
