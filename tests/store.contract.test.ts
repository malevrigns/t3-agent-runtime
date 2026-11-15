import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { SessionBusyError } from '../src/core/errors.js';
import { DEFAULT_RUN_LIMITS } from '../src/core/types.js';

test('SqliteSessionStore - Session and Run Lifecycle Contract', async (t) => {
  const store = new SqliteSessionStore(':memory:');

  await t.test('create and retrieve session', async () => {
    const session = await store.createSession({
      title: 'Test Session',
      config: {
        model: 'test-model',
        systemPrompt: 'You are a test bot',
        maxOutputTokens: 1000,
      },
    });

    assert.ok(session.id);
    assert.equal(session.title, 'Test Session');
    assert.equal(session.nextSeq, 1);

    const fetched = await store.getSession(session.id);
    assert.ok(fetched);
    assert.equal(fetched.id, session.id);
    assert.equal(fetched.config.model, 'test-model');
  });

  await t.test('single active run constraint & session busy', async () => {
    const session = await store.createSession({
      config: {
        model: 'test-model',
        systemPrompt: 'Test',
        maxOutputTokens: 1000,
      },
    });

    const { run: run1, userMessage } = await store.startRun({
      sessionId: session.id,
      userContent: [{ type: 'text', text: 'Hello' }],
      limits: DEFAULT_RUN_LIMITS,
      leaseOwner: 'worker-1',
      leaseMs: 5000,
    });

    assert.equal(run1.status, 'running');
    assert.equal(userMessage.seq, 1);
    assert.equal(userMessage.role, 'user');

    // 并发启动同一个 session 应该被锁阻止抛出 SessionBusyError
    await assert.rejects(
      async () => {
        await store.startRun({
          sessionId: session.id,
          userContent: [{ type: 'text', text: 'Hello again' }],
          limits: DEFAULT_RUN_LIMITS,
          leaseOwner: 'worker-2',
          leaseMs: 5000,
        });
      },
      (err: any) => err instanceof SessionBusyError
    );

    // 正常完成 run1 之后，才可以启动新的 run
    await store.finishRun(run1.id, {
      status: 'completed',
      stopReason: 'completed',
      elapsedMs: 120,
    });

    const { run: run2 } = await store.startRun({
      sessionId: session.id,
      userContent: [{ type: 'text', text: 'Second query' }],
      limits: DEFAULT_RUN_LIMITS,
      leaseOwner: 'worker-1',
      leaseMs: 5000,
    });

    assert.equal(run2.status, 'running');
    assert.notEqual(run2.id, run1.id);
  });

  await t.test('idempotent tool execution flow', async () => {
    const session = await store.createSession({
      config: { model: 'm', systemPrompt: 's', maxOutputTokens: 100 },
    });
    const { run } = await store.startRun({
      sessionId: session.id,
      userContent: [{ type: 'text', text: 'Run tool' }],
      limits: DEFAULT_RUN_LIMITS,
      leaseOwner: 'w1',
      leaseMs: 5000,
    });

    const key = 'idem_key_123';
    // 1. 开始工具执行
    const { execution: exec1, existing: exist1 } = await store.beginToolExecution({
      runId: run.id,
      sessionId: session.id,
      toolCallId: 'call_1',
      toolName: 'read_file',
      args: { path: 'a.txt' },
      sideEffect: 'none',
      idempotencyKey: key,
    });

    assert.equal(exist1, false);
    assert.equal(exec1.status, 'running');

    // 2. 重复调用相同幂等键，应返回已存在的记录
    const { execution: exec2, existing: exist2 } = await store.beginToolExecution({
      runId: run.id,
      sessionId: session.id,
      toolCallId: 'call_1_retry',
      toolName: 'read_file',
      args: { path: 'a.txt' },
      sideEffect: 'none',
      idempotencyKey: key,
    });

    assert.equal(exist2, true);
    assert.equal(exec2.id, exec1.id);

    // 3. 完成工具执行
    const toolMsg = await store.completeToolExecution(
      exec1.id,
      {
        toolCallId: 'call_1',
        toolName: 'read_file',
        status: 'success',
        content: 'file contents',
        durationMs: 15,
      },
      1
    );

    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.seq, 2);
  });

  store.close();
});
