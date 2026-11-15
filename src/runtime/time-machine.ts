import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Id, Principal, Run, Session } from '../core/types.js';
import { DomainError, SessionBusyError } from '../core/errors.js';
import type { SessionStore, StepFileSnapshot } from '../store/ports.js';
import type { SideEffect, ToolCallRequest } from '../tools/ports.js';
import type { RuntimeHook } from './hooks.js';

const PATH_FIELDS = [
  'path',
  'filePath',
  'targetFile',
  'TargetFile',
  'file',
  'files',
  'paths',
  'destination',
  'dest',
  'source',
] as const;

const SCAN_IGNORE_NAMES = new Set(['node_modules', '.git', '.pi-agent', 'dist']);

export interface ShadowFsOptions {
  workspaceDir?: string;
  /**
   * `true` scans `workspaceDir` for every tool.
   * A function decides per call.
   * Otherwise a scan runs only when `workspaceDir` is set and the tool's side effect is not `none`.
   */
  trackWorkspaceDiff?: boolean | ((toolName: string, args: unknown) => boolean);
  pathExtractor?: (toolName: string, args: unknown) => string[];
}

export interface RevertOptions {
  preserveBackupBranch?: boolean;
}

export interface RevertReport {
  restoredFiles: string[];
  deletedFiles: string[];
  deletedMessages: number;
  deletedSnapshots: number;
  invalidatedSummaries: number;
  deletedEpisodes: number;
  forgottenMemories: number;
  backupSessionId?: Id;
}

interface FileState {
  exists: boolean;
  content: Buffer | null;
  hash: string | null;
}

interface PendingCapture {
  checkpointSeq: number;
  stepIndex: number;
  toolExecutionId?: Id;
  scan: boolean;
  files: Map<string, FileState>;
}

const EMPTY_FILE: FileState = { exists: false, content: null, hash: null };

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function normalizeFilePath(input: string, workspaceDir?: string): string {
  if (path.isAbsolute(input)) return path.resolve(input);
  if (workspaceDir) return path.resolve(workspaceDir, input);
  return path.resolve(input);
}

function pushPathValue(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pushPathValue(item, out);
  }
}

function defaultExtractPaths(args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  const record = args as Record<string, unknown>;
  const out: string[] = [];
  for (const field of PATH_FIELDS) {
    if (field in record) pushPathValue(record[field], out);
  }
  return out;
}

function readFileState(filePath: string): FileState {
  try {
    const info = statSync(filePath);
    if (!info.isFile()) return EMPTY_FILE;
    const content = readFileSync(filePath);
    return { exists: true, content, hash: sha256(content) };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return EMPTY_FILE;
    throw err;
  }
}

function scanWorkspace(root: string): Map<string, FileState> {
  const found = new Map<string, FileState>();
  const start = path.resolve(root);
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SCAN_IGNORE_NAMES.has(entry.name)) continue;
      const full = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const state = readFileState(full);
        if (state.exists) found.set(full, state);
      } catch {
        // Unreadable scan entries are not part of the rollback set.
      }
    }
  };
  if (existsSync(start)) walk(start);
  return found;
}

function classifyChange(before: FileState, after: FileState): 'created' | 'modified' | 'deleted' | null {
  if (!before.exists && after.exists) return 'created';
  if (before.exists && !after.exists) return 'deleted';
  if (before.exists && after.exists && before.hash !== after.hash) return 'modified';
  return null;
}

/**
 * Captures on-disk file mutations around tool calls and restores both the
 * files and the session transcript back to an earlier sequence.
 */
export class ShadowFsTimeMachine {
  private readonly pending = new Map<string, PendingCapture>();

  constructor(
    private readonly store: SessionStore,
    private readonly options: ShadowFsOptions = {}
  ) {}

  createHook(overrides?: ShadowFsOptions): RuntimeHook {
    const engine = overrides
      ? new ShadowFsTimeMachine(this.store, { ...this.options, ...overrides })
      : this;
    return {
      name: 'shadow-fs-time-machine',
      beforeToolCall: (ctx) => engine.beforeToolCall(ctx),
      afterToolCall: (ctx) => engine.afterToolCall(ctx),
    };
  }

  async listFileSnapshots(
    sessionId: Id,
    opts?: { afterSeq?: number; runId?: Id }
  ): Promise<StepFileSnapshot[]> {
    return this.store.listFileSnapshots(sessionId, opts);
  }

  async revertToSeq(sessionId: Id, targetSeq: number, opts?: RevertOptions): Promise<RevertReport> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new DomainError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND');
    }
    const active = await this.store.getActiveRun(sessionId);
    if (active) {
      throw new SessionBusyError(sessionId, active.id);
    }
    if (!Number.isInteger(targetSeq) || targetSeq < 0) {
      throw new DomainError(`Invalid target sequence: ${targetSeq}`, 'INVALID_TARGET_SEQ');
    }
    const maxSeq = await this.currentMaxSeq(sessionId);
    if (targetSeq > maxSeq) {
      throw new DomainError(
        `Target sequence ${targetSeq} is beyond current max seq ${maxSeq}`,
        'TARGET_SEQ_OUT_OF_RANGE'
      );
    }

    let backupSessionId: Id | undefined;
    if (opts?.preserveBackupBranch) {
      const title = session.title
        ? `${session.title} (backup before seq ${targetSeq})`
        : `Backup before revert to seq ${targetSeq}`;
      const backup = await this.store.forkSession(sessionId, { title });
      backupSessionId = backup.id;
    }

    const snapshots = await this.store.listFileSnapshots(sessionId, { afterSeq: targetSeq });
    const ordered = [...snapshots].sort((left, right) => {
      if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
      if (left.id === right.id) return 0;
      return left.id < right.id ? 1 : -1;
    });

    const finalAction = new Map<string, 'restored' | 'deleted'>();
    for (const snapshot of ordered) {
      if (!snapshot.existedBefore) {
        if (existsSync(snapshot.filePath)) {
          rmSync(snapshot.filePath, { force: true });
        }
        finalAction.set(snapshot.filePath, 'deleted');
        continue;
      }
      if (snapshot.beforeContentB64 == null) {
        throw new DomainError(
          `Snapshot ${snapshot.id} is missing before content for ${snapshot.filePath}`,
          'SNAPSHOT_CONTENT_MISSING'
        );
      }
      const restored = Buffer.from(snapshot.beforeContentB64, 'base64');
      mkdirSync(path.dirname(snapshot.filePath), { recursive: true });
      writeFileSync(snapshot.filePath, restored);
      finalAction.set(snapshot.filePath, 'restored');
    }

    const db = await this.store.revertSessionToSeq(sessionId, targetSeq);
    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    for (const [filePath, action] of finalAction) {
      if (action === 'restored') restoredFiles.push(filePath);
      else deletedFiles.push(filePath);
    }
    restoredFiles.sort();
    deletedFiles.sort();

    return {
      restoredFiles,
      deletedFiles,
      deletedMessages: db.deletedMessages,
      deletedSnapshots: db.deletedSnapshots,
      invalidatedSummaries: db.invalidatedSummaries,
      deletedEpisodes: db.deletedEpisodes,
      forgottenMemories: db.forgottenMemories,
      ...(backupSessionId ? { backupSessionId } : {}),
    };
  }

  async revertToStep(
    sessionId: Id,
    runId: Id,
    targetStepIndex: number,
    opts?: RevertOptions
  ): Promise<RevertReport> {
    const messages = await this.store.listMessages(sessionId, { includeExcluded: true });
    const runMessages = messages.filter((message) => message.runId === runId);
    if (runMessages.length === 0) {
      throw new DomainError(`Run ${runId} has no messages in session ${sessionId}`, 'RUN_NOT_IN_SESSION');
    }
    const firstSeq = runMessages.reduce((min, message) => Math.min(min, message.seq), runMessages[0].seq);

    let targetSeq: number;
    if (targetStepIndex < 0) {
      targetSeq = firstSeq - 1;
    } else {
      const stepMessages = runMessages.filter((message) => message.stepIndex === targetStepIndex);
      if (stepMessages.length === 0) {
        throw new DomainError(
          `Step ${targetStepIndex} was not found on run ${runId}`,
          'STEP_NOT_FOUND'
        );
      }
      targetSeq = stepMessages.reduce((max, message) => Math.max(max, message.seq), stepMessages[0].seq);
    }
    return this.revertToSeq(sessionId, targetSeq, opts);
  }

  private async beforeToolCall(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    call: ToolCallRequest;
    principal: Principal;
  }): Promise<void> {
    const execution = await this.findExecution(ctx.run.id, ctx.call.toolCallId);
    const scan = this.shouldScan(ctx.call.toolName, ctx.call.args, execution?.sideEffect);
    const files = new Map<string, FileState>();
    for (const filePath of this.collectCandidatePaths(ctx.call.toolName, ctx.call.args)) {
      files.set(filePath, readFileState(filePath));
    }
    if (scan && this.options.workspaceDir) {
      for (const [filePath, state] of scanWorkspace(this.options.workspaceDir)) {
        if (!files.has(filePath)) files.set(filePath, state);
      }
    }

    // AgentLoop appends the tool_result message before afterToolCall. The
    // rollback boundary is the session max seq from before the tool wrote
    // anything, which is only true at this point.
    const checkpointSeq = await this.currentMaxSeq(ctx.session.id);
    this.pending.set(this.pendingKey(ctx.session.id, ctx.run.id, ctx.call.toolCallId), {
      checkpointSeq,
      stepIndex: ctx.stepIndex,
      toolExecutionId: execution?.id,
      scan,
      files,
    });
  }

  private async afterToolCall(ctx: {
    session: Session;
    run: Run;
    stepIndex: number;
    call: ToolCallRequest;
    result: { toolCallId: string; toolName: string };
  }): Promise<void> {
    const key = this.pendingKey(ctx.session.id, ctx.run.id, ctx.call.toolCallId);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);

    const paths = new Set(pending.files.keys());
    if (pending.scan && this.options.workspaceDir) {
      for (const filePath of scanWorkspace(this.options.workspaceDir).keys()) {
        paths.add(filePath);
      }
    }

    const execution = await this.findExecution(ctx.run.id, ctx.call.toolCallId);
    const toolExecutionId = execution?.id ?? pending.toolExecutionId;
    const changes: Array<{
      filePath: string;
      changeType: 'created' | 'modified' | 'deleted';
      before: FileState;
      after: FileState;
    }> = [];

    for (const filePath of paths) {
      const before = pending.files.get(filePath) ?? EMPTY_FILE;
      const after = readFileState(filePath);
      const changeType = classifyChange(before, after);
      if (!changeType) continue;
      changes.push({ filePath, changeType, before, after });
    }
    if (changes.length === 0) return;
    if (!toolExecutionId) {
      throw new DomainError(
        `Tool execution for call ${ctx.call.toolCallId} was not found`,
        'TOOL_EXECUTION_NOT_FOUND'
      );
    }

    for (const change of changes) {
      await this.store.saveFileSnapshot({
        sessionId: ctx.session.id,
        runId: ctx.run.id,
        stepIndex: pending.stepIndex,
        checkpointSeq: pending.checkpointSeq,
        toolExecutionId,
        toolCallId: ctx.call.toolCallId,
        toolName: ctx.call.toolName,
        filePath: change.filePath,
        changeType: change.changeType,
        existedBefore: change.before.exists,
        beforeContentB64: change.before.exists
          ? (change.before.content ?? Buffer.alloc(0)).toString('base64')
          : null,
        beforeHash: change.before.hash,
        afterHash: change.after.exists ? change.after.hash : null,
      });
    }
  }

  private shouldScan(toolName: string, args: unknown, sideEffect: SideEffect | undefined): boolean {
    if (!this.options.workspaceDir) return false;
    const flag = this.options.trackWorkspaceDiff;
    if (typeof flag === 'function') return flag(toolName, args);
    if (flag === true) return true;
    return sideEffect !== undefined && sideEffect !== 'none';
  }

  private collectCandidatePaths(toolName: string, args: unknown): string[] {
    const raw = [
      ...defaultExtractPaths(args),
      ...(this.options.pathExtractor?.(toolName, args) ?? []),
    ];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
      const normalized = normalizeFilePath(item, this.options.workspaceDir);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }

  private async findExecution(runId: Id, toolCallId: string) {
    const executions = await this.store.listToolExecutions(runId);
    for (let index = executions.length - 1; index >= 0; index -= 1) {
      if (executions[index].toolCallId === toolCallId) return executions[index];
    }
    return undefined;
  }

  private async currentMaxSeq(sessionId: Id): Promise<number> {
    const messages = await this.store.listMessages(sessionId, { includeExcluded: true });
    return messages.reduce((max, message) => Math.max(max, message.seq), 0);
  }

  private pendingKey(sessionId: Id, runId: Id, toolCallId: string): string {
    return `${sessionId}\0${runId}\0${toolCallId}`;
  }
}
