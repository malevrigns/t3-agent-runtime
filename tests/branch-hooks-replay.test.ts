import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../src/composition.js';
import { FakeModelAdapter } from '../src/model/fake-adapter.js';
import { ReplayModelAdapter } from '../src/runtime/trajectory.js';
import type { RuntimeHook } from '../src/runtime/hooks.js';
import type { Principal } from '../src/core/types.js';
import type { ModelRequest } from '../src/model/ports.js';

const principal: Principal = {
  id: 'user_branch',
  kind: 'user',
  grants: ['math:calc', 'fs:read'],
};

test('session branching, lifecycle hooks, and trajectory replay', async (t) => {
  await t.test('forkSession branches at an earlier seq without mutating parent history', async () => {
    const model = new FakeModelAdapter();
    const { runtime, store } = createAgentRuntime({ modelAdapter: model });

    try {
      const parent = await runtime.createSession({
        title: 'Main Session',
        config: { model: 'fake', systemPrompt: 'sys', maxOutputTokens: 200 },
      });

      model.enqueueText('First reply');
      const r1 = await runtime.startRun({ sessionId: parent.id, userInput: 'Turn 1', principal });
      await r1.result;

      model.enqueueText('Second reply');
      const r2 = await runtime.startRun({ sessionId: parent.id, userInput: 'Turn 2', principal });
      await r2.result;

      const parentMessages = await store.listMessages(parent.id);
      assert.equal(parentMessages.length, 4);

      const fork = await runtime.forkSession(parent.id, { atSeq: 2, title: 'Alt Branch' });
      assert.equal(fork.parentSessionId, parent.id);
      assert.equal(fork.forkedFromSeq, 2);
      assert.equal(fork.title, 'Alt Branch');
      assert.equal(fork.nextSeq, 3);

      const branches = await runtime.listSessionBranches(parent.id);
      assert.equal(branches.length, 1);
      assert.equal(branches[0].id, fork.id);

      model.enqueueResponse((req: ModelRequest) => {
        const serialized = JSON.stringify(req.messages);
        assert.match(serialized, /Turn 1/);
        assert.match(serialized, /First reply/);
        assert.equal(serialized.includes('Turn 2'), false);
        return {
          content: [{ type: 'text', text: 'Branched reply' }],
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 6 },
          model: 'fake',
        };
      });

      const rFork = await runtime.startRun({
        sessionId: fork.id,
        userInput: 'Different branch question',
        principal,
      });
      const forkOutcome = await rFork.result;
      assert.equal(forkOutcome.status, 'completed');
      assert.equal(forkOutcome.finalText, 'Branched reply');

      const parentAfter = await store.listMessages(parent.id);
      const forkAfter = await store.listMessages(fork.id);
      assert.equal(parentAfter.length, 4);
      assert.equal(forkAfter.length, 4);
      assert.match(JSON.stringify(forkAfter[2].content), /Different branch question/);
      assert.match(JSON.stringify(parentAfter[2].content), /Turn 2/);
    } finally {
      store.close();
    }
  });

  await t.test('RuntimeHook intercepts model calls, rewrites/blocks tool calls, and observes run finish', async () => {
    const model = new FakeModelAdapter();
    const events: string[] = [];
    const hook: RuntimeHook = {
      name: 'policy-guard',
      beforeModelCall({ request }) {
        events.push('beforeModelCall');
        return {
          ...request,
          system: `${request.system}\n[hook-injected]`,
        };
      },
      afterModelCall({ response }) {
        events.push(`afterModelCall:${response.finishReason}`);
      },
      beforeToolCall({ call }) {
        events.push(`beforeToolCall:${call.toolName}`);
        const args = call.args as { expr?: string };
        if (args.expr === 'forbidden') {
          return { action: 'block', reason: 'Expression not permitted by policy-guard' };
        }
        return { action: 'allow', args: { expr: '2+2' } };
      },
      afterToolCall({ result }) {
        events.push(`afterToolCall:${result.status}`);
      },
      onRunFinished({ outcome }) {
        events.push(`onRunFinished:${outcome.status}`);
      },
    };

    const { runtime, registry, store } = createAgentRuntime({
      modelAdapter: model,
      approvalMode: 'never',
      hooks: [hook],
    });

    try {
      const executedExprs: string[] = [];
      registry.register({
        name: 'calc',
        description: 'Calc',
        inputSchema: { type: 'object', properties: { expr: { type: 'string' } } },
        sideEffect: 'none',
        requiredPermissions: ['math:calc'],
        async execute(args: { expr: string }) {
          executedExprs.push(args.expr);
          return { content: `ans=${args.expr}` };
        },
      });

      const session = await runtime.createSession({
        config: { model: 'fake', systemPrompt: 'sys', maxOutputTokens: 200 },
      });

      model.enqueueResponse((req: ModelRequest) => {
        assert.match(req.system, /\[hook-injected\]/);
        return {
          content: [
            { type: 'tool_call', toolCallId: 'c1', toolName: 'calc', args: { expr: '1+1' } },
            { type: 'tool_call', toolCallId: 'c2', toolName: 'calc', args: { expr: 'forbidden' } },
          ],
          finishReason: 'tool_use',
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'fake',
        };
      });
      model.enqueueResponse((req: ModelRequest) => {
        const blob = JSON.stringify(req.messages);
        assert.match(blob, /ans=2\+2/);
        assert.match(blob, /Blocked by hook 'policy-guard'/);
        return {
          content: [{ type: 'text', text: 'handled rewrite and block' }],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'fake',
        };
      });

      const handle = await runtime.startRun({
        sessionId: session.id,
        userInput: 'run both',
        principal,
      });
      const outcome = await handle.result;
      assert.equal(outcome.status, 'completed');
      assert.equal(outcome.finalText, 'handled rewrite and block');
      assert.deepEqual(executedExprs, ['2+2']);
      assert.deepEqual(events, [
        'beforeModelCall',
        'afterModelCall:tool_use',
        'beforeToolCall:calc',
        'afterToolCall:success',
        'beforeToolCall:calc',
        'afterToolCall:error',
        'beforeModelCall',
        'afterModelCall:stop',
        'onRunFinished:completed',
      ]);
    } finally {
      store.close();
    }
  });

  await t.test('exportTrajectory captures execution trace and ReplayModelAdapter replays deterministically', async () => {
    const model = new FakeModelAdapter();
    const { runtime, registry, store } = createAgentRuntime({
      modelAdapter: model,
      approvalMode: 'never',
    });

    registry.register({
      name: 'lookup',
      description: 'Lookup value',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { key: string }) {
        return { content: `value:${args.key}` };
      },
    });

    const session = await runtime.createSession({
      config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
    });
    model.enqueueToolCall('tc_1', 'lookup', { key: 'version' });
    model.enqueueText('Version is value:version');

    const handle = await runtime.startRun({
      sessionId: session.id,
      userInput: 'What is the version?',
      principal,
    });
    const originalOutcome = await handle.result;
    assert.equal(originalOutcome.status, 'completed');

    const trajectory = await runtime.exportTrajectory(originalOutcome.runId);
    assert.equal(trajectory.version, 1);
    assert.equal(trajectory.modelSteps.length, 2);
    assert.equal(trajectory.toolExecutions.length, 1);
    assert.equal(trajectory.toolExecutions[0].toolName, 'lookup');
    assert.ok(trajectory.events.length >= 4);
    store.close();

    // Replay into an independent fresh runtime
    const replayAdapter = new ReplayModelAdapter(trajectory, { strictModelName: true });
    const replayed = createAgentRuntime({
      modelAdapter: replayAdapter,
      approvalMode: 'never',
    });
    replayed.registry.register({
      name: 'lookup',
      description: 'Lookup value',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
      sideEffect: 'none',
      requiredPermissions: ['fs:read'],
      async execute(args: { key: string }) {
        return { content: `value:${args.key}` };
      },
    });

    try {
      const replaySession = await replayed.runtime.createSession({
        config: { model: 'fake-model', systemPrompt: 'sys', maxOutputTokens: 200 },
      });
      const replayHandle = await replayed.runtime.startRun({
        sessionId: replaySession.id,
        userInput: 'What is the version?',
        principal,
      });
      const replayOutcome = await replayHandle.result;
      assert.equal(replayOutcome.status, 'completed');
      assert.equal(replayOutcome.finalText, originalOutcome.finalText);
      assert.equal(replayAdapter.remainingSteps, 0);
    } finally {
      replayed.store.close();
    }
  });
});
