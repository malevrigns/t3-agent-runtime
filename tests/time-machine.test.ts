import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContentBlock, Message, Principal } from '../src/core/types.js';
import { DomainError, SessionBusyError } from '../src/core/errors.js';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import { StandardToolExecutor } from '../src/tools/executor.js';
import { DefaultPermissionPolicy } from '../src/tools/permissions.js';
import { StandardMemoryManager } from '../src/memory/memory-manager.js';
import { InMemoryEventBus } from '../src/events/in-memory-event-bus.js';
import { AgentLoop } from '../src/runtime/agent-loop.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import { RecoveryService } from '../src/runtime/recovery.js';
import { ShadowFsTimeMachine, type ShadowFsOptions } from '../src/runtime/time-machine.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import type { ToolDefinition } from '../src/tools/ports.js';

const principal: Principal = {
  id: 'user_shadow',
  kind: 'user',
  grants: ['*'],
};

function workspace(): string {
  return mkdtempSync(path.join(tmpdir(), 'pi-shadow-fs-'));
}

function cleanup(dir: string, store?: SqliteSessionStore): void {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}

function wire(
  model: FakeModelAdapter,
  options?: ShadowFsOptions & { approvalMode?: 'always' | 'ask_for_side_effects' | 'never' }
) {
  const store = new SqliteSessionStore(':memory:');
  const shadow = new ShadowFsTimeMachine(store, {
    workspaceDir: options?.workspaceDir,
    pathExtractor: options?.pathExtractor,
    trackWorkspaceDiff: options?.trackWorkspaceDiff,
  });
  const bus = new InMemoryEventBus();
  const registry = new InMemoryToolRegistry();
  const executor = new StandardToolExecutor(
    registry,
    new DefaultPermissionPolicy(options?.approvalMode ?? 'never')
  );
  const memory = new StandardMemoryManager(store);
  const loop = new AgentLoop({
    store,
    model,
    registry,
    executor,
    memory,
    bus,
    hooks: [shadow.createHook()],
  });
  const runtime = new AgentRuntime(store, loop, bus, new RecoveryService(store, bus));
  return { store, registry, runtime };
}

function pickPath(args: Record<string, unknown>, root: string): string {
  const listed = Array.isArray(args.files) ? args.files.find((item) => typeof item === 'string') : undefined;
  const raw =
    (typeof args.path === 'string' && args.path) ||
    (typeof args.filePath === 'string' && args.filePath) ||
    (typeof args.targetFile === 'string' && args.targetFile) ||
    (typeof args.TargetFile === 'string' && args.TargetFile) ||
    (typeof listed === 'string' ? listed : '');
  if (!raw) throw new Error('tool args did not include a file path');
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
}

function registerFileTools(registry: InMemoryToolRegistry, root: string): void {
  const writeFile: ToolDefinition = {
    name: 'write_file',
    description: 'Create or overwrite a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        filePath: { type: 'string' },
        targetFile: { type: 'string' },
        files: { type: 'array' },
        content: { type: 'string' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: [],
    async execute(args: Record<string, unknown>) {
      const filePath = pickPath(args, root);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, String(args.content ?? ''));
      return { content: `wrote ${filePath}` };
    },
  };
  const deleteFile: ToolDefinition = {
    name: 'delete_file',
    description: 'Delete a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        targetFile: { type: 'string' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: [],
    async execute(args: Record<string, unknown>) {
      const filePath = pickPath(args, root);
      rmSync(filePath, { force: true });
      return { content: `deleted ${filePath}` };
    },
  };
  registry.register(writeFile);
  registry.register(deleteFile);
}

async function openSession(runtime: AgentRuntime, title: string) {
  return runtime.createSession({
    title,
    config: {
      model: 'fake-model',
      systemPrompt: 'shadow fs test',
      maxOutputTokens: 300,
    },
  });
}

async function completeTurn(runtime: AgentRuntime, sessionId: string, userInput: string) {
  const handle = await runtime.startRun({ sessionId, userInput, principal });
  const outcome = await handle.result;
  assert.equal(outcome.status, 'completed', outcome.error?.message ?? outcome.stopReason ?? 'run failed');
  return handle;
}

function textOf(message: Message): string {
  return JSON.stringify(message.content);
}

function messageWithCall(messages: Message[], toolCallId: string, role: 'assistant' | 'tool'): Message {
  const found = messages.find((message) => {
    if (message.role !== role) return false;
    return message.content.some((block) => {
      if (role === 'assistant') return block.type === 'tool_call' && block.toolCallId === toolCallId;
      return block.type === 'tool_result' && block.toolCallId === toolCallId;
    });
  });
  assert.ok(found, `missing ${role} message for ${toolCallId}`);
  return found;
}

test('Shadow FS time machine', async (t) => {
  await t.test('rewinds disk and transcript to the end of round 1, then accepts a new run', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const { store, registry, runtime } = wire(model, { workspaceDir: root });
    const created = path.join(root, 'created.txt');
    const edited = path.join(root, 'edited.txt');
    const extra = path.join(root, 'extra.txt');
    writeFileSync(edited, 'seed');
    registerFileTools(registry, root);

    try {
      const session = await openSession(runtime, 'Roundtrip');
      model.enqueueResponse(() => ({
        content: [
          { type: 'tool_call', toolCallId: 'w1', toolName: 'write_file', args: { path: created, content: 'round1' } },
          {
            type: 'tool_call',
            toolCallId: 'w2',
            toolName: 'write_file',
            args: { filePath: edited, content: 'round1-edit' },
          },
        ] as ContentBlock[],
        finishReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 10 },
        model: 'fake-model',
      }));
      model.enqueueText('round 1 done');
      const first = await completeTurn(runtime, session.id, 'Prepare the workspace');
      const round1Seq = (await store.listMessages(session.id)).at(-1)!.seq;

      model.enqueueResponse(() => ({
        content: [
          { type: 'tool_call', toolCallId: 'w3', toolName: 'write_file', args: { path: created, content: 'round2' } },
          {
            type: 'tool_call',
            toolCallId: 'w4',
            toolName: 'write_file',
            args: { files: [extra], content: 'extra' },
          },
          { type: 'tool_call', toolCallId: 'd1', toolName: 'delete_file', args: { targetFile: edited } },
        ] as ContentBlock[],
        finishReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 12 },
        model: 'fake-model',
      }));
      model.enqueueText('round 2 done');
      await completeTurn(runtime, session.id, 'Mutate everything');

      assert.equal(readFileSync(created, 'utf8'), 'round2');
      assert.equal(existsSync(edited), false);
      assert.equal(readFileSync(extra, 'utf8'), 'extra');

      const beforeRewind = await store.listMessages(session.id, { includeExcluded: true });
      const firstWrite = (await runtime.listFileSnapshots(session.id)).find((item) => item.toolCallId === 'w1');
      assert.ok(firstWrite);
      assert.equal(firstWrite.changeType, 'created');
      assert.equal(firstWrite.existedBefore, false);
      assert.equal(firstWrite.checkpointSeq, messageWithCall(beforeRewind, 'w1', 'assistant').seq);
      assert.ok(firstWrite.checkpointSeq < messageWithCall(beforeRewind, 'w1', 'tool').seq);
      const editedSnap = (await runtime.listFileSnapshots(session.id)).find((item) => item.toolCallId === 'w2');
      assert.ok(editedSnap);
      assert.equal(editedSnap.changeType, 'modified');
      assert.equal(Buffer.from(editedSnap.beforeContentB64 ?? '', 'base64').toString('utf8'), 'seed');
      const round2Snaps = (await runtime.listFileSnapshots(session.id, { afterSeq: round1Seq }));
      assert.equal(round2Snaps.length, 3);
      assert.ok(round2Snaps.every((item) => item.checkpointSeq > round1Seq));
      const modifyCreated = round2Snaps.find((item) => item.toolCallId === 'w3');
      assert.equal(Buffer.from(modifyCreated?.beforeContentB64 ?? '', 'base64').toString('utf8'), 'round1');

      await assert.rejects(
        () => runtime.revertToSeq(session.id, -1),
        (err: unknown) => err instanceof DomainError && !(err instanceof SessionBusyError)
      );
      await assert.rejects(
        () => store.revertSessionToSeq(session.id, round1Seq + 100),
        (err: unknown) => err instanceof DomainError && (err as DomainError).code === 'TARGET_SEQ_OUT_OF_RANGE'
      );

      await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: round1Seq,
        content: 'kept summary',
        tokenEstimate: 4,
        model: 'fake',
        promptVersion: 'v1',
      });
      await store.saveSummary({
        sessionId: session.id,
        fromSeq: 1,
        toSeq: round1Seq + 2,
        content: 'dropped summary',
        tokenEstimate: 4,
        model: 'fake',
        promptVersion: 'v1',
      });
      await store.enqueueTurnMessage({
        sessionId: session.id,
        kind: 'follow_up',
        content: [{ type: 'text', text: 'queued after round 2' }],
      });

      const removedMessages = beforeRewind.filter((message) => message.seq > round1Seq).length;
      const report = await runtime.revertToSeq(session.id, round1Seq);
      assert.equal(report.deletedMessages, removedMessages);
      assert.equal(report.deletedSnapshots, 3);
      assert.equal(report.invalidatedSummaries, 1);
      assert.equal(report.backupSessionId, undefined);
      assert.equal(readFileSync(created, 'utf8'), 'round1');
      assert.equal(readFileSync(edited, 'utf8'), 'round1-edit');
      assert.equal(existsSync(extra), false);
      assert.ok(report.restoredFiles.includes(created));
      assert.ok(report.restoredFiles.includes(edited));
      assert.ok(report.deletedFiles.includes(extra));

      const afterRewind = await store.listMessages(session.id, { includeExcluded: true });
      assert.equal(afterRewind.length, beforeRewind.length - removedMessages);
      assert.equal(afterRewind.at(-1)!.seq, round1Seq);
      assert.equal(afterRewind.some((message) => textOf(message).includes('round 2 done')), false);
      assert.equal(textOf(afterRewind.at(-1)!).includes('round 1 done'), true);
      const kept = await runtime.listFileSnapshots(session.id);
      assert.ok(kept.length >= 2);
      assert.ok(kept.every((item) => item.checkpointSeq <= round1Seq));
      const summary = await store.getActiveSummary(session.id);
      assert.equal(summary?.content, 'kept summary');
      assert.deepEqual(await store.takeQueuedMessages(session.id), []);
      const reloaded = await store.getSession(session.id);
      assert.equal(reloaded?.nextSeq, round1Seq + 1);

      model.enqueueText('resumed');
      const resumed = await completeTurn(runtime, session.id, 'Continue after rewind');
      assert.equal((await resumed.result).status, 'completed');
      const resumedMessages = await store.listMessages(session.id);
      assert.equal(resumedMessages.find((message) => textOf(message).includes('Continue after rewind'))?.seq, round1Seq + 1);
      assert.equal(first.runId.length > 0, true);
    } finally {
      cleanup(root, store);
    }
  });

  await t.test('workspace scan catches undeclared file mutations and restores them', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const { store, registry, runtime } = wire(model, { workspaceDir: root });
    const implicit = path.join(root, 'implicit.txt');
    const sneaky = path.join(root, 'sneaky.txt');
    const ignoredDir = path.join(root, 'node_modules');
    const ignored = path.join(ignoredDir, 'pkg.js');
    mkdirSync(ignoredDir, { recursive: true });
    writeFileSync(implicit, 'alpha');
    writeFileSync(ignored, 'old');

    registry.register({
      name: 'bash',
      description: 'Run a workspace mutation without declaring paths',
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: { command: { type: 'string' } },
      },
      sideEffect: 'non_idempotent',
      requiredPermissions: [],
      async execute(args: { command: string }) {
        assert.equal(args.command, 'mutate');
        writeFileSync(implicit, 'beta');
        writeFileSync(sneaky, 'sneaky');
        writeFileSync(ignored, 'new');
        return { content: 'mutated' };
      },
    });

    try {
      const session = await openSession(runtime, 'Scan');
      model.enqueueToolCall('bash1', 'bash', { command: 'mutate' });
      model.enqueueText('scan done');
      const handle = await completeTurn(runtime, session.id, 'Touch files from a script');
      assert.equal(readFileSync(implicit, 'utf8'), 'beta');
      assert.equal(readFileSync(sneaky, 'utf8'), 'sneaky');

      const snaps = await runtime.listFileSnapshots(session.id, { runId: handle.runId });
      assert.ok(snaps.some((item) => item.filePath === implicit && item.changeType === 'modified'));
      assert.ok(snaps.some((item) => item.filePath === sneaky && item.changeType === 'created'));
      assert.equal(snaps.some((item) => item.filePath === ignored), false);

      const messages = await store.listMessages(session.id);
      const userSeq = messages.find((message) => message.role === 'user')!.seq;
      await runtime.revertToSeq(session.id, userSeq);
      assert.equal(readFileSync(implicit, 'utf8'), 'alpha');
      assert.equal(existsSync(sneaky), false);
      assert.equal(readFileSync(ignored, 'utf8'), 'new');
      const remaining = await store.listMessages(session.id);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].seq, userSeq);
    } finally {
      cleanup(root, store);
    }
  });

  await t.test('preserveBackupBranch keeps the pre-revert transcript on a fork', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const { store, registry, runtime } = wire(model, { workspaceDir: root });
    const extra = path.join(root, 'branch.txt');
    registerFileTools(registry, root);

    try {
      const session = await openSession(runtime, 'Main');
      model.enqueueText('first reply');
      await completeTurn(runtime, session.id, 'Turn 1');
      const round1Seq = (await store.listMessages(session.id)).at(-1)!.seq;

      model.enqueueToolCall('branch_write', 'write_file', { path: extra, content: 'from-branch' });
      model.enqueueText('second reply');
      await completeTurn(runtime, session.id, 'Turn 2');
      assert.equal(readFileSync(extra, 'utf8'), 'from-branch');

      const report = await runtime.revertToSeq(session.id, round1Seq, { preserveBackupBranch: true });
      assert.equal(existsSync(extra), false);
      assert.ok(report.backupSessionId);
      const branches = await runtime.listSessionBranches(session.id);
      assert.equal(branches.length, 1);
      assert.equal(branches[0].id, report.backupSessionId);
      assert.match(branches[0].title ?? '', /backup before seq/);
      const backupMessages = await store.listMessages(report.backupSessionId);
      assert.equal(backupMessages.some((message) => textOf(message).includes('Turn 2')), true);
      assert.equal(backupMessages.some((message) => textOf(message).includes('second reply')), true);
      const parentMessages = await store.listMessages(session.id);
      assert.equal(parentMessages.some((message) => textOf(message).includes('Turn 2')), false);
      assert.equal(parentMessages.some((message) => textOf(message).includes('first reply')), true);
      assert.equal(parentMessages.at(-1)!.seq, round1Seq);
    } finally {
      cleanup(root, store);
    }
  });

  await t.test('refuses to rewind while a run is active', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const { store, registry, runtime } = wire(model, { approvalMode: 'ask_for_side_effects' });
    registry.register({
      name: 'danger',
      description: 'Needs approval',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      sideEffect: 'non_idempotent',
      requiredPermissions: [],
      async execute() {
        return { content: 'should not run' };
      },
    });

    try {
      const session = await openSession(runtime, 'Busy');
      model.enqueueToolCall('danger1', 'danger', { path: path.join(root, 'nope.txt') });
      const handle = await runtime.startRun({
        sessionId: session.id,
        userInput: 'Do the dangerous thing',
        principal,
      });
      const outcome = await handle.result;
      assert.equal(outcome.status, 'waiting_input');
      await assert.rejects(
        () => runtime.revertToSeq(session.id, 0),
        (err: unknown) => err instanceof SessionBusyError && err.sessionId === session.id
      );
      await assert.rejects(
        () => store.revertSessionToSeq(session.id, 0),
        (err: unknown) => err instanceof SessionBusyError
      );
      assert.equal((await store.getActiveRun(session.id))?.id, handle.runId);
    } finally {
      cleanup(root, store);
    }
  });

  await t.test('revertToStep restores the disk to a step boundary', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const { store, registry, runtime } = wire(model, { workspaceDir: root });
    const step0 = path.join(root, 'step0.txt');
    const step1 = path.join(root, 'step1.txt');
    registerFileTools(registry, root);

    try {
      const session = await openSession(runtime, 'Steps');
      model.enqueueToolCall('s0', 'write_file', { path: step0, content: 'zero' });
      model.enqueueToolCall('s1', 'write_file', { path: step1, content: 'one' });
      model.enqueueText('both steps done');
      const handle = await completeTurn(runtime, session.id, 'Two steps');
      assert.equal(readFileSync(step0, 'utf8'), 'zero');
      assert.equal(readFileSync(step1, 'utf8'), 'one');

      const before = await store.listMessages(session.id, { includeExcluded: true });
      const firstStep = messageWithCall(before, 's0', 'assistant').stepIndex;
      assert.equal(typeof firstStep, 'number');
      const report = await runtime.revertToStep(session.id, handle.runId, firstStep!);
      assert.equal(readFileSync(step0, 'utf8'), 'zero');
      assert.equal(existsSync(step1), false);
      assert.ok(report.deletedFiles.includes(step1));
      const kept = await store.listMessages(session.id);
      assert.equal(kept.some((message) => textOf(message).includes('s0')), true);
      assert.equal(kept.some((message) => textOf(message).includes('s1')), false);
      assert.equal(kept.some((message) => textOf(message).includes('both steps done')), false);

      const fresh = await openSession(runtime, 'Before run');
      const only = path.join(root, 'only.txt');
      model.enqueueToolCall('only1', 'write_file', { path: only, content: 'temp' });
      model.enqueueText('created only');
      const second = await completeTurn(runtime, fresh.id, 'Create then erase');
      const erased = await runtime.revertToStep(fresh.id, second.runId, -1);
      assert.equal(existsSync(only), false);
      assert.ok(erased.deletedFiles.includes(only));
      assert.equal((await store.listMessages(fresh.id)).length, 0);
      assert.equal((await store.getSession(fresh.id))?.nextSeq, 1);
    } finally {
      cleanup(root, store);
    }
  });

  await t.test('custom pathExtractor tracks paths that are not declared in common fields', async () => {
    const root = workspace();
    const model = new FakeModelAdapter();
    const hidden = path.join(root, 'noted.txt');
    const { store, registry, runtime } = wire(model, {
      pathExtractor: (toolName) => (toolName === 'annotate' ? [hidden] : []),
    });
    registry.register({
      name: 'annotate',
      description: 'Write a note to a path supplied by the extractor',
      inputSchema: {
        type: 'object',
        required: ['note'],
        properties: { note: { type: 'string' } },
      },
      sideEffect: 'none',
      requiredPermissions: [],
      async execute(args: { note: string }) {
        writeFileSync(hidden, args.note);
        return { content: 'noted' };
      },
    });

    try {
      const session = await openSession(runtime, 'Extractor');
      model.enqueueToolCall('note1', 'annotate', { note: 'via extractor' });
      model.enqueueText('noted');
      await completeTurn(runtime, session.id, 'Annotate');
      const snaps = await runtime.listFileSnapshots(session.id);
      assert.equal(snaps.length, 1);
      assert.equal(snaps[0].filePath, path.resolve(hidden));
      assert.equal(snaps[0].changeType, 'created');
      const target = (await store.listMessages(session.id)).find((message) => message.role === 'user')!.seq;
      await runtime.revertToSeq(session.id, target);
      assert.equal(existsSync(hidden), false);
    } finally {
      cleanup(root, store);
    }
  });
});
