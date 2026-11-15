import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { StandardMemoryManager } from '../src/memory/memory-manager.js';
import { DEFAULT_RUN_LIMITS, type ContentBlock } from '../src/core/types.js';

function estimateContent(content: unknown): number {
  return Math.ceil(JSON.stringify(content).length / 3);
}

function estimateSystem(systemPrompt: string): number {
  return Math.ceil(systemPrompt.length / 3);
}

function toolIds(messages: Array<{ content: ContentBlock[] }>, type: 'tool_call' | 'tool_result'): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === type) ids.push(block.toolCallId);
    }
  }
  return ids;
}

function assertToolPairs(messages: Array<{ role: string; content: ContentBlock[] }>): void {
  const calls = toolIds(messages, 'tool_call');
  const results = toolIds(messages, 'tool_result');
  assert.deepEqual([...calls].sort(), [...results].sort());
  const seen = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        assert.ok(seen.has(block.toolCallId), `tool_result ${block.toolCallId} has no preceding tool_call`);
      }
    }
    for (const block of message.content) {
      if (block.type === 'tool_call') seen.add(block.toolCallId);
    }
  }
  if (messages.length > 0) assert.notEqual(messages[0].role, 'tool');
}

async function userTurn(store: SqliteSessionStore, sessionId: string, text: string) {
  const { run, userMessage } = await store.startRun({
    sessionId,
    userContent: [{ type: 'text', text }],
    limits: DEFAULT_RUN_LIMITS,
    leaseOwner: 'memory-test',
    leaseMs: 60_000,
  });
  return { run, userMessage };
}

async function appendToolPair(
  store: SqliteSessionStore,
  sessionId: string,
  runId: string,
  calls: Array<{ id: string; name: string; result: string }>,
  text?: string
): Promise<void> {
  const content: ContentBlock[] = [];
  if (text) content.push({ type: 'text', text });
  for (const call of calls) {
    content.push({ type: 'tool_call', toolCallId: call.id, toolName: call.name, args: {} });
  }
  await store.appendAssistantMessage(runId, {
    stepIndex: 1,
    content,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'm',
    elapsedMs: 1,
  });
  for (const call of calls) {
    const { execution } = await store.beginToolExecution({
      runId,
      sessionId,
      toolCallId: call.id,
      toolName: call.name,
      args: {},
      sideEffect: 'none',
      idempotencyKey: `${runId}:${call.id}`,
    });
    await store.completeToolExecution(
      execution.id,
      {
        toolCallId: call.id,
        toolName: call.name,
        status: 'success',
        content: call.result,
        durationMs: 1,
      },
      1
    );
  }
}

async function finish(store: SqliteSessionStore, runId: string): Promise<void> {
  await store.finishRun(runId, {
    status: 'completed',
    stopReason: 'completed',
    elapsedMs: 1,
  });
}

test('memory compaction', async (t) => {
  await t.test('does not write a summary when the transcript is inside the budget', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: {
          model: 'm',
          systemPrompt: 'You are a test bot',
          maxOutputTokens: 200,
        },
      });
      const { run } = await userTurn(store, session.id, 'hello');
      await store.appendAssistantMessage(run.id, {
        stepIndex: 1,
        content: [{ type: 'text', text: 'hi' }],
        usage: { inputTokens: 5_000_000, outputTokens: 5_000_000 },
        model: 'm',
        elapsedMs: 1,
      });
      await finish(store, run.id);

      const memory = new StandardMemoryManager(store);
      const first = await memory.maintain(session.id, new AbortController().signal);
      assert.deepEqual(first, {});
      assert.equal(await store.getActiveSummary(session.id), null);

      const messages = await store.listMessages(session.id);
      const built = await memory.buildContext({
        session,
        runId: run.id,
        systemPrompt: session.config.systemPrompt,
        tools: [],
        budget: { maxInputTokens: 128_000, reserveForOutput: 1024 },
      });
      assert.equal(built.messages.length, messages.length);
      assert.equal(built.manifest.droppedMessageCount, 0);
    } finally {
      store.close();
    }
  });

  await t.test('writes one active summary over budget and skips a second maintain', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const systemPrompt = 'You are a test bot';
      let session = await store.createSession({
        config: { model: 'm', systemPrompt, maxOutputTokens: 200 },
      });
      const goal = 'Ship the compaction feature';
      const { run } = await userTurn(store, session.id, `${goal}\n${'x'.repeat(4000)}`);
      const resultHead = 'READ_RESULT_HEAD_';
      const resultTail = 'READ_RESULT_TAIL_EXCLUDED';
      const readResult = resultHead + 'a'.repeat(600) + resultTail;
      await appendToolPair(
        store,
        session.id,
        run.id,
        [
          { id: 'call_read', name: 'read_file', result: readResult },
          { id: 'call_list', name: 'list_dir', result: 'src' },
        ],
        'Inspect the repository before editing.'
      );
      await finish(store, run.id);
      const followUp = await userTurn(store, session.id, 'Please continue with the short follow-up');
      await finish(store, followUp.run.id);

      const messages = await store.listMessages(session.id);
      const last = messages[messages.length - 1];
      const systemTokens = estimateSystem(systemPrompt);
      const lastTokens = estimateContent(last.content);
      const reserveTokens = 100;
      const contextWindow = systemTokens + lastTokens + reserveTokens + 50;
      session = await store.updateSessionConfig(session.id, {
        ...session.config,
        contextWindow,
        compaction: { reserveTokens, keepRecentTokens: lastTokens },
      });

      const memory = new StandardMemoryManager(store);
      const signal = new AbortController().signal;
      const created = await memory.maintain(session.id, signal);
      const summary = await store.getActiveSummary(session.id);
      assert.ok(created.summaryCreated);
      assert.ok(summary);
      assert.equal(summary.id, created.summaryCreated);
      assert.equal(summary.model, 'extractive');
      assert.equal(summary.promptVersion, 'extractive-v1');
      assert.equal(summary.supersedesId, undefined);
      assert.match(summary.content, /^Goal\n/);
      assert.ok(summary.content.includes('\nProgress\n'));
      assert.ok(summary.content.includes('\nKey Decisions\n'));
      assert.ok(summary.content.includes('\nNext Steps\n'));
      assert.ok(summary.content.includes(goal));
      assert.ok(summary.content.includes('read_file'));
      assert.ok(summary.content.includes('list_dir'));
      assert.ok(summary.content.includes(resultHead));
      assert.equal(summary.content.includes(resultTail), false);
      assert.ok(summary.content.includes('Inspect the repository before editing.'));

      const kept = await store.listMessages(session.id, { fromSeq: summary.toSeq + 1 });
      const summarized = messages.filter((message) => message.seq >= summary.fromSeq && message.seq <= summary.toSeq);
      assert.ok(summarized.length > 0);
      assert.ok(kept.length > 0);
      assert.equal(kept[0].role === 'tool', false);
      assertToolPairs(summarized);
      assertToolPairs(kept);
      assert.equal(summarized.some((message) => toolIds([message], 'tool_call').includes('call_read')), true);
      assert.equal(kept.some((message) => toolIds([message], 'tool_call').includes('call_read')), false);

      const afterTokens =
        estimateSystem(systemPrompt) + kept.reduce((sum, message) => sum + estimateContent(message.content), 0);
      assert.ok(afterTokens <= contextWindow - reserveTokens);

      const stored = await store.listMessages(session.id, { includeExcluded: true });
      assert.equal(stored.length, messages.length);
      assert.equal(stored.some((message) => message.excludedFromContext), false);

      const again = await memory.maintain(session.id, signal);
      assert.deepEqual(again, {});
      const still = await store.getActiveSummary(session.id);
      assert.equal(still?.id, summary.id);

      const wave = 'SECOND_WAVE_GOAL';
      const grown = await userTurn(store, session.id, `${wave}\n${'y'.repeat(4000)}`);
      await finish(store, grown.run.id);
      const latest = await userTurn(store, session.id, 'Ok');
      await finish(store, latest.run.id);
      const latestTokens = estimateContent(latest.userMessage.content);
      session = await store.updateSessionConfig(session.id, {
        ...session.config,
        compaction: { reserveTokens, keepRecentTokens: latestTokens },
      });
      const superseded = await memory.maintain(session.id, signal);
      const nextSummary = await store.getActiveSummary(session.id);
      assert.ok(nextSummary);
      assert.equal(superseded.summaryCreated, nextSummary.id);
      assert.notEqual(nextSummary.id, summary.id);
      assert.equal(nextSummary.supersedesId, summary.id);
      assert.ok(nextSummary.content.includes(goal));
      assert.ok(nextSummary.content.includes(wave));
      const quiet = await memory.maintain(session.id, signal);
      assert.deepEqual(quiet, {});
      assert.equal((await store.getActiveSummary(session.id))?.id, nextSummary.id);
    } finally {
      store.close();
    }
  });

  await t.test('returns paired tool calls under a tiny buildContext budget', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const systemPrompt = 'sys';
      const session = await store.createSession({
        config: { model: 'm', systemPrompt, maxOutputTokens: 50 },
      });
      const { run } = await userTurn(store, session.id, `old context ${'z'.repeat(3000)}`);
      await appendToolPair(store, session.id, run.id, [
        { id: 'call_a', name: 'read_file', result: 'alpha contents' },
        { id: 'call_b', name: 'write_file', result: 'beta contents' },
      ]);
      await finish(store, run.id);

      const messages = await store.listMessages(session.id);
      const toolGroup = messages.slice(1);
      const groupTokens = toolGroup.reduce((sum, message) => sum + estimateContent(message.content), 0);
      const overhead = estimateSystem(systemPrompt) + estimateContent([]) + 0;
      const memory = new StandardMemoryManager(store);

      const fitted = await memory.buildContext({
        session,
        runId: run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: overhead + groupTokens, reserveForOutput: 0 },
      });
      assert.equal(fitted.messages.length, toolGroup.length);
      assert.equal(fitted.messages[0].role, 'assistant');
      assert.deepEqual(toolIds(fitted.messages, 'tool_call'), ['call_a', 'call_b']);
      assert.deepEqual(toolIds(fitted.messages, 'tool_result'), ['call_a', 'call_b']);
      assertToolPairs(fitted.messages);
      assert.equal(fitted.messages.some((message) => JSON.stringify(message.content).includes('old context')), false);

      const tooSmall = await memory.buildContext({
        session,
        runId: run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: overhead + 1, reserveForOutput: 0 },
      });
      assert.equal(tooSmall.messages.length, 0);
      assertToolPairs(tooSmall.messages);

      const wide = await memory.buildContext({
        session,
        runId: run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: overhead + messages.reduce((sum, message) => sum + estimateContent(message.content), 0), reserveForOutput: 0 },
      });
      assert.equal(wide.messages.length, messages.length);
      assert.equal(wide.manifest.droppedMessageCount, 0);
    } finally {
      store.close();
    }
  });

  await t.test('skips compaction when disabled or the signal is already aborted', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: {
          model: 'm',
          systemPrompt: 'sys',
          maxOutputTokens: 50,
          contextWindow: 200,
          compaction: { enabled: false, reserveTokens: 10, keepRecentTokens: 20 },
        },
      });
      const { run } = await userTurn(store, session.id, 'q'.repeat(3000));
      await finish(store, run.id);
      const memory = new StandardMemoryManager(store);
      const skipped = await memory.maintain(session.id, new AbortController().signal);
      assert.deepEqual(skipped, {});
      assert.equal(await store.getActiveSummary(session.id), null);

      const enabled = await store.updateSessionConfig(session.id, {
        ...session.config,
        compaction: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 },
      });
      const controller = new AbortController();
      controller.abort();
      const aborted = await memory.maintain(enabled.id, controller.signal);
      assert.deepEqual(aborted, {});
      assert.equal(await store.getActiveSummary(session.id), null);
    } finally {
      store.close();
    }
  });
});
