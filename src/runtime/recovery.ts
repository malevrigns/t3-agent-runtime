import type { SessionStore } from '../store/ports.js';
import type { EventBus } from '../events/ports.js';
import type { ToolResolution } from '../store/ports.js';
import type { ContentBlock } from '../core/types.js';

export interface RecoveryReport {
  recoveredRunsCount: number;
  interruptedRunIds: string[];
  resolvedToolsCount: number;
}

export class RecoveryService {
  constructor(private store: SessionStore, private bus: EventBus) {}

  async recover(now: number = Date.now()): Promise<RecoveryReport> {
    const expiredRuns = await this.store.findRunsNeedingRecovery(now);
    const interruptedRunIds: string[] = [];
    let resolvedToolsCount = 0;

    for (const run of expiredRuns) {
      // 1. 获取已经 begin 的 open 工具执行
      const openTools = await this.store.listOpenToolExecutions(run.id);
      const openToolCallIds = new Set(openTools.map((t) => t.toolCallId));
      const resolutions: ToolResolution[] = [];

      for (const tool of openTools) {
        resolvedToolsCount++;
        if (tool.sideEffect === 'non_idempotent') {
          resolutions.push({
            toolExecutionId: tool.id,
            status: 'unknown',
            errorCode: 'OUTCOME_UNKNOWN',
            syntheticMessage: {
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              content:
                'Execution interrupted by system crash. Execution outcome is unknown. Do not re-execute without verification.',
            },
          });
        } else {
          resolutions.push({
            toolExecutionId: tool.id,
            status: 'failed',
            errorCode: 'OUTCOME_UNKNOWN',
            syntheticMessage: {
              toolCallId: tool.toolCallId,
              toolName: tool.toolName,
              content: 'Execution interrupted by system crash. Tool call was safely marked failed.',
            },
          });
        }
      }

      // 1. 先对已经 begin 的工具进行 markInterrupted，落库终态及合成消息
      await this.store.markInterrupted(run.id, resolutions);
      interruptedRunIds.push(run.id);

      // 2. 检查最后一条 assistant 消息中未曾来得及 begin 的工具调用并补齐合成消息
      const messages = await this.store.listMessages(run.sessionId, { includeExcluded: true });
      const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.runId === run.id);
      if (lastAssistant) {
        const toolCalls = lastAssistant.content.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_call' }> => b.type === 'tool_call'
        );
        for (const call of toolCalls) {
          if (!openToolCallIds.has(call.toolCallId)) {
            await this.store.appendSyntheticToolResult(
              run.id,
              call.toolCallId,
              call.toolName,
              'Execution interrupted before tool started.',
              lastAssistant.stepIndex ?? 0
            );
          }
        }
      }

      await this.store.takeQueuedMessages(run.sessionId);
      await this.store.appendEvent({
        runId: run.id,
        sessionId: run.sessionId,
        type: 'run_interrupted',
        payload: { reason: 'System recovered from crash, lease expired' },
      });

      this.bus.publish({
        type: 'run_interrupted',
        runId: run.id,
      });
    }

    return {
      recoveredRunsCount: expiredRuns.length,
      interruptedRunIds,
      resolvedToolsCount,
    };
  }
}
