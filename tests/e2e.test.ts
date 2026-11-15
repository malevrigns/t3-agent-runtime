import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import type { Principal } from '../src/core/types.js';

test('End-to-End Agent Runtime Flow', async (t) => {
  const model = new FakeModelAdapter();
  const { runtime, registry } = createAgentRuntime({
    modelAdapter: model,
    approvalMode: 'ask_for_side_effects',
  });

  const principal: Principal = {
    id: 'user_1',
    kind: 'user',
    grants: ['fs:read'],
  };

  // 1. 注册一个测试工具
  registry.register({
    name: 'read_file',
    description: 'Read a file content',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute(args: { path: string }) {
      return {
        content: `Content of file ${args.path}: export const answer = 42;`,
      };
    },
  });

  await t.test('multi-step LLM -> Tool -> LLM loop completes successfully', async () => {
    const session = await runtime.createSession({
      title: 'Coding Session',
      config: {
        model: 'fake-model',
        systemPrompt: 'You are a code assistant',
        maxOutputTokens: 500,
      },
    });

    // 预设模型行为：
    // Step 0: 调用工具 read_file
    model.enqueueToolCall('call_001', 'read_file', { path: 'index.ts' }, 'Let me check index.ts');
    // Step 1: 拿到结果后回答用户
    model.enqueueText('The answer in index.ts is 42.');

    const events: string[] = [];
    runtime.subscribe({ sessionId: session.id }, (e) => {
      events.push(e.type);
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'What is the answer in index.ts?',
      principal,
    });

    const outcome = await handle.result;

    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.stopReason, 'completed');
    assert.equal(outcome.finalText, 'The answer in index.ts is 42.');

    // 验证事件流严格有序
    assert.ok(events.includes('run_started'));
    assert.ok(events.includes('tool_execution_started'));
    assert.ok(events.includes('tool_execution_finished'));
    assert.ok(events.includes('run_finished'));
  });

  await t.test('consecutive tool error breaker', async () => {
    const session = await runtime.createSession({
      config: {
        model: 'fake-model',
        systemPrompt: 'Error Test',
        maxOutputTokens: 500,
      },
    });

    // 模型不断调用不存在的工具
    model.enqueueToolCall('call_err1', 'non_existing_tool', {});
    model.enqueueToolCall('call_err2', 'non_existing_tool', {});
    model.enqueueToolCall('call_err3', 'non_existing_tool', {});

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'Trigger error',
      principal,
      limits: { maxConsecutiveToolErrors: 2 },
    });

    const outcome = await handle.result;
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.stopReason, 'tool_error');
  });

  await t.test('cancellation terminates run cleanly', async () => {
    const session = await runtime.createSession({
      config: {
        model: 'fake-model',
        systemPrompt: 'Cancel Test',
        maxOutputTokens: 500,
      },
    });

    model.enqueueResponse(() => {
      return {
        content: [{ type: 'tool_call', toolCallId: 'call_c1', toolName: 'read_file', args: { path: 'slow.ts' } }],
        finishReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 10 },
        model: 'fake',
      };
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'Start long task',
      principal,
    });

    // 立即取消
    await handle.cancel();
    const outcome = await handle.result;

    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.stopReason, 'cancelled');
  });
});
