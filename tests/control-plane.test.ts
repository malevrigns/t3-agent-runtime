import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import { SessionBusyError } from '../src/core/errors.js';
import type { Principal } from '../src/core/types.js';
import type { ModelRequest, ModelResponse } from '../src/model/ports.js';

const principal: Principal = {
  id: 'user_1',
  kind: 'user',
  grants: ['fs:read', 'fs:write'],
};

function text(content: string): ModelResponse {
  return {
    content: [{ type: 'text', text: content }],
    finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 5 },
    model: 'fake',
  };
}

test('approval, cancel, steer, and follow-up', async (t) => {
  const model = new FakeModelAdapter();
  const { runtime, registry, store } = createAgentRuntime({
    modelAdapter: model,
    approvalMode: 'ask_for_side_effects',
  });

  let writes = 0;
  let reads = 0;
  registry.register({
    name: 'write_file',
    description: 'Write a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    sideEffect: 'non_idempotent',
    requiredPermissions: ['fs:write'],
    async execute() {
      writes += 1;
      return { content: 'wrote' };
    },
  });
  registry.register({
    name: 'read_file',
    description: 'Read a file',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute() {
      reads += 1;
      return { content: 'contents' };
    },
  });

  await t.test('approval resumes the same run and keeps sibling tool calls', async () => {
    writes = 0;
    reads = 0;
    const session = await runtime.createSession({
      config: { model: 'fake', systemPrompt: 's', maxOutputTokens: 200 },
    });
    model.enqueueResponse(() => ({
      content: [
        { type: 'tool_call', toolCallId: 'w1', toolName: 'write_file', args: { path: 'a.ts' } },
        { type: 'tool_call', toolCallId: 'r1', toolName: 'read_file', args: { path: 'a.ts' } },
      ],
      finishReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 10 },
      model: 'fake',
    }));
    model.enqueueText('both tools finished');

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'update the file',
      principal,
    });
    const waiting = await handle.result;
    assert.equal(waiting.status, 'waiting_input');
    assert.equal(waiting.pendingInput?.kind, 'approval');
    assert.equal(writes, 0);
    assert.equal(reads, 0);

    await assert.rejects(
      runtime.startRun({ sessionId: session.id, userInput: 'other', principal }),
      (err: unknown) => err instanceof SessionBusyError
    );

    const resumed = await runtime.submitToolDecision(waiting.runId, 'approve', principal);
    const done = await resumed.result;
    assert.equal(done.status, 'completed');
    assert.equal(done.finalText, 'both tools finished');
    assert.equal(writes, 1);
    assert.equal(reads, 1);

    const messages = await store.listMessages(session.id);
    const results = messages.filter((message) => message.role === 'tool');
    assert.equal(results.length, 2);
  });

  await t.test('denial is visible to the model and does not run the tool', async () => {
    writes = 0;
    const session = await runtime.createSession({
      config: { model: 'fake', systemPrompt: 's', maxOutputTokens: 200 },
    });
    model.enqueueToolCall('w2', 'write_file', { path: 'b.ts' });
    model.enqueueResponse((req: ModelRequest) => {
      const blob = JSON.stringify(req.messages);
      assert.match(blob, /User denied execution/);
      return text('stopped');
    });

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'write it',
      principal,
    });
    const waiting = await handle.result;
    assert.equal(waiting.status, 'waiting_input');
    const resumed = await runtime.submitToolDecision(waiting.runId, 'deny', principal);
    const done = await resumed.result;
    assert.equal(done.status, 'completed');
    assert.equal(done.finalText, 'stopped');
    assert.equal(writes, 0);
  });

  await t.test('cancelling a waiting run unlocks the session and returns queued input', async () => {
    const session = await runtime.createSession({
      config: { model: 'fake', systemPrompt: 's', maxOutputTokens: 200 },
    });
    model.enqueueToolCall('w3', 'write_file', { path: 'c.ts' });
    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'write more',
      principal,
    });
    const waiting = await handle.result;
    assert.equal(waiting.status, 'waiting_input');

    const pushed = await runtime.steer(session.id, 'do this instead', principal);
    assert.equal(pushed.queued, true);

    const released = await runtime.cancelRun(waiting.runId);
    assert.equal(released.length, 1);
    assert.equal(released[0].content[0].type, 'text');
    if (released[0].content[0].type === 'text') {
      assert.equal(released[0].content[0].text, 'do this instead');
    }

    const run = await store.getRun(waiting.runId);
    assert.equal(run?.status, 'cancelled');
    const messages = await store.listMessages(session.id);
    assert.ok(messages.some((message) => message.role === 'tool' && message.synthetic));

    model.enqueueText('fresh');
    const next = await runtime.startRun({
      sessionId: session.id,
      userInput: 'new question',
      principal,
    });
    const done = await next.result;
    assert.equal(done.status, 'completed');
    assert.equal(done.finalText, 'fresh');
    const transcript = JSON.stringify(await store.listMessages(session.id));
    assert.equal(transcript.includes('do this instead'), false);
  });

  await t.test('steer enters before the next model call', async () => {
    const session = await runtime.createSession({
      config: { model: 'fake', systemPrompt: 's', maxOutputTokens: 200 },
    });
    model.enqueueToolCall('r2', 'read_file', { path: 'd.ts' });
    model.enqueueResponse((req: ModelRequest) => {
      assert.match(JSON.stringify(req.messages), /use 7 instead/);
      return text('adjusted');
    });
    const originalExecute = registry.get('read_file')!.def.execute;
    registry.get('read_file')!.def.execute = async (args, ctx) => {
      await runtime.steer(session.id, 'use 7 instead', principal);
      return originalExecute(args, ctx);
    };

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'read it',
      principal,
    });
    const done = await handle.result;
    assert.equal(done.finalText, 'adjusted');
    registry.get('read_file')!.def.execute = originalExecute;
  });

  await t.test('follow-up continues after a final answer', async () => {
    const session = await runtime.createSession({
      config: { model: 'fake', systemPrompt: 's', maxOutputTokens: 200 },
    });
    model.enqueueResponse(async () => {
      await runtime.followUp(session.id, 'count files', principal);
      return text('first answer');
    });
    model.enqueueText('there are 3 files');

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'look around',
      principal,
    });
    const done = await handle.result;
    assert.equal(done.status, 'completed');
    assert.equal(done.finalText, 'there are 3 files');
  });
});
