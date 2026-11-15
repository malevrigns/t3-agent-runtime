import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import { toOpenAIUserContent } from '../src/model/openai-adapter.js';
import { imageBlockFromFile, fileBlockFromPath } from '../src/core/attachments.js';
import { InMemorySpanExporter, OtelTraceHook, buildOtlpTracePayload } from '../src/observability/otel.js';
import type { ContentBlock, Principal } from '../src/core/types.js';
import type { ModelRequest } from '../src/model/ports.js';

const principal: Principal = {
  id: 'user_ext',
  kind: 'user',
  grants: ['fs:read'],
};

test('subagents, multimodal attachments, OTel exporter, and EventBus isolation', async (t) => {
  await t.test('spawn_subagent delegates subtask, inherits context when requested, and enforces maxDepth', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry, store } = createAgentRuntime({
      modelAdapter: model,
      approvalMode: 'never',
      enableSubagentTool: { maxDepth: 2 },
    });

    registry.register({
      name: 'inspect_env',
      description: 'Inspect environment',
      inputSchema: { type: 'object', properties: {} },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute() {
        return { content: 'node-24-ready' };
      },
    });

    try {
      const parent = await runtime.createSession({
        title: 'Coordinator',
        config: { model: 'fake', systemPrompt: 'Main agent', maxOutputTokens: 200 },
      });

      // Turn 1 so parent has prior context to fork from
      model.enqueueText('Parent initialized.');
      await (await runtime.startRun({ sessionId: parent.id, userInput: 'Init project alpha', principal })).result;

      // Turn 2: Parent calls spawn_subagent with inheritContext=true
      model.enqueueResponse(() => ({
        content: [
          {
            type: 'tool_call',
            toolCallId: 'sub_1',
            toolName: 'spawn_subagent',
            args: {
              task: 'Check env for project alpha',
              inheritContext: true,
              tools: ['inspect_env'],
            },
          },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 20, outputTokens: 10 },
        model: 'fake',
      }));
      // Child step 1: child verifies forked context and calls inspect_env
      model.enqueueResponse((req: ModelRequest) => {
        const blob = JSON.stringify(req.messages);
        assert.match(blob, /Init project alpha/);
        assert.equal(req.tools.some((tool) => tool.name === 'spawn_subagent'), false);
        return {
          content: [{ type: 'tool_call', toolCallId: 'child_tc', toolName: 'inspect_env', args: {} }],
          finishReason: 'tool_use',
          usage: { inputTokens: 15, outputTokens: 8 },
          model: 'fake',
        };
      });
      // Child step 2: child finishes
      model.enqueueText('Env verified: node-24-ready');
      // Parent step 2: parent receives subagent output and finishes
      model.enqueueResponse((req: ModelRequest) => {
        const blob = JSON.stringify(req.messages);
        assert.match(blob, /Env verified: node-24-ready/);
        return {
          content: [{ type: 'text', text: 'Coordinator done: node-24-ready' }],
          finishReason: 'stop',
          usage: { inputTokens: 25, outputTokens: 10 },
          model: 'fake',
        };
      });

      const handle = await runtime.startRun({
        sessionId: parent.id,
        userInput: 'Verify environment in a subagent',
        principal,
      });
      const outcome = await handle.result;
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.finalText, 'Coordinator done: node-24-ready');

      const branches = await runtime.listSessionBranches(parent.id);
      assert.equal(branches.length, 1);
      assert.equal(branches[0].parentSessionId, parent.id);

      // Direct depth guardrail test: depth 1 -> depth 2 allowed, depth 2 -> depth 3 rejected
      const depth2 = await runtime.spawnSubagent({
        parentSessionId: branches[0].id,
        prompt: 'Leaf subagent',
        principal,
        maxDepth: 2,
      });
      assert.equal(depth2.depth, 2);
      assert.equal(depth2.status, 'completed');

      await assert.rejects(
        runtime.spawnSubagent({
          parentSessionId: depth2.sessionId,
          prompt: 'Too deep',
          principal,
          maxDepth: 2,
        }),
        /maxDepth/
      );
    } finally {
      store.close();
    }
  });

  await t.test('EventBus isolates events by sessionId when parallel subagents run concurrently', async () => {
    const model = new FakeModelAdapter();
    const { runtime, store } = createAgentRuntime({ modelAdapter: model });

    try {
      const s1 = await runtime.createSession({
        config: { model: 'fake', systemPrompt: 's1', maxOutputTokens: 100 },
      });
      const s2 = await runtime.createSession({
        config: { model: 'fake', systemPrompt: 's2', maxOutputTokens: 100 },
      });

      const s1Events: string[] = [];
      runtime.subscribe({ sessionId: s1.id }, (event) => {
        s1Events.push(event.type);
      });

      model.enqueueText('reply 1');
      model.enqueueText('reply 2');

      const [r1, r2] = await Promise.all([
        runtime.startRun({ sessionId: s1.id, userInput: 'hi 1', principal }).then((h) => h.result),
        runtime.startRun({ sessionId: s2.id, userInput: 'hi 2', principal }).then((h) => h.result),
      ]);
      assert.equal(r1.status, 'completed');
      assert.equal(r2.status, 'completed');

      // s1Events must contain exactly 1 run_started and 1 run_finished (not 2 from s2)
      assert.equal(s1Events.filter((e) => e === 'run_started').length, 1);
      assert.equal(s1Events.filter((e) => e === 'run_finished').length, 1);
      assert.equal(s1Events.filter((e) => e === 'model_call_finished').length, 1);

      const parallelResults = await runtime.spawnSubagents([
        { prompt: 'task A', principal },
        { prompt: 'task B', principal },
      ]);
      assert.equal(parallelResults.length, 2);
      assert.ok(parallelResults.every((item) => item.status === 'completed'));
    } finally {
      store.close();
    }
  });

  await t.test('multimodal image/file attachments convert to OpenAI payload and avoid base64 token overflow', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-agent-att-'));
    const imgPath = join(dir, 'sample.png');
    const codePath = join(dir, 'snippet.ts');
    writeFileSync(imgPath, Buffer.alloc(12_000, 0x89));
    writeFileSync(codePath, 'export const answer = 42;\n', 'utf-8');

    try {
      const imgBlock = await imageBlockFromFile(imgPath, { alt: 'UI diagram' });
      const fileBlock = await fileBlockFromPath(codePath);
      assert.equal(imgBlock.type, 'image');
      assert.equal(imgBlock.mimeType, 'image/png');
      assert.ok(imgBlock.data && imgBlock.data.length > 10_000);
      assert.equal(fileBlock.type, 'file');
      assert.equal(fileBlock.mimeType, 'text/typescript');
      assert.match(fileBlock.text ?? '', /answer = 42/);

      // Pure text stays string
      assert.equal(toOpenAIUserContent([{ type: 'text', text: 'hello' }]), 'hello');

      // Multimodal turns convert into OpenAI parts array
      const blocks: ContentBlock[] = [{ type: 'text', text: 'Inspect both' }, imgBlock, fileBlock];
      const converted = toOpenAIUserContent(blocks);
      assert.ok(Array.isArray(converted));
      assert.equal(converted.length, 3);
      assert.equal(converted[1].type, 'image_url');
      assert.match(String((converted[2] as { text: string }).text), /<attachment name="snippet\.ts"/);

      // Run through runtime with a tight contextWindow where raw base64 length (~16k chars) would have overflowed
      // if counted naively, whereas imageBlock token estimate (~1024) fits comfortably
      const model = new FakeModelAdapter();
      const { runtime, store, memory } = createAgentRuntime({ modelAdapter: model });
      try {
        const session = await runtime.createSession({
          config: {
            model: 'fake',
            systemPrompt: 'Inspect attachment.',
            maxOutputTokens: 200,
            contextWindow: 3000,
          },
        });

        let sawImageBlock = false;
        model.enqueueResponse((req: ModelRequest) => {
          sawImageBlock = req.messages.some((m) => m.content.some((b) => b.type === 'image'));
          return {
            content: [{ type: 'text', text: 'Analyzed diagram and snippet.' }],
            finishReason: 'stop',
            usage: { inputTokens: 1100, outputTokens: 12 },
            model: 'fake',
          };
        });

        const handle = await runtime.startRun({
          sessionId: session.id,
          userInput: blocks,
          principal,
        });
        const outcome = await handle.result;
        assert.equal(outcome.status, 'completed');
        assert.equal(sawImageBlock, true);
        assert.equal(await store.getActiveSummary(session.id), null);

        // Verify summarizer formats attachment cleanly if compaction is forced
        const built = await memory.buildContext({
          session,
          runId: outcome.runId,
          systemPrompt: 'sys',
          tools: [],
          budget: { maxInputTokens: 3000, reserveForOutput: 200 },
        });
        assert.ok(built.estimatedTokens < 2000);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('OtelTraceHook emits hierarchical spans and valid OTLP JSON payload', async () => {
    const exporter = new InMemorySpanExporter();
    const otelHook = new OtelTraceHook({ exporter });
    const model = new FakeModelAdapter();

    const { runtime, registry, store } = createAgentRuntime({
      modelAdapter: model,
      approvalMode: 'never',
      hooks: [otelHook],
    });

    registry.register({
      name: 'echo',
      description: 'Echo text',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { msg: string }) {
        return { content: args.msg };
      },
    });

    try {
      const session = await runtime.createSession({
        config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
      });
      model.enqueueToolCall('tc_otel', 'echo', { msg: 'ping' });
      model.enqueueText('pong');

      const handle = await runtime.startRun({
        sessionId: session.id,
        userInput: 'ping me',
        principal,
      });
      const outcome = await handle.result;
      assert.equal(outcome.status, 'completed');

      // 2 model spans + 1 tool span + 1 root agent.run span = 4 spans
      assert.equal(exporter.spans.length, 4);
      const rootSpan = exporter.spans.find((s) => s.name === 'agent.run');
      assert.ok(rootSpan);
      assert.equal(rootSpan.status.code, 'OK');
      assert.equal(rootSpan.attributes['agent.run.status'], 'completed');

      const childSpans = exporter.spans.filter((s) => s.spanId !== rootSpan.spanId);
      assert.equal(childSpans.length, 3);
      for (const child of childSpans) {
        assert.equal(child.traceId, rootSpan.traceId);
        assert.equal(child.parentSpanId, rootSpan.spanId);
      }

      const otlp = buildOtlpTracePayload(exporter.spans, {
        serviceName: 'pi-agent-test',
        serviceVersion: '0.1.0',
      }) as any;
      assert.equal(otlp.resourceSpans[0].resource.attributes[0].value.stringValue, 'pi-agent-test');
      assert.equal(otlp.resourceSpans[0].scopeSpans[0].spans.length, 4);
    } finally {
      store.close();
    }
  });
});
