import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentRuntime } from '../src/composition.js';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { StandardMemoryManager } from '../src/memory/memory-manager.js';
import { memoryContentKey, scoreText, selectRankedMemories } from '../src/memory/rank.js';
import type { MemoryRecord } from '../src/memory/ports.js';
import { ContextOverflowError, DomainError } from '../src/core/errors.js';
import { DEFAULT_RUN_LIMITS, type ContentBlock, type Principal } from '../src/core/types.js';
import type { ToolContext } from '../src/tools/ports.js';

function estimateContent(content: unknown): number {
  return Math.ceil(JSON.stringify(content).length / 3);
}

function estimateSystem(systemPrompt: string): number {
  return Math.ceil(systemPrompt.length / 3);
}

async function userTurn(store: SqliteSessionStore, sessionId: string, text: string) {
  return store.startRun({
    sessionId,
    userContent: [{ type: 'text', text }],
    limits: DEFAULT_RUN_LIMITS,
    leaseOwner: 'memory-architecture',
    leaseMs: 60_000,
  });
}

async function finish(store: SqliteSessionStore, runId: string): Promise<void> {
  await store.finishRun(runId, { status: 'completed', stopReason: 'completed', elapsedMs: 1 });
}

function toolCtx(sessionId: string, userId: string): ToolContext {
  return {
    sessionId,
    runId: 'run_mem',
    toolCallId: 'call_mem',
    toolExecutionId: 'tex_mem',
    idempotencyKey: `${sessionId}:mem`,
    signal: new AbortController().signal,
    principal: { id: userId, kind: 'user', grants: [] } satisfies Principal,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

test('layered memory architecture', async (t) => {
  await t.test('dedupes identical facts and ranks a pinned fact ahead of a weaker match', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      const first = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: 'User prefers TypeScript.',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      const again = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: 'User prefers TypeScript',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      assert.equal(again.id, first.id);
      assert.ok(again.salience > first.salience);
      assert.ok(again.accessCount >= 1);

      const pinned = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'Zebra habitat atlas stays pinned.',
        sourceType: 'user_explicit',
        pinned: true,
        createdBy: 'u_1',
      });
      await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'Windows port 4100 is the deployment target.',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });

      const recalled = await memory.longTerm.recall({
        scopes: ['user'],
        bindings: [{ scopeType: 'user', scopeId: 'u_1' }],
        query: 'Windows port',
        limit: 4,
      });
      assert.equal(recalled[0]?.id, pinned.id);
      assert.ok(recalled.some((record) => record.content.includes('4100')));
      assert.equal(recalled.some((record) => record.scopeId !== 'u_1'), false);
    } finally {
      store.close();
    }
  });

  await t.test('compaction keeps the transcript, writes an episode, and promotes 记住 facts', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const systemPrompt = 'sys';
      let session = await store.createSession({
        config: {
          model: 'm',
          systemPrompt,
          maxOutputTokens: 50,
          memoryRecall: { enabled: true, limit: 6 },
          memory: { userId: 'u_1' },
        },
      });
      const remembered = '记住 部署端口是 4100';
      const first = await userTurn(store, session.id, `${remembered}\n${'x'.repeat(4000)}`);
      await store.appendAssistantMessage(first.run.id, {
        stepIndex: 1,
        content: [{ type: 'text', text: '收到，端口已记下。' }],
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'm',
        elapsedMs: 1,
      });
      await finish(store, first.run.id);
      const question = await userTurn(store, session.id, '部署端口是多少');
      await finish(store, question.run.id);

      const before = await store.listMessages(session.id);
      const tail = before[before.length - 1]!;
      const tailTokens = estimateContent(tail.content);
      session = await store.updateSessionConfig(session.id, {
        ...session.config,
        contextWindow: estimateSystem(systemPrompt) + tailTokens + 80,
        compaction: { reserveTokens: 20, keepRecentTokens: tailTokens },
      });

      const memory = new StandardMemoryManager(store);
      const created = await memory.maintain(session.id, new AbortController().signal);
      assert.ok(created.summaryCreated);
      const after = await store.listMessages(session.id);
      assert.equal(after.length, before.length);
      assert.equal(after.some((message) => message.content.some((block) => block.type === 'text' && block.text.includes('4100'))), true);

      const episodes = await store.listEpisodes(session.id);
      assert.equal(episodes.length, 1);
      assert.equal(episodes[0]?.summaryId, created.summaryCreated);

      const facts = await memory.longTerm.recall({
        scopes: ['user'],
        bindings: [{ scopeType: 'user', scopeId: 'u_1' }],
        query: '部署端口',
        limit: 5,
      });
      assert.equal(facts.length, 1);
      assert.equal(facts[0]!.scopeType, 'user');
      assert.match(facts[0]!.content, /4100/);
      assert.equal(facts[0]!.sourceRef, `msg:${before[0]!.seq}`);

      const reinforced = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: facts[0]!.content,
        sourceType: 'message',
        sourceRef: facts[0]!.sourceRef,
        sourceSessionId: session.id,
        createdBy: 'u_1',
      });
      assert.equal(reinforced.id, facts[0]!.id);

      const built = await memory.buildContext({
        session,
        runId: question.run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: 8000, reserveForOutput: 100 },
      });
      assert.match(built.system, /部署端口是 4100/);
      assert.equal(built.system.includes('<relevant_episodes>'), false);
      assert.deepEqual(built.manifest.memoryIds, [facts[0]!.id]);
      assert.deepEqual(built.manifest.episodeIds, []);
      assert.ok((await memory.longTerm.history(facts[0]!.id))[0]!.accessCount >= 1);

      const older = await store.saveEpisode({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: 1,
        title: '缓存目录',
        content: '曾经把缓存目录改到 .cache/runtime',
        entities: ['.cache/runtime'],
        tokenEstimate: 12,
      });
      const cacheQuestion = await userTurn(store, session.id, '缓存目录在哪');
      await finish(store, cacheQuestion.run.id);
      const withEpisode = await memory.buildContext({
        session,
        runId: cacheQuestion.run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: 8000, reserveForOutput: 100 },
      });
      assert.match(withEpisode.system, /<relevant_episodes>/);
      assert.match(withEpisode.system, /\.cache\/runtime/);
      assert.deepEqual(withEpisode.manifest.episodeIds, [older.id]);
    } finally {
      store.close();
    }
  });

  await t.test('messageSeqRange reports the slice sent to the model', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const systemPrompt = 'sys';
      const session = await store.createSession({
        config: { model: 'm', systemPrompt, maxOutputTokens: 20 },
      });
      const oldTurn = await userTurn(store, session.id, `old ${'z'.repeat(3000)}`);
      await finish(store, oldTurn.run.id);
      const tailTurn = await userTurn(store, session.id, 'tail-marker');
      await finish(store, tailTurn.run.id);
      const tailTokens = estimateContent(tailTurn.userMessage.content);
      const memory = new StandardMemoryManager(store);
      const built = await memory.buildContext({
        session,
        runId: tailTurn.run.id,
        systemPrompt,
        tools: [],
        budget: { maxInputTokens: estimateSystem(systemPrompt) + tailTokens + 4, reserveForOutput: 0 },
      });
      assert.deepEqual(
        built.messages.map((message) => message.content),
        [tailTurn.userMessage.content]
      );
      assert.deepEqual(built.manifest.messageSeqRange, [tailTurn.userMessage.seq, tailTurn.userMessage.seq]);
      assert.equal(built.manifest.droppedMessageCount, 1);
      assert.deepEqual(built.manifest.episodeIds, []);
    } finally {
      store.close();
    }
  });

  await t.test('rewind drops future episodes and session facts but keeps the transcript prefix and user facts', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20, memory: { userId: 'u_1' } },
      });
      const first = await userTurn(store, session.id, 'one');
      await finish(store, first.run.id);
      const second = await userTurn(store, session.id, 'two');
      await finish(store, second.run.id);
      const third = await userTurn(store, session.id, 'three');
      await finish(store, third.run.id);

      const memory = new StandardMemoryManager(store);
      const early = await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'early session fact',
        sourceType: 'message',
        sourceRef: `msg:${first.userMessage.seq}`,
        sourceSessionId: session.id,
        createdBy: 'memory-consolidator',
      });
      const late = await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'late session fact',
        sourceType: 'message',
        sourceRef: `msg:${third.userMessage.seq}`,
        sourceSessionId: session.id,
        createdBy: 'memory-consolidator',
      });
      const userFact = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: 'user fact survives rewind',
        sourceType: 'user_explicit',
        sourceRef: `msg:${third.userMessage.seq}`,
        createdBy: 'u_1',
      });
      await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'preference',
        content: 'derived preference from the rewound turn',
        sourceType: 'message',
        sourceRef: `msg:${third.userMessage.seq}`,
        sourceSessionId: session.id,
        createdBy: 'u_1',
      });
      await store.saveEpisode({
        sessionId: session.id,
        fromSeq: first.userMessage.seq,
        toSeq: first.userMessage.seq,
        title: 'early',
        content: 'early episode',
        entities: [],
        tokenEstimate: 2,
      });
      await store.saveEpisode({
        sessionId: session.id,
        fromSeq: third.userMessage.seq,
        toSeq: third.userMessage.seq,
        title: 'late',
        content: 'late episode',
        entities: [],
        tokenEstimate: 2,
      });

      const report = await store.revertSessionToSeq(session.id, first.userMessage.seq);
      assert.equal(report.deletedEpisodes, 1);
      assert.equal(report.forgottenMemories, 2);
      const episodes = await store.listEpisodes(session.id);
      assert.deepEqual(episodes.map((episode) => episode.title), ['early']);
      const sessionFacts = await memory.longTerm.recall({
        scopes: ['session'],
        bindings: [{ scopeType: 'session', scopeId: session.id }],
        limit: 10,
      });
      assert.deepEqual(sessionFacts.map((record) => record.id), [early.id]);
      assert.equal(sessionFacts.some((record) => record.id === late.id), false);
      const userFacts = await memory.longTerm.recall({
        scopes: ['user'],
        bindings: [{ scopeType: 'user', scopeId: 'u_1' }],
        limit: 5,
      });
      assert.equal(userFacts[0]?.id, userFact.id);
      const messages = await store.listMessages(session.id);
      assert.equal(messages.some((message) => message.seq > first.userMessage.seq), false);
      assert.ok(messages.some((message) => message.content.some((block: ContentBlock) => block.type === 'text' && block.text === 'one')));
    } finally {
      store.close();
    }
  });

  await t.test('memory tools remember, recall, correct, and refuse a foreign session', async () => {
    const { registry, store } = createAgentRuntime({
      modelAdapter: {
        providerId: 'fake',
        capabilities: { toolCalling: true, streaming: false, contextWindow: 8000 },
        async generate() {
          return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, model: 'fake' };
        },
      },
    });
    const quiet = createAgentRuntime({
      modelAdapter: {
        providerId: 'fake',
        capabilities: { toolCalling: false, streaming: false, contextWindow: 8000 },
        async generate() {
          throw new Error('unused');
        },
      },
      enableMemoryTools: false,
    });
    try {
      assert.equal(quiet.registry.get('memory_remember'), undefined);
      const remember = registry.get('memory_remember');
      const recall = registry.get('memory_recall');
      const correct = registry.get('memory_correct');
      const forget = registry.get('memory_forget');
      assert.ok(remember && recall && correct && forget);
      assert.equal(recall.def.sideEffect, 'none');
      assert.equal(remember.def.sideEffect, 'idempotent');

      const ctx = toolCtx('sess_a', 'user_a');
      const stored = await remember.def.execute({ content: '端口固定 4100', kind: 'fact', pin: true }, ctx);
      assert.equal(stored.isError, undefined);
      assert.match(stored.content, /Stored memory/);
      const id = (stored.data as { id: string }).id;

      const found = await recall.def.execute({ query: '端口' }, ctx);
      assert.match(found.content, new RegExp(id));
      assert.match(found.content, /4100/);

      const other = await recall.def.execute({ query: '端口' }, toolCtx('sess_b', 'user_b'));
      assert.match(other.content, /No matching memories/);

      const corrected = await correct.def.execute({ id, content: '端口固定 4200', reason: '端口改了' }, ctx);
      assert.match(corrected.content, /4200/);
      const nextId = (corrected.data as { id: string }).id;

      const denied = await forget.def.execute({ id: nextId, reason: '跨会话删除' }, toolCtx('sess_b', 'user_a'));
      assert.equal(denied.isError, true);
      const still = await recall.def.execute({ query: '4200' }, ctx);
      assert.match(still.content, /4200/);

      const forgotten = await forget.def.execute({ id: nextId, reason: '不再使用' }, ctx);
      assert.match(forgotten.content, /Forgot/);
      const gone = await recall.def.execute({ query: '4200' }, ctx);
      assert.match(gone.content, /No matching memories/);

      const twice = await remember.def.execute({ content: 'same millisecond fact' }, ctx);
      const again = await remember.def.execute({ content: 'same millisecond fact' }, ctx);
      assert.match(twice.content, /Stored memory/);
      assert.match(again.content, /Reinforced memory/);
      assert.equal((again.data as { reinforced: boolean }).reinforced, true);

      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20, memory: { agentId: 'agent-a' } },
      });
      const foreignAgent = await store.insertMemory({
        scopeType: 'agent',
        scopeId: 'agent-b',
        kind: 'fact',
        content: 'other agent rule',
        sourceType: 'system',
        createdBy: 'agent-b',
      });
      const deniedAgent = await correct.def.execute(
        { id: foreignAgent.id, content: 'taken over', reason: 'no' },
        toolCtx(session.id, 'user_a')
      );
      assert.equal(deniedAgent.isError, true);
      assert.match(deniedAgent.content, /another agent/);
      const deniedForget = await forget.def.execute(
        { id: foreignAgent.id, reason: 'no' },
        toolCtx(session.id, 'user_a')
      );
      assert.equal(deniedForget.isError, true);
      assert.match(deniedForget.content, /another agent/);
      const ownAgent = await store.insertMemory({
        scopeType: 'agent',
        scopeId: 'agent-a',
        kind: 'fact',
        content: 'this agent prefers pnpm',
        sourceType: 'system',
        createdBy: 'agent-a',
      });
      const seen = await recall.def.execute({ query: 'pnpm' }, toolCtx(session.id, 'user_a'));
      assert.match(seen.content, new RegExp(ownAgent.id));
      const hidden = await recall.def.execute({ query: 'pnpm' }, toolCtx('sess_a', 'user_a'));
      assert.match(hidden.content, /No matching memories/);
    } finally {
      store.close();
      quiet.store.close();
    }
  });

  await t.test('opens a legacy database that has memories without content_key', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-mem-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        source_session_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        status TEXT NOT NULL DEFAULT 'active',
        supersedes_id TEXT,
        status_reason TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO memories (
        id, scope_type, scope_id, kind, content, source_type, confidence, status, created_by, created_at, updated_at
      ) VALUES
        ('legacy_same_old', 'global', 'global', 'fact', 'same legacy fact', 'system', 1, 'active', 'migration', 1, 1),
        ('legacy_same_new', 'global', 'global', 'fact', 'same legacy fact', 'system', 1, 'active', 'migration', 2, 2),
        ('legacy_other', 'global', 'global', 'fact', 'other legacy fact', 'system', 1, 'active', 'migration', 3, 3);
    `);
    legacy.close();

    const store = new SqliteSessionStore(dbPath);
    try {
      const memory = new StandardMemoryManager(store);
      const saved = await memory.longTerm.remember({
        scopeType: 'global',
        scopeId: 'global',
        kind: 'fact',
        content: 'legacy file still stores facts',
        sourceType: 'system',
        createdBy: 'migration',
      });
      const found = await memory.longTerm.recall({ scopes: ['global'], scopeId: 'global', limit: 5 });
      assert.ok(found.some((record) => record.id === saved.id));
      const legacyRows = await memory.longTerm.recall({
        scopes: ['global'],
        bindings: [{ scopeType: 'global', scopeId: 'global' }],
        limit: 10,
      });
      const same = legacyRows.find((record) => record.content === 'same legacy fact');
      assert.equal(same?.id, 'legacy_same_old');
      assert.equal(same?.contentKey, memoryContentKey('fact', 'same legacy fact'));
      assert.equal(legacyRows.some((record) => record.id === 'legacy_same_new'), false);
      assert.equal(legacyRows.some((record) => record.id === 'legacy_other'), true);
      const reinforcedLegacy = await memory.longTerm.remember({
        scopeType: 'global',
        scopeId: 'global',
        kind: 'fact',
        content: 'same legacy fact',
        sourceType: 'system',
        createdBy: 'migration',
      });
      assert.equal(reinforcedLegacy.id, 'legacy_same_old');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('correction merges into an existing fact and refuses a superseded id', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      const alpha = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'alpha fact',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      const beta = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'beta fact',
        sourceType: 'user_explicit',
        pinned: true,
        createdBy: 'u_1',
      });
      const merged = await memory.longTerm.correct(beta.id, {
        content: 'alpha fact',
        reason: 'same wording already exists',
        by: 'u_1',
      });
      assert.equal(merged.id, alpha.id);
      assert.equal(merged.pinned, true);
      assert.ok(merged.accessCount >= 1);
      await assert.rejects(
        () => memory.longTerm.correct(beta.id, { content: 'gamma fact', reason: 'too late', by: 'u_1' }),
        (err: unknown) => err instanceof DomainError && (err as DomainError).code === 'MEMORY_NOT_ACTIVE'
      );
      await assert.rejects(
        () => memory.longTerm.forget(beta.id, { reason: 'already corrected', by: 'u_1' }),
        (err: unknown) => err instanceof DomainError && (err as DomainError).code === 'MEMORY_NOT_ACTIVE'
      );
      const active = await memory.longTerm.recall({
        scopes: ['user'],
        bindings: [{ scopeType: 'user', scopeId: 'u_1' }],
        limit: 10,
      });
      assert.deepEqual(active.map((record) => record.id), [alpha.id]);
    } finally {
      store.close();
    }
  });

  await t.test('empty bindings do not fall back to every user', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_secret',
        kind: 'fact',
        content: 'hidden user fact',
        sourceType: 'user_explicit',
        createdBy: 'u_secret',
      });
      const leaked = await memory.longTerm.recall({ scopes: ['user'], bindings: [], limit: 10 });
      assert.deepEqual(leaked, []);
    } finally {
      store.close();
    }
  });

  await t.test('fork keeps earlier session facts and rewind restores the previous summary', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20 },
      });
      const memory = new StandardMemoryManager(store);
      await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'existed before the first turn',
        sourceType: 'user_explicit',
        sourceSessionId: session.id,
        createdBy: 'user',
        createdAt: 1,
      });
      const first = await userTurn(store, session.id, 'one');
      await finish(store, first.run.id);
      const second = await userTurn(store, session.id, 'two');
      await finish(store, second.run.id);
      const early = await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'early fork fact',
        sourceType: 'message',
        sourceRef: `msg:${first.userMessage.seq}`,
        sourceSessionId: session.id,
        createdBy: 'memory-consolidator',
      });
      await store.touchMemories([early.id]);
      const touched = (await memory.longTerm.history(early.id)).at(-1)!;
      await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'late fork fact',
        sourceType: 'message',
        sourceRef: `msg:${second.userMessage.seq}`,
        sourceSessionId: session.id,
        createdBy: 'memory-consolidator',
      });
      await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'explicit after the fork point',
        sourceType: 'user_explicit',
        sourceSessionId: session.id,
        createdBy: 'user',
        createdAt: Date.now() + 60_000,
      });
      const fork = await store.forkSession(session.id, { atSeq: first.userMessage.seq });
      const copied = await memory.longTerm.recall({
        scopes: ['session'],
        bindings: [{ scopeType: 'session', scopeId: fork.id }],
        limit: 10,
      });
      assert.equal(copied.length, 2);
      assert.ok(copied.some((record) => record.content === 'early fork fact'));
      assert.ok(copied.some((record) => record.content === 'existed before the first turn'));
      assert.equal(copied.some((record) => record.content === 'explicit after the fork point'), false);
      assert.equal(copied.every((record) => record.sourceSessionId === fork.id), true);
      assert.equal(copied.find((record) => record.content === 'early fork fact')?.lastAccessedAt, touched.lastAccessedAt);
      const tip = await store.forkSession(session.id);
      const tipCopied = await memory.longTerm.recall({
        scopes: ['session'],
        bindings: [{ scopeType: 'session', scopeId: tip.id }],
        limit: 10,
      });
      assert.ok(tipCopied.some((record) => record.content === 'explicit after the fork point'));
      assert.ok(tipCopied.some((record) => record.content === 'late fork fact'));

      const summaryEarly = await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: first.userMessage.seq,
        content: 'summary one',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
      });
      await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: second.userMessage.seq,
        content: 'summary two',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
        supersedesId: summaryEarly.id,
      });
      await store.saveEpisode({
        sessionId: session.id,
        summaryId: summaryEarly.id,
        fromSeq: 1,
        toSeq: first.userMessage.seq,
        title: 'episode one',
        content: 'summary one',
        entities: [],
        tokenEstimate: 2,
      });
      await store.revertSessionToSeq(session.id, first.userMessage.seq);
      const active = await store.getActiveSummary(session.id);
      assert.equal(active?.id, summaryEarly.id);
      assert.equal(active?.status, 'active');
    } finally {
      store.close();
    }
  });

  await t.test('lexical recall keeps short CJK and punctuated English', async () => {
    assert.ok(scoreText('端口 4100', '端口是多少') > 0);
    assert.ok(scoreText('偏好使用 pnpm', 'ts 偏好') > 0);
    assert.ok(scoreText('User prefers TypeScript', 'TypeScript?') > 0);
    assert.equal(memoryContentKey('fact', 'User prefers TypeScript. '), memoryContentKey('fact', 'User prefers TypeScript.'));
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      const saved = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: '端口 4100',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'User prefers TypeScript. ',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      const reinforced = await memory.longTerm.remember({
        scopeType: 'user',
        scopeId: 'u_1',
        kind: 'fact',
        content: 'User prefers TypeScript.',
        sourceType: 'user_explicit',
        createdBy: 'u_1',
      });
      assert.notEqual(reinforced.id, saved.id);
      assert.ok(reinforced.accessCount >= 1);
      const recalled = await memory.longTerm.recall({
        scopes: ['user'],
        bindings: [{ scopeType: 'user', scopeId: 'u_1' }],
        query: '端口是多少',
        limit: 5,
      });
      assert.equal(recalled[0]?.id, saved.id);
    } finally {
      store.close();
    }
  });

  await t.test('touch does not bump a memory again inside the same minute', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      const saved = await memory.longTerm.remember({
        scopeType: 'global',
        scopeId: 'global',
        kind: 'fact',
        content: 'touch once',
        sourceType: 'system',
        createdBy: 'system',
      });
      await store.touchMemories([saved.id]);
      await store.touchMemories([saved.id]);
      const row = (await memory.longTerm.history(saved.id)).at(-1)!;
      assert.equal(row.accessCount, 1);
    } finally {
      store.close();
    }
  });

  await t.test('pinned facts leave room for an unpinned match', () => {
    const now = Date.now();
    const fact = (id: string, content: string, pinned: boolean): MemoryRecord => ({
      id,
      scopeType: 'user',
      scopeId: 'u_1',
      kind: 'fact',
      content,
      sourceType: 'user_explicit',
      confidence: 1,
      salience: 0.5,
      pinned,
      accessCount: 0,
      tags: [],
      status: 'active',
      createdBy: 'u_1',
      createdAt: now,
      updatedAt: now,
    });
    const ranked = selectRankedMemories(
      [
        fact('p1', 'pinned atlas one', true),
        fact('p2', 'pinned atlas two', true),
        fact('p3', 'pinned atlas three', true),
        fact('p4', 'pinned atlas four', true),
        fact('match', 'Windows port 4100 is the deployment target', false),
      ],
      'Windows port',
      4,
      now
    );
    assert.equal(ranked.filter((record) => record.pinned).length, 3);
    assert.ok(ranked.some((record) => record.id === 'match'));
    assert.equal(ranked.some((record) => record.id === 'p4'), false);
  });

  await t.test('context overflow does not touch recalled memories', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const memory = new StandardMemoryManager(store);
      const session = await store.createSession({
        config: {
          model: 'm',
          systemPrompt: 'sys',
          maxOutputTokens: 20,
          memoryRecall: { enabled: true, limit: 4 },
        },
      });
      const saved = await memory.longTerm.remember({
        scopeType: 'session',
        scopeId: session.id,
        kind: 'fact',
        content: 'overflow should not count as a read',
        sourceType: 'user_explicit',
        createdBy: 'user',
      });
      await assert.rejects(
        () => memory.buildContext({
          session,
          runId: 'run_overflow',
          systemPrompt: 'sys',
          tools: [],
          budget: { maxInputTokens: 1, reserveForOutput: 100 },
        }),
        (err: unknown) => err instanceof ContextOverflowError
      );
      const row = (await memory.longTerm.history(saved.id)).at(-1)!;
      assert.equal(row.accessCount, 0);
      assert.equal(row.lastAccessedAt, undefined);
    } finally {
      store.close();
    }
  });

  await t.test('rewind does not revive a stale summary', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20 },
      });
      const first = await userTurn(store, session.id, 'one');
      await finish(store, first.run.id);
      const second = await userTurn(store, session.id, 'two');
      await finish(store, second.run.id);
      const early = await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: first.userMessage.seq,
        content: 'kept summary',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
      });
      await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: second.userMessage.seq,
        content: 'stale summary',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
        supersedesId: early.id,
      });
      await store.excludeMessages(session.id, [second.userMessage.seq], 'redacted');
      await store.revertSessionToSeq(session.id, second.userMessage.seq);
      const active = await store.getActiveSummary(session.id);
      assert.equal(active?.id, early.id);
      assert.equal(active?.content, 'kept summary');
      assert.equal(active?.status, 'active');
    } finally {
      store.close();
    }
  });

  await t.test('rewind does not revive a superseded summary of an excluded message', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20 },
      });
      const first = await userTurn(store, session.id, 'one');
      await finish(store, first.run.id);
      const second = await userTurn(store, session.id, 'two');
      await finish(store, second.run.id);
      const third = await userTurn(store, session.id, 'three');
      await finish(store, third.run.id);
      const untouched = await store.saveSummary({
        sessionId: session.id,
        fromSeq: second.userMessage.seq,
        toSeq: second.userMessage.seq,
        content: 'kept summary',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
      });
      const covered = await store.saveSummary({
        sessionId: session.id,
        fromSeq: first.userMessage.seq,
        toSeq: second.userMessage.seq,
        content: 'covers the excluded message',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
        supersedesId: untouched.id,
      });
      await store.saveSummary({
        sessionId: session.id,
        fromSeq: first.userMessage.seq,
        toSeq: third.userMessage.seq,
        content: 'later summary',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
        supersedesId: covered.id,
      });
      await store.excludeMessages(session.id, [first.userMessage.seq], 'redacted');
      await store.revertSessionToSeq(session.id, second.userMessage.seq);
      const active = await store.getActiveSummary(session.id);
      assert.equal(active?.id, untouched.id);
      assert.equal(active?.content, 'kept summary');
    } finally {
      store.close();
    }
  });

  await t.test('rewind detaches an episode that still points at a deleted summary', async () => {
    const store = new SqliteSessionStore(':memory:');
    try {
      const session = await store.createSession({
        config: { model: 'm', systemPrompt: 'sys', maxOutputTokens: 20 },
      });
      const first = await userTurn(store, session.id, 'one');
      await finish(store, first.run.id);
      const second = await userTurn(store, session.id, 'two');
      await finish(store, second.run.id);
      const later = await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: second.userMessage.seq,
        content: 'later summary',
        tokenEstimate: 2,
        model: 'm',
        promptVersion: 'v1',
      });
      const episode = await store.saveEpisode({
        sessionId: session.id,
        summaryId: later.id,
        fromSeq: 1,
        toSeq: first.userMessage.seq,
        title: 'kept episode',
        content: 'still in range',
        entities: [],
        tokenEstimate: 2,
      });
      await store.revertSessionToSeq(session.id, first.userMessage.seq);
      const episodes = await store.listEpisodes(session.id);
      assert.equal(episodes.length, 1);
      assert.equal(episodes[0]?.id, episode.id);
      assert.equal(episodes[0]?.summaryId, undefined);
      assert.equal(await store.getActiveSummary(session.id), null);
    } finally {
      store.close();
    }
  });
});
