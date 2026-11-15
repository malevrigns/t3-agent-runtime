import type { ToolContext, ToolDefinition } from '../tools/ports.js';
import { DomainError } from '../core/errors.js';
import type { LongTermMemory, MemoryRecord, MemoryScope } from './ports.js';

type MemoryToolScope = 'session' | 'user' | 'global';

function scopeOf(scope: MemoryToolScope | undefined, ctx: ToolContext): { scopeType: MemoryScope; scopeId: string } {
  if (scope === 'user') return { scopeType: 'user', scopeId: ctx.principal.id };
  if (scope === 'global') return { scopeType: 'global', scopeId: 'global' };
  return { scopeType: 'session', scopeId: ctx.sessionId };
}

export interface MemoryToolOptions {
  /** Agent id bound to a session. Unset or mismatched agent memories cannot be edited. */
  agentIdForSession?: (sessionId: string) => Promise<string | undefined>;
}

async function rejectForeign(
  record: MemoryRecord,
  ctx: ToolContext,
  options: MemoryToolOptions | undefined
): Promise<string | null> {
  if (record.scopeType === 'session' && record.scopeId !== ctx.sessionId) {
    return 'That memory belongs to another session';
  }
  if (record.scopeType === 'user' && record.scopeId !== ctx.principal.id) {
    return 'That memory belongs to another user';
  }
  if (record.scopeType === 'agent') {
    const agentId = options?.agentIdForSession ? await options.agentIdForSession(ctx.sessionId) : undefined;
    if (!agentId || record.scopeId !== agentId) {
      return 'That memory belongs to another agent';
    }
  }
  return null;
}

async function loadOwned(
  memory: LongTermMemory,
  id: string,
  ctx: ToolContext,
  options: MemoryToolOptions | undefined
): Promise<MemoryRecord | string> {
  const history = await memory.history(id);
  const record = history.find((item) => item.id === id);
  if (!record) return `Memory ${id} not found`;
  const rejected = await rejectForeign(record, ctx, options);
  if (rejected) return rejected;
  return record;
}

function asError(err: unknown): string {
  if (err instanceof DomainError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Memory tool failed';
}

export function createMemoryTools(memory: LongTermMemory, options?: MemoryToolOptions): ToolDefinition[] {
  const remember: ToolDefinition = {
    name: 'memory_remember',
    description: 'Store a durable fact, preference, or decision. Repeating the same wording reinforces the existing memory instead of duplicating it.',
    inputSchema: {
      type: 'object',
      required: ['content'],
      properties: {
        content: { type: 'string' },
        kind: { type: 'string' },
        scope: { type: 'string' },
        pin: { type: 'boolean' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: [],
    async execute(args: { content?: string; kind?: string; scope?: string; pin?: boolean }, ctx: ToolContext) {
      const content = args.content?.trim() ?? '';
      if (content.length < 2) return { content: 'content is required', isError: true };
      const scopeName: MemoryToolScope = args.scope === 'user' || args.scope === 'global' ? args.scope : 'session';
      const binding = scopeOf(scopeName, ctx);
      try {
        const saved = await memory.remember({
          scopeType: binding.scopeType,
          scopeId: binding.scopeId,
          kind: args.kind?.trim() || 'fact',
          content,
          sourceType: 'user_explicit',
          sourceSessionId: ctx.sessionId,
          confidence: 0.9,
          salience: args.pin ? 0.95 : 0.7,
          pinned: args.pin === true,
          createdBy: ctx.principal.id,
        });
        const reinforced = saved.accessCount > 0;
        return {
          content: reinforced
            ? `Reinforced memory ${saved.id}: ${saved.content}`
            : `Stored memory ${saved.id}: ${saved.content}`,
          data: { id: saved.id, reinforced, scopeType: saved.scopeType },
        };
      } catch (err) {
        return { content: asError(err), isError: true };
      }
    },
  };

  const recall: ToolDefinition = {
    name: 'memory_recall',
    description: 'Search durable memories visible to this session, this user, this agent, and the global scope. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    sideEffect: 'none',
    requiredPermissions: [],
    async execute(args: { query?: string; limit?: number }, ctx: ToolContext) {
      const limit = Math.max(1, Math.min(20, args.limit ?? 8));
      const agentId = options?.agentIdForSession ? await options.agentIdForSession(ctx.sessionId) : undefined;
      const bindings: Array<{ scopeType: MemoryScope; scopeId: string }> = [
        { scopeType: 'session', scopeId: ctx.sessionId },
        { scopeType: 'user', scopeId: ctx.principal.id },
        { scopeType: 'global', scopeId: 'global' },
      ];
      if (agentId) bindings.push({ scopeType: 'agent', scopeId: agentId });
      const records = await memory.recall({
        scopes: bindings.map((binding) => binding.scopeType),
        bindings,
        query: args.query?.trim() || undefined,
        limit,
      });
      if (records.length === 0) return { content: 'No matching memories.', data: { memories: [] } };
      const lines = records.map((record) => `- ${record.id} [${record.scopeType}/${record.kind}] ${record.content}`);
      return { content: lines.join('\n'), data: { memories: records.map((record) => ({ id: record.id, content: record.content, scopeType: record.scopeType, kind: record.kind })) } };
    },
  };

  const correct: ToolDefinition = {
    name: 'memory_correct',
    description: 'Replace a memory with a corrected version and keep the old revision in history.',
    inputSchema: {
      type: 'object',
      required: ['id', 'content', 'reason'],
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: [],
    async execute(args: { id?: string; content?: string; reason?: string }, ctx: ToolContext) {
      if (!args.id || !args.content?.trim() || !args.reason?.trim()) {
        return { content: 'id, content, and reason are required', isError: true };
      }
      try {
        const owned = await loadOwned(memory, args.id, ctx, options);
        if (typeof owned === 'string') return { content: owned, isError: true };
        const next = await memory.correct(args.id, {
          content: args.content.trim(),
          reason: args.reason.trim(),
          by: ctx.principal.id,
        });
        return { content: `Corrected ${args.id} -> ${next.id}: ${next.content}`, data: { id: next.id, supersedesId: next.supersedesId } };
      } catch (err) {
        return { content: asError(err), isError: true };
      }
    },
  };

  const forget: ToolDefinition = {
    name: 'memory_forget',
    description: 'Mark a memory deleted. The revision row remains for audit and is no longer recalled.',
    inputSchema: {
      type: 'object',
      required: ['id', 'reason'],
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    sideEffect: 'idempotent',
    requiredPermissions: [],
    async execute(args: { id?: string; reason?: string }, ctx: ToolContext) {
      if (!args.id || !args.reason?.trim()) return { content: 'id and reason are required', isError: true };
      try {
        const owned = await loadOwned(memory, args.id, ctx, options);
        if (typeof owned === 'string') return { content: owned, isError: true };
        await memory.forget(args.id, { reason: args.reason.trim(), by: ctx.principal.id });
        return { content: `Forgot memory ${args.id}` };
      } catch (err) {
        return { content: asError(err), isError: true };
      }
    },
  };

  return [remember, recall, correct, forget];
}
