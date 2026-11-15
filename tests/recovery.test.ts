import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { InMemoryEventBus } from '../src/events/in-memory-event-bus.js';
import { RecoveryService } from '../src/runtime/recovery.js';
import { DEFAULT_RUN_LIMITS } from '../src/core/types.js';

test('Crash Recovery & Lease Expiry Realignment', async (t) => {
  const store = new SqliteSessionStore(':memory:');
  const bus = new InMemoryEventBus();
  const recovery = new RecoveryService(store, bus);

  await t.test('detects lost lease, marks run interrupted, and injects synthetic tool_results', async () => {
    const session = await store.createSession({
      config: { model: 'm', systemPrompt: 's', maxOutputTokens: 100 },
    });

    // 1. 模拟一个 Run，设置 leaseMs = 100ms
    const { run } = await store.startRun({
      sessionId: session.id,
      userContent: [{ type: 'text', text: 'Crash simulation' }],
      limits: DEFAULT_RUN_LIMITS,
      leaseOwner: 'crashed-worker-999',
      leaseMs: 100,
    });

    // 模拟 assistant 产生了两个工具调用，但第二个在被 begin 前进程挂掉
    await store.appendAssistantMessage(run.id, {
      stepIndex: 1,
      content: [
        { type: 'tool_call', toolCallId: 'call_mutate_1', toolName: 'commit_transaction', args: { amount: 100 } },
        { type: 'tool_call', toolCallId: 'call_unbegun_2', toolName: 'send_receipt', args: { to: 'alice' } },
      ],
      usage: { inputTokens: 50, outputTokens: 20 },
      model: 'm',
      elapsedMs: 20,
    });

    // 2. 模拟正在执行第一个非幂等写工具（已写入 tool_executions）
    const { execution: tool1 } = await store.beginToolExecution({
      runId: run.id,
      sessionId: session.id,
      toolCallId: 'call_mutate_1',
      toolName: 'commit_transaction',
      args: { amount: 100 },
      sideEffect: 'non_idempotent',
      idempotencyKey: 'tx_key_001',
    });

    assert.equal(tool1.status, 'running');

    // 3. 模拟进程瞬间挂掉，等待 150ms 超过 lease 过期时间
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 4. 重启系统，执行 Recovery 扫描
    const report = await recovery.recover(Date.now());

    assert.equal(report.recoveredRunsCount, 1);
    assert.equal(report.interruptedRunIds[0], run.id);
    assert.equal(report.resolvedToolsCount, 1);

    // 5. 验证 Run 状态已被正确转换为 interrupted，且原因记录为 crashed
    const recoveredRun = await store.getRun(run.id);
    assert.ok(recoveredRun);
    assert.equal(recoveredRun.status, 'interrupted');
    assert.equal(recoveredRun.stopReason, 'crashed');
    assert.equal(recoveredRun.leaseOwner, null);

    // 6. 验证 tool_executions 的状态被严格钉死在 'unknown'（针对 non_idempotent 工具）
    const openTools = await store.listOpenToolExecutions(run.id);
    assert.equal(openTools.length, 0); // 已经没有悬空工具

    // 7. 验证 messages 表中补齐了全部 tool_result 消息（既包括 begin 过的 call_mutate_1，也包括未及 begin 的 call_unbegun_2）
    const messages = await store.listMessages(session.id);
    const toolResults = messages.filter((m) => m.role === 'tool');
    assert.equal(toolResults.length, 2);

    const res1 = toolResults[0].content[0] as any;
    const res2 = toolResults[1].content[0] as any;

    assert.equal(res1.toolCallId, 'call_mutate_1');
    assert.equal(res1.isError, true);
    assert.match(res1.content, /Execution outcome is unknown/);

    assert.equal(res2.toolCallId, 'call_unbegun_2');
    assert.equal(res2.isError, true);
    assert.match(res2.content, /Execution interrupted before tool started/);

    // 8. 验证 Session 锁已被释放，允许立即开启新 Run
    const { run: newRun } = await store.startRun({
      sessionId: session.id,
      userContent: [{ type: 'text', text: 'I am back after crash' }],
      limits: DEFAULT_RUN_LIMITS,
      leaseOwner: 'new-worker-001',
      leaseMs: 5000,
    });

    assert.equal(newRun.status, 'running');
  });

  store.close();
});
