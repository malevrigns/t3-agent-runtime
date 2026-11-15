import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import { ModelSummarizer, EXTRACTIVE_MODEL } from '../src/memory/summarizer.js';
import { DEFAULT_RUN_LIMITS, type Message, type Principal } from '../src/core/types.js';
import type { ModelAdapter, ModelRequest } from '../src/model/ports.js';

const principal: Principal = {
  id: 'user_mem',
  kind: 'user',
  grants: [],
};

test('long-term memory and ModelSummarizer', async (t) => {
  await t.test('supports remember, recall, correct, forget, and revision history', async () => {
    const model = new FakeModelAdapter();
    const { store, memory } = createAgentRuntime({ modelAdapter: model });

    try {
      const m1 = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: 'User prefers TypeScript strict mode and pnpm workspaces.',
        sourceType: 'user_explicit',
        confidence: 0.9,
        createdBy: 'u_1',
      });

      const m2 = await memory.longTerm.remember({
        scopeType: 'global',
        scopeId: 'global',
        kind: 'convention',
        content: 'Always run npm test before finishing.',
        sourceType: 'system',
        confidence: 0.8,
        createdBy: 'system',
      });

      const recalled = await memory.longTerm.recall({
        scopes: ['user', 'global'],
        query: 'TypeScript strict',
        limit: 5,
      });
      assert.equal(recalled.length, 1);
      assert.equal(recalled[0].id, m1.id);

      const m1v2 = await memory.longTerm.correct(m1.id, {
        content: 'User prefers TypeScript strict mode with NodeNext ESM.',
        reason: 'Clarified module resolution preference',
        by: 'u_1',
      });
      assert.equal(m1v2.supersedesId, m1.id);
      assert.equal(m1v2.status, 'active');

      const afterCorrect = await memory.longTerm.recall({
        scopes: ['user'],
        query: 'TypeScript',
        limit: 5,
      });
      assert.equal(afterCorrect.length, 1);
      assert.equal(afterCorrect[0].id, m1v2.id);
      assert.match(afterCorrect[0].content, /NodeNext ESM/);

      const history = await memory.longTerm.history(m1v2.id);
      assert.equal(history.length, 2);
      assert.equal(history[0].id, m1.id);
      assert.equal(history[0].status, 'corrected');
      assert.equal(history[1].id, m1v2.id);
      assert.equal(history[1].status, 'active');

      await memory.longTerm.forget(m2.id, { reason: 'No longer relevant', by: 'system' });
      const afterForget = await memory.longTerm.recall({
        scopes: ['global'],
        limit: 5,
      });
      assert.equal(afterForget.length, 0);
    } finally {
      store.close();
    }
  });

  await t.test('injects recalled memories into context and isolates session-scoped memories', async () => {
    const model = new FakeModelAdapter();
    const { runtime, store, memory } = createAgentRuntime({ modelAdapter: model });

    try {
      const s1 = await runtime.createSession({
        config: {
          model: 'fake',
          systemPrompt: 'Base system.',
          maxOutputTokens: 200,
          memoryRecall: { enabled: true, limit: 5 },
          memory: { userId: 'u_1' },
        },
      });
      const s2 = await runtime.createSession({
        config: {
          model: 'fake',
          systemPrompt: 'Other system.',
          maxOutputTokens: 200,
          memoryRecall: { enabled: true, limit: 5 },
          memory: { userId: 'u_2' },
        },
      });

      const userMem = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'Deployment target is Windows 11 with Node 24.',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      const s1OnlyMem = await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: s1.id,
        kind: 'note',
        content: 'Session 1 uses Windows deployment port 4100.',
        sourceType: 'system',
        createdBy: 'agent',
      });
      await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: s2.id,
        kind: 'note',
        content: 'Session 2 secret token should not leak to session 1.',
        sourceType: 'system',
        createdBy: 'agent',
      });
      await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_2',
        kind: 'fact',
        content: 'User two private hostname hidden-host.internal.',
        sourceType: 'user_explicit',
        createdBy: 'u_2',
      });

      let capturedSystem = '';
      let manifestMemories: string[] = [];
      runtime.subscribe({ sessionId: s1.id }, (event) => {
        if (event.type === 'context_built') {
          manifestMemories = event.manifest.memoryIds;
        }
      });

      model.enqueueResponse((req: ModelRequest) => {
        capturedSystem = req.system;
        return {
          content: [{ type: 'text', text: 'Confirmed Windows deployment.' }],
          finishReason: 'stop',
          usage: { inputTokens: 15, outputTokens: 8 },
          model: 'fake',
        };
      });

      const handle = await runtime.startRun({
        sessionId: s1.id,
        userInput: 'Check my Windows deployment setup.',
        principal,
      });
      const outcome = await handle.result;
      assert.equal(outcome.status, 'completed');
      assert.match(capturedSystem, /<long_term_memories>/);
      assert.match(capturedSystem, /Node 24/);
      assert.match(capturedSystem, /port 4100/);
      assert.equal(capturedSystem.includes('Session 2 secret token'), false);
      assert.equal(capturedSystem.includes('hidden-host.internal'), false);
      assert.deepEqual(new Set(manifestMemories), new Set([userMem.id, s1OnlyMem.id]));
    } finally {
      store.close();
    }
  });

  await t.test('ModelSummarizer summarizes via ModelAdapter and falls back on model error', async () => {
    const fake = new FakeModelAdapter();
    fake.enqueueText('Goal\nShip feature\n\nProgress\nDone\n\nKey Decisions\nUse SQLite\n\nNext Steps\nAdd tests');

    const summarizer = new ModelSummarizer({
      model: fake,
      modelName: 'summary-model',
    });

    const sampleMessages: Message[] = [
      {
        id: 'm1',
        sessionId: 's1',
        runId: 'r1',
        seq: 1,
        stepIndex: 0,
        role: 'user',
        content: [{ type: 'text', text: 'Please ship feature' }],
        synthetic: false,
        excludedFromContext: false,
        createdAt: Date.now(),
      },
    ];

    const res = await summarizer.summarize({ messages: sampleMessages }, new AbortController().signal);
    assert.equal(res.promptVersion, 'llm-compaction-v1');
    assert.match(res.content, /Use SQLite/);

    const failingModel: ModelAdapter = {
      providerId: 'failing',
      capabilities: { toolCalling: false, streaming: false, contextWindow: 8192 },
      async generate() {
        throw new Error('upstream unavailable');
      },
    };
    const fallbackSummarizer = new ModelSummarizer({
      model: failingModel,
      modelName: 'broken',
    });
    const fallbackRes = await fallbackSummarizer.summarize(
      { messages: sampleMessages },
      new AbortController().signal
    );
    assert.equal(fallbackRes.model, EXTRACTIVE_MODEL);
    assert.match(fallbackRes.content, /Please ship feature/);

    const strictSummarizer = new ModelSummarizer({
      model: failingModel,
      modelName: 'broken',
      fallback: null,
    });
    await assert.rejects(
      strictSummarizer.summarize({ messages: sampleMessages }, new AbortController().signal),
      /upstream unavailable/
    );

    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      summarizer.summarize({ messages: sampleMessages }, aborted.signal),
      (err: Error) => err.name === 'AbortError'
    );
  });
});
