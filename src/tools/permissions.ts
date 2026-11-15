import type { PermissionPolicy, ToolDefinition } from './ports.js';
import type { Principal } from '../core/types.js';
import {
  inspectCommand,
  parseSandboxMode,
  resolveProjectPath,
  type SandboxMode,
} from './sandbox.js';

export { parseSandboxMode, type SandboxMode };

const READ_TOOLS = new Set(['read_file', 'list_files', 'grep_files']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
const BASH_TOOLS = new Set(['bash']);

type Checked = { decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string };

function pathArg(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'dir', 'file']) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key];
  }
  return undefined;
}

function commandArg(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const command = (args as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

/**
 * Project-boundary policy in the shape Pi uses for everyday coding.
 * Deny wins over ask, and ask wins over allow. A session grant can satisfy ask, never deny.
 */
export class SandboxPermissionPolicy implements PermissionPolicy {
  private readonly grants = new Map<string, Set<string>>();

  constructor(
    private readonly projectRoot: string,
    private mode: SandboxMode = 'build',
    private readonly approvalMode: 'always' | 'ask_for_side_effects' | 'never' = 'ask_for_side_effects'
  ) {}

  get currentMode(): SandboxMode {
    return this.mode;
  }

  setMode(mode: SandboxMode): void {
    this.mode = mode;
  }

  grant(sessionId: string, toolName: string, args: unknown): void {
    const key = this.grantKey(toolName, args);
    if (!key) return;
    const existing = this.grants.get(sessionId) ?? new Set<string>();
    existing.add(key);
    this.grants.set(sessionId, existing);
  }

  clearGrants(sessionId?: string): void {
    if (sessionId) this.grants.delete(sessionId);
    else this.grants.clear();
  }

  async check(input: {
    tool: ToolDefinition;
    args: unknown;
    principal: Principal;
    sessionId: string;
  }): Promise<Checked> {
    const missing = missingGrant(input.tool, input.principal);
    if (missing) return missing;

    const ruled = this.rule(input.tool.name, input.args);
    if (ruled) {
      if (ruled.decision === 'ask' && this.hasGrant(input.sessionId, input.tool.name, input.args)) {
        return { decision: 'allow' };
      }
      return ruled;
    }

    if (this.approvalMode === 'always') {
      return { decision: 'ask', reason: 'Policy requires approval for all tool executions' };
    }
    if (this.approvalMode === 'ask_for_side_effects' && input.tool.sideEffect === 'non_idempotent') {
      return { decision: 'ask', reason: `Tool ${input.tool.name} has non-idempotent side effects and requires approval` };
    }
    return { decision: 'allow' };
  }

  private hasGrant(sessionId: string, toolName: string, args: unknown): boolean {
    const key = this.grantKey(toolName, args);
    return key != null && (this.grants.get(sessionId)?.has(key) ?? false);
  }

  private grantKey(toolName: string, args: unknown): string | null {
    if (BASH_TOOLS.has(toolName)) {
      const command = commandArg(args).trim();
      return command ? `bash:${command}` : null;
    }
    if (!READ_TOOLS.has(toolName) && !WRITE_TOOLS.has(toolName)) return null;
    const raw = pathArg(args) ?? (toolName === 'list_files' ? '.' : '');
    if (!raw) return null;
    const resolved = resolveProjectPath(this.projectRoot, raw);
    const surface = WRITE_TOOLS.has(toolName) ? 'write' : 'read';
    return `${surface}:${resolved.absolute}`;
  }

  private rule(toolName: string, args: unknown): Checked | null {
    if (READ_TOOLS.has(toolName)) return this.readRule(pathArg(args) ?? '.');
    if (WRITE_TOOLS.has(toolName)) {
      const target = pathArg(args);
      if (!target) return { decision: 'deny', reason: 'A path is required' };
      return this.writeRule(target);
    }
    if (BASH_TOOLS.has(toolName)) return this.bashRule(commandArg(args));
    return null;
  }

  private readRule(target: string): Checked {
    const resolved = resolveProjectPath(this.projectRoot, target);
    if (this.mode === 'yolo') return { decision: 'allow' };
    if (resolved.secret) return { decision: 'ask', reason: `Reading a secret needs approval: ${target}` };
    if (resolved.outside) return { decision: 'ask', reason: `Path is outside the project: ${target}` };
    return { decision: 'allow' };
  }

  private writeRule(target: string): Checked {
    const resolved = resolveProjectPath(this.projectRoot, target);
    if (resolved.protectedWrite && this.mode !== 'yolo') {
      return { decision: 'deny', reason: `Path is protected: ${target}` };
    }
    if (this.mode === 'yolo') return { decision: 'allow' };
    if (this.mode === 'plan') return { decision: 'deny', reason: 'Plan mode only allows reads' };
    if (resolved.outside) return { decision: 'ask', reason: `Writing outside the project needs approval: ${target}` };
    if (this.mode === 'default') return { decision: 'ask', reason: `Writing inside the project needs approval: ${target}` };
    return { decision: 'allow' };
  }

  private bashRule(command: string): Checked {
    const inspected = inspectCommand(command, this.projectRoot);
    if (inspected.empty) return { decision: 'deny', reason: 'Command is empty' };
    if (inspected.catastrophic) return { decision: 'deny', reason: 'Command is blocked' };
    if (this.mode === 'plan') return { decision: 'deny', reason: 'Plan mode does not run commands' };
    if (inspected.protectedWrite && this.mode !== 'yolo') {
      return { decision: 'deny', reason: 'Command would modify a protected path' };
    }
    if (this.mode === 'yolo') return { decision: 'allow' };
    if (inspected.opaque) return { decision: 'ask', reason: `Nested shell needs approval: ${command.trim()}` };
    if (inspected.outside) return { decision: 'ask', reason: `Command reaches outside the project: ${command.trim()}` };
    if (inspected.secret) return { decision: 'ask', reason: `Command touches a secret: ${command.trim()}` };
    if (inspected.dangerous || this.mode === 'default') {
      return { decision: 'ask', reason: `Command needs approval: ${command.trim()}` };
    }
    return { decision: 'allow' };
  }
}

function missingGrant(tool: ToolDefinition, principal: Principal): Checked | null {
  const userGrants = new Set(principal.grants);
  for (const req of tool.requiredPermissions) {
    if (!userGrants.has(req) && !userGrants.has('*')) {
      return { decision: 'deny', reason: `Missing required permission grant: ${req}` };
    }
  }
  return null;
}

export class DefaultPermissionPolicy implements PermissionPolicy {
  constructor(private approvalMode: 'always' | 'ask_for_side_effects' | 'never' = 'ask_for_side_effects') {}

  async check(input: {
    tool: ToolDefinition;
    args: unknown;
    principal: Principal;
    sessionId: string;
  }): Promise<{ decision: 'allow' } | { decision: 'deny'; reason: string } | { decision: 'ask'; reason: string }> {
    // 1. 检查权限 grants
    const userGrants = new Set(input.principal.grants);
    for (const req of input.tool.requiredPermissions) {
      if (!userGrants.has(req) && !userGrants.has('*')) {
        return { decision: 'deny', reason: `Missing required permission grant: ${req}` };
      }
    }

    // 2. 审批策略
    if (this.approvalMode === 'always') {
      return { decision: 'ask', reason: `Policy requires approval for all tool executions` };
    }

    if (this.approvalMode === 'ask_for_side_effects' && input.tool.sideEffect === 'non_idempotent') {
      return { decision: 'ask', reason: `Tool ${input.tool.name} has non-idempotent side effects and requires approval` };
    }

    return { decision: 'allow' };
  }
}
