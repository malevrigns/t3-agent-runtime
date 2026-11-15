import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import { OpenAICompatibleAdapter } from '../src/model/openai-adapter.js';
import { SqliteSessionStore } from '../src/store/sqlite/sqlite-store.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import { DefaultPermissionPolicy } from '../src/tools/permissions.js';
import { StandardToolExecutor } from '../src/tools/executor.js';
import { StandardMemoryManager } from '../src/memory/memory-manager.js';
import { InMemoryEventBus } from '../src/events/in-memory-event-bus.js';
import { AgentLoop } from '../src/runtime/agent-loop.js';
import { RecoveryService } from '../src/runtime/recovery.js';
import { AgentRuntime } from '../src/runtime/agent-runtime.js';
import type { RuntimeHook } from '../src/runtime/hooks.js';
import type { Principal } from '../src/core/types.js';
import type { RunEvent } from '../src/events/ports.js';

const TEST_PRINCIPAL: Principal = {
  id: 'spec_user',
  kind: 'user',
  grants: ['*'],
};

function makeLocalRuntime(
  model: FakeModelAdapter | OpenAICompatibleAdapter,
  hooks?: RuntimeHook[]
) {
  const store = new SqliteSessionStore(':memory:');
  const bus = new InMemoryEventBus();
  const registry = new InMemoryToolRegistry();
  const policy = new DefaultPermissionPolicy('ask_for_side_effects');
  const executor = new StandardToolExecutor(registry, policy);
  const memory = new StandardMemoryManager(store);
  const loop = new AgentLoop({ store, model, registry, executor, memory, bus, hooks });
  const recovery = new RecoveryService(store, bus);
  const runtime = new AgentRuntime(store, loop, bus, recovery, 'spec_worker');
  return { runtime, registry, store, bus };
}

describe('Speculative Streaming Tool Prefetch', () => {
  it('prefetches sideEffect=none tools while model is still streaming and hits cache cleanly', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry } = makeLocalRuntime(model);

    let toolExecCount = 0;
    let toolStartedAt = 0;
    let toolFinishedAt = 0;

    registry.register({
      name: 'read_doc',
      description: 'Read a document',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { path: string }) {
        toolExecCount++;
        toolStartedAt = Date.now();
        await new Promise((r) => setTimeout(r, 40));
        toolFinishedAt = Date.now();
        return { content: `contents of ${args.path}` };
      },
    });

    model.enqueueStreamedDeltas({
      chunks: [
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'call_read_1',
            toolName: 'read_doc',
            argsDelta: '{"path":',
          },
        },
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            argsDelta: '"README.md"}',
          },
          delayMs: 10,
        },
        {
          // Simulate model taking another 110ms streaming trailing explanation
          delta: { type: 'text_delta', text: 'Checking README...' },
          delayMs: 110,
        },
      ],
      response: {
        content: [
          { type: 'text', text: 'Checking README...' },
          { type: 'tool_call', toolCallId: 'call_read_1', toolName: 'read_doc', args: { path: 'README.md' } },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 60, outputTokens: 30 },
        model: 'fake-model',
      },
    });
    model.enqueueText('Done reading README.md');

    const session = await runtime.createSession({
      title: 'Speculative Read',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    const events: Array<{ type: string; ts: number; event: RunEvent }> = [];
    runtime.subscribe({ sessionId: session.id }, (event) => {
      events.push({ type: event.type, ts: Date.now(), event });
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'Read README.md',
      principal: TEST_PRINCIPAL,
    });
    const outcome = await handle.result;

    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.finalText, 'Done reading README.md');
    assert.equal(toolExecCount, 1);

    const modelFinishedEvent = events.find((e) => e.type === 'model_call_finished');
    const prefetchEvent = events.find((e) => e.type === 'tool_speculative_prefetched');
    const toolFinishedEvent = events.find((e) => e.type === 'tool_execution_finished');

    assert.ok(prefetchEvent, 'Expected tool_speculative_prefetched event');
    assert.ok(modelFinishedEvent, 'Expected model_call_finished event');
    assert.ok(toolFinishedEvent && toolFinishedEvent.event.type === 'tool_execution_finished');
    assert.equal(toolFinishedEvent.event.speculativeHit, true);
    assert.equal(toolFinishedEvent.event.fromCache, true);
    assert.ok(
      toolStartedAt > 0 && toolFinishedAt <= modelFinishedEvent.ts + 5,
      `Expected speculative tool (${toolFinishedAt}) to finish before or at model_call_finished (${modelFinishedEvent.ts})`
    );
  });

  it('never speculatively executes idempotent or non_idempotent tools', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry } = makeLocalRuntime(model);

    let mutatingExecTime = 0;
    registry.register({
      name: 'write_note',
      description: 'Write a note',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      sideEffect: 'idempotent',
      requiredPermissions: ['note:write'],
      async execute(args: { text: string }) {
        mutatingExecTime = Date.now();
        return { content: `wrote ${args.text}` };
      },
    });

    model.enqueueStreamedDeltas({
      chunks: [
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'call_write_1',
            toolName: 'write_note',
            argsDelta: '{"text":"hello"}',
          },
        },
        {
          delta: { type: 'text_delta', text: 'Writing...' },
          delayMs: 60,
        },
      ],
      response: {
        content: [
          { type: 'text', text: 'Writing...' },
          { type: 'tool_call', toolCallId: 'call_write_1', toolName: 'write_note', args: { text: 'hello' } },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 40, outputTokens: 20 },
        model: 'fake-model',
      },
    });
    model.enqueueText('Written');

    const session = await runtime.createSession({
      title: 'Safety Check',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    const events: Array<{ type: string; ts: number; event: RunEvent }> = [];
    runtime.subscribe({ sessionId: session.id }, (event) => {
      events.push({ type: event.type, ts: Date.now(), event });
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'Write hello',
      principal: TEST_PRINCIPAL,
    });
    const outcome = await handle.result;

    assert.equal(outcome.status, 'completed');
    const modelFinishedEvent = events.find((e) => e.type === 'model_call_finished');
    const prefetchEvent = events.find((e) => e.type === 'tool_speculative_prefetched');
    const toolFinishedEvent = events.find((e) => e.type === 'tool_execution_finished');

    assert.equal(prefetchEvent, undefined);
    assert.ok(modelFinishedEvent);
    assert.ok(mutatingExecTime >= modelFinishedEvent.ts - 2, 'Mutating tool must run after model finishes');
    assert.ok(toolFinishedEvent && toolFinishedEvent.event.type === 'tool_execution_finished');
    assert.notEqual(toolFinishedEvent.event.speculativeHit, true);
  });

  it('aborts and discards speculative execution if final args differ or hook rewrites args', async () => {
    const model = new FakeModelAdapter();
    let hookRewrote = false;
    const rewriteHook: RuntimeHook = {
      name: 'rewrite-path',
      beforeToolCall({ call }) {
        if (call.toolName === 'read_file' && (call.args as any)?.path === 'old.txt') {
          hookRewrote = true;
          return { action: 'allow', args: { path: 'new.txt' } };
        }
      },
    };
    const { runtime, registry } = makeLocalRuntime(model, [rewriteHook]);

    let abortedCount = 0;
    const seenPaths: string[] = [];

    registry.register({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { path: string }, ctx) {
        seenPaths.push(args.path);
        ctx.signal.addEventListener('abort', () => {
          abortedCount++;
        });
        await new Promise((r) => setTimeout(r, 80));
        return { content: `data:${args.path}` };
      },
    });

    model.enqueueStreamedDeltas({
      chunks: [
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'call_drift_1',
            toolName: 'read_file',
            argsDelta: '{"path":"old.txt"}',
          },
        },
        {
          delta: { type: 'text_delta', text: 'Checking...' },
          delayMs: 30,
        },
      ],
      response: {
        content: [
          { type: 'tool_call', toolCallId: 'call_drift_1', toolName: 'read_file', args: { path: 'old.txt' } },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 30, outputTokens: 15 },
        model: 'fake-model',
      },
    });
    model.enqueueText('Got new.txt');

    const session = await runtime.createSession({
      title: 'Drift Test',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'Read file',
      principal: TEST_PRINCIPAL,
    });
    const outcome = await handle.result;

    assert.equal(outcome.status, 'completed');
    assert.equal(hookRewrote, true);
    assert.deepEqual(seenPaths, ['old.txt', 'new.txt']);
    assert.equal(abortedCount, 1, 'Speculative execution with mismatched args must be aborted');
  });

  it('triggers speculative prefetch end-to-end from OpenAICompatibleAdapter SSE stream', async () => {
    let requestCounter = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requestCounter++;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        if (requestCounter === 1) {
          const writeSse = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
          writeSse({
            model: 'sse-test-model',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_sse_1', type: 'function', function: { name: 'lookup', arguments: '{"k":' } },
                  ],
                },
              },
            ],
          });
          setTimeout(() => {
            writeSse({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"alpha"}' } }],
                  },
                },
              ],
            });
          }, 10);
          setTimeout(() => {
            writeSse({
              choices: [{ index: 0, delta: { content: 'Looking up alpha...' }, finish_reason: 'tool_calls' }],
              usage: { prompt_tokens: 25, completion_tokens: 12 },
            });
            res.write('data: [DONE]\n\n');
            res.end();
          }, 90);
        } else {
          res.write(
            `data: ${JSON.stringify({
              model: 'sse-test-model',
              choices: [{ index: 0, delta: { content: 'Alpha is ready.' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 40, completion_tokens: 8 },
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };

    try {
      const adapter = new OpenAICompatibleAdapter({
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${addr.port}/v1`,
        proxy: '',
      });
      const { runtime, registry } = makeLocalRuntime(adapter);

      let execCount = 0;
      registry.register({
        name: 'lookup',
        description: 'Lookup key',
        inputSchema: {
          type: 'object',
          required: ['k'],
          properties: { k: { type: 'string' } },
        },
        sideEffect: 'none',
        requiredPermissions: [],
        async execute(args: { k: string }) {
          execCount++;
          await new Promise((r) => setTimeout(r, 25));
          return { content: `value(${args.k})=42` };
        },
      });

      const session = await runtime.createSession({
        title: 'SSE Speculative',
        config: { model: 'sse-test-model', systemPrompt: 'sys', maxOutputTokens: 200 },
      });

      const events: RunEvent[] = [];
      runtime.subscribe({ sessionId: session.id }, (e) => events.push(e));

      const handle = await runtime.startRun({
        sessionId: session.id,
        userInput: 'Lookup alpha',
        principal: TEST_PRINCIPAL,
      });
      const outcome = await handle.result;

      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.finalText, 'Alpha is ready.');
      assert.equal(execCount, 1);

      const finished = events.find(
        (e): e is Extract<RunEvent, { type: 'tool_execution_finished' }> => e.type === 'tool_execution_finished'
      );
      assert.ok(finished);
      assert.equal(finished.speculativeHit, true);
    } finally {
      server.close();
    }
  });

  it('wires both speculative prefetch and shadowFs cleanly via createAgentRuntime', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-combo-'));
    const targetFile = path.join(dir, 'config.txt');
    writeFileSync(targetFile, 'v1', 'utf8');

    const model = new FakeModelAdapter();
    const { runtime, registry, store } = createAgentRuntime({
      modelAdapter: model,
      approvalMode: 'never',
      enableSpeculativePrefetch: true,
      shadowFs: { workspaceDir: dir },
    });

    registry.register({
      name: 'read_cfg',
      description: 'Read config',
      inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      sideEffect: 'none',
      requiredPermissions: [],
      async execute(args: { path: string }) {
        return { content: readFileSync(args.path, 'utf8') };
      },
    });

    registry.register({
      name: 'write_cfg',
      description: 'Write config',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        properties: { path: { type: 'string' }, content: { type: 'string' } },
      },
      sideEffect: 'non_idempotent',
      requiredPermissions: [],
      async execute(args: { path: string; content: string }) {
        writeFileSync(args.path, args.content, 'utf8');
        return { content: 'ok' };
      },
    });

    try {
      const session = await runtime.createSession({
        title: 'Combo Test',
        config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
      });

      const events: RunEvent[] = [];
      runtime.subscribe({ sessionId: session.id }, (e) => events.push(e));

      // Turn 1: speculative read
      model.enqueueStreamedDeltas({
        chunks: [
          {
            delta: {
              type: 'tool_call_delta',
              index: 0,
              toolCallId: 'c_read',
              toolName: 'read_cfg',
              argsDelta: JSON.stringify({ path: targetFile }),
            },
          },
          { delta: { type: 'text_delta', text: 'Inspecting...' }, delayMs: 40 },
        ],
        response: {
          content: [{ type: 'tool_call', toolCallId: 'c_read', toolName: 'read_cfg', args: { path: targetFile } }],
          finishReason: 'tool_use',
          usage: { inputTokens: 20, outputTokens: 10 },
          model: 'fake-model',
        },
      });
      model.enqueueText('Current is v1');
      await (await runtime.startRun({ sessionId: session.id, userInput: 'Check config', principal: TEST_PRINCIPAL })).result;

      const checkpointSeq = (await store.listMessages(session.id)).at(-1)!.seq;

      // Turn 2: mutating write
      model.enqueueToolCall('c_write', 'write_cfg', { path: targetFile, content: 'v2' });
      model.enqueueText('Updated to v2');
      await (await runtime.startRun({ sessionId: session.id, userInput: 'Update to v2', principal: TEST_PRINCIPAL })).result;

      assert.equal(readFileSync(targetFile, 'utf8'), 'v2');
      assert.ok(
        events.some((e) => e.type === 'tool_execution_finished' && e.toolCallId === 'c_read' && e.speculativeHit === true)
      );

      // Revert back to Turn 1 checkpoint
      const revertReport = await runtime.revertToSeq(session.id, checkpointSeq);
      assert.equal(readFileSync(targetFile, 'utf8'), 'v1');
      assert.deepEqual(revertReport.restoredFiles, [path.resolve(targetFile)]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pre-warms read tools from reasoning_delta before tool_call_delta and reports savedMs stats', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry } = makeLocalRuntime(model);

    let execCount = 0;
    registry.register({
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: { path: { type: 'string' } },
      },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { path: string }) {
        execCount++;
        await new Promise((r) => setTimeout(r, 45));
        return { content: `content:${args.path}` };
      },
    });

    model.enqueueStreamedDeltas({
      chunks: [
        { delta: { type: 'reasoning_delta', text: 'Let me inspect ' } },
        { delta: { type: 'reasoning_delta', text: 'config/base.json ' } },
        { delta: { type: 'reasoning_delta', text: 'first before answering.' }, delayMs: 80 },
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'call_reason_1',
            toolName: 'read_file',
            argsDelta: '{"path":"config/base.json"}',
          },
          delayMs: 10,
        },
      ],
      response: {
        content: [
          { type: 'tool_call', toolCallId: 'call_reason_1', toolName: 'read_file', args: { path: 'config/base.json' } },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 30, outputTokens: 20 },
        model: 'fake-model',
      },
    });
    model.enqueueText('Inspected config/base.json');

    const session = await runtime.createSession({
      title: 'Reasoning Warmup Test',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    const events: RunEvent[] = [];
    runtime.subscribe({ sessionId: session.id }, (e) => events.push(e));

    const outcome = await (
      await runtime.startRun({
        sessionId: session.id,
        userInput: 'Check config/base.json',
        principal: TEST_PRINCIPAL,
      })
    ).result;

    assert.equal(outcome.status, 'completed');
    assert.equal(execCount, 1, 'Promoted reasoning warmup should execute tool exactly once');
    assert.ok(outcome.speculativeStats);
    assert.equal(outcome.speculativeStats.hits, 1);
    assert.equal(outcome.speculativeStats.reasoningHits, 1);
    assert.equal(outcome.speculativeStats.toolDeltaHits, 0);
    assert.ok(outcome.speculativeStats.savedMs >= 25, `Expected savedMs >= 25, got ${outcome.speculativeStats.savedMs}`);

    const prefetch = events.find(
      (e): e is Extract<RunEvent, { type: 'tool_speculative_prefetched' }> =>
        e.type === 'tool_speculative_prefetched'
    );
    assert.ok(prefetch);
    assert.equal(prefetch.source, 'reasoning_intent');

    const finished = events.find(
      (e): e is Extract<RunEvent, { type: 'tool_execution_finished' }> =>
        e.type === 'tool_execution_finished'
    );
    assert.ok(finished);
    assert.equal(finished.speculativeHit, true);
    assert.equal(finished.speculativeSource, 'reasoning_intent');
    assert.ok((finished.savedMs ?? 0) >= 25);
  });

  it('executes contiguous read-only tool calls concurrently in executeToolBatch', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry } = makeLocalRuntime(model);

    registry.register({
      name: 'slow_read',
      description: 'Slow read-only op',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      sideEffect: 'none',
      requiredPermissions: [],
      async execute(args: { id: string }) {
        await new Promise((r) => setTimeout(r, 80));
        return { content: `ok:${args.id}` };
      },
    });

    model.enqueueResponse(() => ({
      content: [
        { type: 'tool_call', toolCallId: 'c1', toolName: 'slow_read', args: { id: '1' } },
        { type: 'tool_call', toolCallId: 'c2', toolName: 'slow_read', args: { id: '2' } },
        { type: 'tool_call', toolCallId: 'c3', toolName: 'slow_read', args: { id: '3' } },
      ],
      finishReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 20 },
      model: 'fake-model',
    }));
    model.enqueueText('All 3 done');

    const session = await runtime.createSession({
      title: 'Concurrent Read Batch',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    const t0 = Date.now();
    const outcome = await (
      await runtime.startRun({
        sessionId: session.id,
        userInput: 'Run 3 slow reads',
        principal: TEST_PRINCIPAL,
      })
    ).result;
    const wallMs = Date.now() - t0;

    assert.equal(outcome.status, 'completed');
    assert.ok(wallMs < 190, `Expected 3 x 80ms read calls to run concurrently (<190ms), took ${wallMs}ms`);
  });

  it('invalidates pre-write speculative reads across a mutating write barrier in the same step', async () => {
    const model = new FakeModelAdapter();
    const store = new SqliteSessionStore(':memory:');
    const bus = new InMemoryEventBus();
    const registry = new InMemoryToolRegistry();
    const policy = new DefaultPermissionPolicy('never');
    const executor = new StandardToolExecutor(registry, policy);
    const memory = new StandardMemoryManager(store);
    const loop = new AgentLoop({ store, model, registry, executor, memory, bus });
    const recovery = new RecoveryService(store, bus);
    const runtime = new AgentRuntime(store, loop, bus, recovery, 'barrier_worker');

    let state = 'v1';
    registry.register({
      name: 'read_state',
      description: 'Read state',
      inputSchema: { type: 'object', properties: {} },
      sideEffect: 'none',
      requiredPermissions: [],
      async execute() {
        return { content: state };
      },
    });
    registry.register({
      name: 'write_state',
      description: 'Write state',
      inputSchema: { type: 'object', required: ['val'], properties: { val: { type: 'string' } } },
      sideEffect: 'non_idempotent',
      requiredPermissions: [],
      async execute(args: { val: string }) {
        state = args.val;
        return { content: `set:${state}` };
      },
    });

    model.enqueueStreamedDeltas({
      chunks: [
        { delta: { type: 'reasoning_delta', text: 'Check system_info or read_state ' } },
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'r_before',
            toolName: 'read_state',
            argsDelta: '{}',
          },
        },
        {
          delta: {
            type: 'tool_call_delta',
            index: 2,
            toolCallId: 'r_after',
            toolName: 'read_state',
            argsDelta: '{}',
          },
          delayMs: 25,
        },
      ],
      response: {
        content: [
          { type: 'tool_call', toolCallId: 'r_before', toolName: 'read_state', args: {} },
          { type: 'tool_call', toolCallId: 'w_mid', toolName: 'write_state', args: { val: 'v2' } },
          { type: 'tool_call', toolCallId: 'r_after', toolName: 'read_state', args: {} },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 30, outputTokens: 20 },
        model: 'fake-model',
      },
    });
    model.enqueueText('Barrier checked');

    const session = await runtime.createSession({
      title: 'Write Barrier Test',
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });

    await (
      await runtime.startRun({
        sessionId: session.id,
        userInput: 'Read write read',
        principal: TEST_PRINCIPAL,
      })
    ).result;

    const msgs = await store.listMessages(session.id);
    const toolResults = msgs
      .filter((m) => m.role === 'tool')
      .flatMap((m) => m.content.filter((b): b is Extract<typeof b, { type: 'tool_result' }> => b.type === 'tool_result'));

    assert.equal(toolResults.find((r) => r.toolCallId === 'r_before')?.content, 'v1');
    assert.equal(toolResults.find((r) => r.toolCallId === 'w_mid')?.content, 'set:v2');
    assert.equal(toolResults.find((r) => r.toolCallId === 'r_after')?.content, 'v2');
    store.close();
  });
});
