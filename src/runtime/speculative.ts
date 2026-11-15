import { createHash } from 'node:crypto';
import type { Principal, Run, Session } from '../core/types.js';
import type { ModelDelta } from '../model/ports.js';
import type { ToolExecutor, ToolRegistry, ToolResult } from '../tools/ports.js';

export type SpeculativeSource = 'tool_call_delta' | 'reasoning_intent';

export interface SpeculativeConsumeResult {
  result: ToolResult;
  source: SpeculativeSource;
  savedMs: number;
}

export interface SpeculativeEngineOptions {
  registry: ToolRegistry;
  executor: ToolExecutor;
  session: Session;
  run: Run;
  principal: Principal;
  signal: AbortSignal;
  enableReasoningPrefetch?: boolean;
  onPrefetched?: (info: {
    toolCallId: string;
    toolName: string;
    source: SpeculativeSource;
  }) => void;
}

interface StreamSlot {
  index: number;
  toolCallId: string;
  toolName: string;
  argsText: string;
}

interface SpeculativeEntry {
  toolCallId: string;
  toolName: string;
  argsHash: string;
  source: SpeculativeSource;
  dispatchedAt: number;
  finishedAt?: number;
  controller: AbortController;
  promise: Promise<ToolResult | null>;
  consumed: boolean;
}

const PATH_FIELD_NAMES = new Set(['path', 'filePath', 'targetFile', 'file']);
const MAX_WARMUPS_PER_STEP = 16;

// Matches complete relative/file paths terminated by a closing delimiter so partial streaming tokens don't misfire.
const DELIMITED_PATH_REGEX =
  /(?:^|[\s`"'(\[，。、；：（])((?:[A-Za-z0-9_-]+[\/\\])*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|yaml|yml|toml|sql|css|html|py|go|rs|sh|ps1|env|lock))(?=[\s`"'),.;:!?\]，。、；：）\r\n])/g;

const TOOL_INTENT_HINTS: Array<{ toolName: string; pattern: RegExp }> = [
  { toolName: 'list_files', pattern: /\blist_files\b|列出工作区|列出.*文件|有哪些文件|查看.*目录|检查工作区/ },
  { toolName: 'system_info', pattern: /\bsystem_info\b|系统信息|剩余内存|整机内存|环境状态|CPU\s*核数/i },
];

function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}

function getSinglePathField(inputSchema: Record<string, unknown>): string | null {
  const props = (inputSchema?.properties ?? {}) as Record<string, { type?: string }>;
  const required = Array.isArray(inputSchema?.required) ? (inputSchema.required as string[]) : [];
  if (required.length !== 1) return null;
  const field = required[0];
  if (!PATH_FIELD_NAMES.has(field)) return null;
  if (props[field]?.type && props[field].type !== 'string') return null;
  return field;
}

function hasZeroRequiredArgs(inputSchema: Record<string, unknown>): boolean {
  const required = Array.isArray(inputSchema?.required) ? (inputSchema.required as string[]) : [];
  return required.length === 0;
}

export class SpeculativeToolEngine {
  private slots = new Map<number, StreamSlot>();
  private entries = new Map<string, SpeculativeEntry>();
  private warmCache = new Map<string, SpeculativeEntry>();
  private seenWarmupKeys = new Set<string>();
  private warmupSeq = 0;
  private reasoningBuffer = '';
  private streamFinishedAt?: number;
  private closed = false;

  constructor(private readonly opts: SpeculativeEngineOptions) {}

  markStreamFinished(ts: number = Date.now()): void {
    if (this.streamFinishedAt === undefined) {
      this.streamFinishedAt = ts;
    }
  }

  onDelta(delta: ModelDelta): void {
    if (this.closed || this.opts.signal.aborted) return;

    if (delta.type === 'reasoning_delta') {
      if (this.opts.enableReasoningPrefetch !== false) {
        this.reasoningBuffer += delta.text;
        this.tryDispatchFromIntent(this.reasoningBuffer);
      }
      return;
    }

    if (delta.type !== 'tool_call_delta') return;

    let slot = this.slots.get(delta.index);
    if (!slot) {
      slot = {
        index: delta.index,
        toolCallId: delta.toolCallId ?? '',
        toolName: delta.toolName ?? '',
        argsText: '',
      };
      this.slots.set(delta.index, slot);
    } else if (delta.toolCallId && slot.toolCallId && delta.toolCallId !== slot.toolCallId) {
      // Index was reused for a brand-new tool call id
      slot = {
        index: delta.index,
        toolCallId: delta.toolCallId,
        toolName: delta.toolName ?? '',
        argsText: '',
      };
      this.slots.set(delta.index, slot);
    } else {
      if (delta.toolCallId) slot.toolCallId = delta.toolCallId;
      if (delta.toolName) slot.toolName = delta.toolName;
    }

    if (delta.argsText !== undefined) {
      slot.argsText = delta.argsText;
    } else if (delta.argsDelta !== undefined) {
      slot.argsText += delta.argsDelta;
    }

    this.tryDispatchSlot(slot);
  }

  private isReadOnlyToolAllowed(toolName: string) {
    const registered = this.opts.registry.get(toolName);
    if (!registered) return null;
    if (registered.def.sideEffect !== 'none') return null;
    const allowedTools = this.opts.session.config.tools;
    if (allowedTools && !allowedTools.includes(toolName)) return null;
    return registered;
  }

  private tryDispatchFromIntent(buffer: string): void {
    if (this.seenWarmupKeys.size >= MAX_WARMUPS_PER_STEP) return;

    const candidates = this.opts.registry.list({ names: this.opts.session.config.tools });
    const readOnlyTools = candidates.filter((t) => t.def.sideEffect === 'none');
    if (readOnlyTools.length === 0) return;

    // 1. Zero-required-arg inspection tools (e.g., list_files, system_info)
    for (const tool of readOnlyTools) {
      if (this.seenWarmupKeys.size >= MAX_WARMUPS_PER_STEP) break;
      if (!hasZeroRequiredArgs(tool.def.inputSchema)) continue;

      const hint = TOOL_INTENT_HINTS.find((h) => h.toolName === tool.def.name);
      const explicitMention = new RegExp(`\\b${tool.def.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (explicitMention.test(buffer) || (hint && hint.pattern.test(buffer))) {
        this.dispatchWarmup(tool.def.name, {});
      }
    }

    // 2. Single-path file-reading tools (e.g., read_file, read_doc)
    const pathTools = readOnlyTools
      .map((tool) => ({ tool, field: getSinglePathField(tool.def.inputSchema) }))
      .filter((item): item is { tool: typeof readOnlyTools[number]; field: string } => item.field !== null);

    if (pathTools.length === 0) return;

    DELIMITED_PATH_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DELIMITED_PATH_REGEX.exec(buffer)) !== null) {
      if (this.seenWarmupKeys.size >= MAX_WARMUPS_PER_STEP) break;
      const rawPath = match[1];
      if (!rawPath || rawPath.length > 200) continue;

      for (const { tool, field } of pathTools) {
        if (this.seenWarmupKeys.size >= MAX_WARMUPS_PER_STEP) break;
        this.dispatchWarmup(tool.def.name, { [field]: rawPath });
      }
    }
  }

  private dispatchWarmup(toolName: string, args: Record<string, unknown>): void {
    const registered = this.isReadOnlyToolAllowed(toolName);
    if (!registered) return;

    const validation = registered.validate(args);
    if (!validation.valid) return;

    const argsDigest = hashArgs(args);
    const cacheKey = `${toolName}::${argsDigest}`;
    if (this.seenWarmupKeys.has(cacheKey) || this.warmCache.has(cacheKey)) return;
    if (this.seenWarmupKeys.size >= MAX_WARMUPS_PER_STEP) return;

    this.seenWarmupKeys.add(cacheKey);
    const syntheticId = `warmup_${toolName}_${++this.warmupSeq}`;
    const entry = this.startExecution({
      toolCallId: syntheticId,
      toolName,
      args,
      argsDigest,
      source: 'reasoning_intent',
    });
    this.warmCache.set(cacheKey, entry);
  }

  private tryDispatchSlot(slot: StreamSlot): void {
    if (!slot.toolCallId || !slot.toolName || !slot.argsText.trim()) return;

    const registered = this.isReadOnlyToolAllowed(slot.toolName);
    if (!registered) return;

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(slot.argsText);
    } catch {
      return; // JSON arguments not yet closed
    }

    if (typeof parsedArgs !== 'object' || parsedArgs === null) return;
    const validation = registered.validate(parsedArgs);
    if (!validation.valid) return;

    const argsDigest = hashArgs(parsedArgs);
    const existing = this.entries.get(slot.toolCallId);
    if (existing) {
      if (existing.toolName === slot.toolName && existing.argsHash === argsDigest) {
        return; // Already dispatched for exact same args
      }
      // Arguments mutated mid-stream; abort previous speculative execution
      existing.controller.abort();
      this.entries.delete(slot.toolCallId);
    }

    // If reasoning-driven warmup already started this exact tool+args, promote it without double execution
    const warmKey = `${slot.toolName}::${argsDigest}`;
    const warmEntry = this.warmCache.get(warmKey);
    if (warmEntry && !warmEntry.consumed && !warmEntry.controller.signal.aborted) {
      this.warmCache.delete(warmKey);
      warmEntry.toolCallId = slot.toolCallId;
      this.entries.set(slot.toolCallId, warmEntry);
      return;
    }

    const entry = this.startExecution({
      toolCallId: slot.toolCallId,
      toolName: slot.toolName,
      args: parsedArgs,
      argsDigest,
      source: 'tool_call_delta',
    });
    this.entries.set(slot.toolCallId, entry);
  }

  private startExecution(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    argsDigest: string;
    source: SpeculativeSource;
  }): SpeculativeEntry {
    const controller = new AbortController();
    const combinedSignal = AbortSignal.any([this.opts.signal, controller.signal]);
    const dispatchedAt = Date.now();

    try {
      this.opts.onPrefetched?.({
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        source: input.source,
      });
    } catch {
      // Ignore observer callback errors
    }

    const entry: SpeculativeEntry = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argsHash: input.argsDigest,
      source: input.source,
      dispatchedAt,
      controller,
      consumed: false,
      promise: null as unknown as Promise<ToolResult | null>,
    };

    entry.promise = this.opts.executor
      .execute(
        { toolCallId: input.toolCallId, toolName: input.toolName, args: input.args },
        {
          sessionId: this.opts.session.id,
          runId: this.opts.run.id,
          toolExecutionId: `spec_${input.toolCallId}`,
          idempotencyKey: `${this.opts.session.id}:${this.opts.run.id}:${input.toolCallId}`,
          principal: this.opts.principal,
          signal: combinedSignal,
        }
      )
      .then((res): ToolResult | null => {
        entry.finishedAt = Date.now();
        if (controller.signal.aborted || this.opts.signal.aborted) {
          return null;
        }
        if (res.status === 'awaiting_approval') {
          return null;
        }
        return {
          ...res,
          fromCache: true,
        };
      })
      .catch(() => {
        entry.finishedAt = Date.now();
        return null;
      });

    return entry;
  }

  reconcile(finalCalls: Array<{ toolCallId: string; toolName: string; args: unknown }>): void {
    const validById = new Map<string, string>();
    const validWarmKeys = new Set<string>();
    for (const call of finalCalls) {
      const digest = hashArgs(call.args);
      validById.set(`${call.toolCallId}::${call.toolName}`, digest);
      validWarmKeys.add(`${call.toolName}::${digest}`);
    }

    for (const [toolCallId, entry] of this.entries.entries()) {
      const expectedHash = validById.get(`${toolCallId}::${entry.toolName}`);
      if (!expectedHash || expectedHash !== entry.argsHash) {
        entry.controller.abort();
        this.entries.delete(toolCallId);
      }
    }

    for (const [warmKey, entry] of this.warmCache.entries()) {
      if (!validWarmKeys.has(warmKey)) {
        entry.controller.abort();
        this.warmCache.delete(warmKey);
      }
    }
  }

  async consume(call: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<SpeculativeConsumeResult | null> {
    const expectedHash = hashArgs(call.args);
    let entry = this.entries.get(call.toolCallId);
    if (entry) {
      if (entry.consumed || entry.toolName !== call.toolName || entry.argsHash !== expectedHash) {
        entry.controller.abort();
        this.entries.delete(call.toolCallId);
        return null;
      }
      entry.consumed = true;
      this.entries.delete(call.toolCallId);
    } else {
      const warmKey = `${call.toolName}::${expectedHash}`;
      const warmEntry = this.warmCache.get(warmKey);
      if (!warmEntry || warmEntry.consumed) {
        return null;
      }
      warmEntry.consumed = true;
      this.warmCache.delete(warmKey);
      entry = warmEntry;
    }

    const result = await entry.promise;
    if (!result) return null;

    const refEnd = this.streamFinishedAt ?? Date.now();
    const effectiveEnd = entry.finishedAt !== undefined ? Math.min(refEnd, entry.finishedAt) : refEnd;
    const savedMs = Math.max(0, effectiveEnd - entry.dispatchedAt);

    return {
      result: {
        ...result,
        toolCallId: call.toolCallId,
      },
      source: entry.source,
      savedMs,
    };
  }

  invalidateAfterWrite(): void {
    for (const entry of this.entries.values()) {
      if (!entry.consumed) entry.controller.abort();
    }
    this.entries.clear();
    for (const entry of this.warmCache.values()) {
      if (!entry.consumed) entry.controller.abort();
    }
    this.warmCache.clear();
  }

  abortAll(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (!entry.consumed) {
        entry.controller.abort();
      }
    }
    for (const entry of this.warmCache.values()) {
      if (!entry.consumed) {
        entry.controller.abort();
      }
    }
    this.entries.clear();
    this.warmCache.clear();
    this.slots.clear();
    this.seenWarmupKeys.clear();
  }
}
