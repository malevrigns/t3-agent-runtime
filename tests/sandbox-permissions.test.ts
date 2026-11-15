import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxPermissionPolicy } from '../src/tools/permissions.js';
import { inspectCommand, resolveProjectPath } from '../src/tools/sandbox.js';
import { StandardToolExecutor } from '../src/tools/executor.js';
import { InMemoryToolRegistry } from '../src/tools/registry.js';
import type { Principal } from '../src/core/types.js';
import type { ToolDefinition } from '../src/tools/ports.js';

const user: Principal = { id: 'u', kind: 'user', grants: ['fs:read', 'fs:write', 'shell:exec'] };

function policy(root: string, mode: 'default' | 'build' | 'plan' | 'yolo' = 'build') {
  return new SandboxPermissionPolicy(root, mode, 'ask_for_side_effects');
}

function tool(name: string, permissions: string[], sideEffect: ToolDefinition['sideEffect'] = 'none'): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    sideEffect,
    requiredPermissions: permissions,
    async execute() {
      return { content: 'ran' };
    },
  };
}

test('project sandbox permissions', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-sandbox-'));
  try {
    await t.test('build allows in-project reads and writes, and blocks protected paths', async () => {
      const gate = policy(root, 'build');
      const read = await gate.check({
        tool: tool('read_file', ['fs:read']),
        args: { path: 'src/app.ts' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(read.decision, 'allow');
      const write = await gate.check({
        tool: tool('write_file', ['fs:write'], 'non_idempotent'),
        args: { path: 'src/app.ts' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(write.decision, 'allow');
      const env = await gate.check({
        tool: tool('write_file', ['fs:write'], 'non_idempotent'),
        args: { path: '.env' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(env.decision, 'deny');
      const git = await gate.check({
        tool: tool('delete_file', ['fs:write'], 'non_idempotent'),
        args: { path: '.git/config' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(git.decision, 'deny');
      const example = await gate.check({
        tool: tool('edit_file', ['fs:write'], 'non_idempotent'),
        args: { path: '.env.example' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(example.decision, 'allow');
    });

    await t.test('default asks before an in-project write and before a secret read', async () => {
      const gate = policy(root, 'default');
      const write = await gate.check({
        tool: tool('write_file', ['fs:write'], 'non_idempotent'),
        args: { path: 'notes.md' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(write.decision, 'ask');
      const secret = await gate.check({
        tool: tool('read_file', ['fs:read']),
        args: { path: '.env' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(secret.decision, 'ask');
      gate.grant('s', 'read_file', { path: './.env' });
      const again = await gate.check({
        tool: tool('read_file', ['fs:read']),
        args: { path: '.env' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(again.decision, 'allow');
    });

    await t.test('paths outside the project ask, and plan mode stays read-only', async () => {
      const gate = policy(root, 'build');
      const outside = path.join(tmpdir(), 'outside.txt');
      const read = await gate.check({
        tool: tool('read_file', ['fs:read']),
        args: { path: outside },
        principal: user,
        sessionId: 's',
      });
      assert.equal(read.decision, 'ask');
      const plan = policy(root, 'plan');
      const write = await plan.check({
        tool: tool('write_file', ['fs:write'], 'non_idempotent'),
        args: { path: 'notes.md' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(write.decision, 'deny');
      const command = await plan.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'git status' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(command.decision, 'deny');
    });

    await t.test('bash allows ordinary project commands and blocks destructive ones', async () => {
      const gate = policy(root, 'build');
      const status = await gate.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'git status' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(status.decision, 'allow');
      const escape = await gate.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'cat ../secret.txt' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(escape.decision, 'ask');
      const wipe = await gate.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'rm -rf /' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(wipe.decision, 'deny');
      const yolo = policy(root, 'yolo');
      const still = await yolo.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'sudo rm -rf /' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(still.decision, 'deny');
      const envWrite = inspectCommand('echo hi > .env', root);
      assert.equal(envWrite.protectedWrite, true);
      const nested = await gate.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'bash -c "git status"' },
        principal: user,
        sessionId: 's',
      });
      assert.equal(nested.decision, 'ask');
    });

    await t.test('a missing grant is denied before the sandbox rule', async () => {
      const gate = policy(root, 'yolo');
      const denied = await gate.check({
        tool: tool('bash', ['shell:exec'], 'non_idempotent'),
        args: { command: 'git status' },
        principal: { id: 'u', kind: 'user', grants: [] },
        sessionId: 's',
      });
      assert.equal(denied.decision, 'deny');
    });

    await t.test('the executor does not run a protected write', async () => {
      const registry = new InMemoryToolRegistry();
      let ran = false;
      registry.register({
        name: 'write_file',
        description: 'write',
        inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
        sideEffect: 'non_idempotent',
        requiredPermissions: ['fs:write'],
        async execute() {
          ran = true;
          return { content: 'ran' };
        },
      });
      const executor = new StandardToolExecutor(registry, policy(root, 'build'));
      const result = await executor.execute(
        { toolCallId: 'c1', toolName: 'write_file', args: { path: '.env', content: 'SECRET=1' } },
        {
          sessionId: 's',
          runId: 'r',
          toolExecutionId: 't',
          idempotencyKey: 'k',
          principal: user,
          signal: new AbortController().signal,
        }
      );
      assert.equal(result.status, 'error');
      assert.equal(result.error?.code, 'PERMISSION_DENIED');
      assert.equal(ran, false);
    });

    await t.test('a symlink that leaves the project is outside', () => {
      const outsideDir = mkdtempSync(path.join(tmpdir(), 'pi-sandbox-out-'));
      const link = path.join(root, 'escape-link');
      try {
        symlinkSync(outsideDir, link, 'dir');
      } catch {
        return;
      }
      const resolved = resolveProjectPath(root, 'escape-link/secret.txt');
      assert.equal(resolved.outside, true);
      rmSync(outsideDir, { recursive: true, force: true });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('template env files stay writable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-sandbox-env-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, '.env.example'), 'A=1');
    const resolved = resolveProjectPath(root, '.env.example');
    assert.equal(resolved.protectedWrite, false);
    assert.equal(resolved.secret, false);
    const secret = resolveProjectPath(root, '.env');
    assert.equal(secret.protectedWrite, true);
    assert.equal(secret.secret, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
