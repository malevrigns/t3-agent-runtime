import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type {
  BeginToolExecution,
  ForkSessionOptions,
  Episode,
  NewEpisode,
  NewStepFileSnapshot,
  NewSummary,
  PersistedEvent,
  QueuedTurnMessage,
  SessionStore,
  StepFileSnapshot,
  Summary,
  ToolExecutionRecord,
  ToolResolution,
} from '../ports.js';
import type { MemoryRecallQuery, MemoryRecord, NewMemory } from '../../memory/ports.js';
import { memoryContentKey, selectRankedMemories } from '../../memory/rank.js';
import type {
  ContentBlock,
  Id,
  Message,
  NewSession,
  PendingInput,
  Run,
  RunLimits,
  RuntimeErrorInfo,
  Session,
  StopReason,
  TokenUsage,
} from '../../core/types.js';
import {
  ConcurrentModificationError,
  DomainError,
  InfrastructureError,
  InvalidRunStateError,
  SessionBusyError,
} from '../../core/errors.js';
import { generateId } from '../../core/ids.js';
import type { ToolResult } from '../../tools/ports.js';

/**
 * A session fact crosses a fork only when it already existed at that transcript point.
 * `msg:N` follows the message seq. Facts with no seq follow the cutoff message time,
 * and a fork of the current tip keeps every such fact.
 */
function memoryVisibleAtFork(
  sourceRef: string | null | undefined,
  atSeq: number,
  createdAt: number,
  cutoffAt: number | null,
  latestSeq: number
): boolean {
  if (sourceRef?.startsWith('msg:')) {
    const seq = Number(sourceRef.slice(4));
    if (Number.isInteger(seq)) return seq <= atSeq;
  }
  if (atSeq >= latestSeq) return true;
  if (cutoffAt == null) return false;
  return createdAt <= cutoffAt;
}

/** In-process ranking must see the lexical matches. This only bounds one scope scan. */
const MEMORY_RECALL_CANDIDATE_CAP = 2000;

export class SqliteSessionStore implements SessionStore {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    try {
      this.db = new DatabaseSync(dbPath);
      this.initSchema();
    } catch (err) {
      throw new InfrastructureError('Failed to initialize SQLite database', err);
    }
  }

  private initSchema(): void {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const sqlPath = join(__dirname, 'migrations', '001_init.sql');
    const ddl = readFileSync(sqlPath, 'utf-8');
    this.db.exec(ddl);
    this.ensureRuntimeColumns();
  }

  private ensureRuntimeColumns(): void {
    const toolCols = this.db.prepare('PRAGMA table_info(tool_executions)').all() as Array<{ name: string }>;
    const names = new Set(toolCols.map((column) => column.name));
    if (!names.has('approval_decision')) {
      this.db.exec('ALTER TABLE tool_executions ADD COLUMN approval_decision TEXT');
    }
    if (!names.has('precondition_hash')) {
      this.db.exec('ALTER TABLE tool_executions ADD COLUMN precondition_hash TEXT');
    }

    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const sessionNames = new Set(sessionCols.map((column) => column.name));
    if (!sessionNames.has('parent_session_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT REFERENCES sessions(id)');
    }
    if (!sessionNames.has('forked_from_seq')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN forked_from_seq INTEGER');
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS ix_sessions_parent ON sessions(parent_session_id)');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS queued_messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id),
        kind         TEXT NOT NULL CHECK (kind IN ('steer','follow_up')),
        content_json TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_queued_messages_session ON queued_messages(session_id, created_at);
    `);

    // Older database files were created before shadow snapshots existed.
    // initSchema replays 001_init.sql, and this keeps the same guarantee if a
    // caller opens a database that skipped that replay.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS step_file_snapshots (
        id                 TEXT PRIMARY KEY,
        session_id         TEXT NOT NULL REFERENCES sessions(id),
        run_id             TEXT NOT NULL REFERENCES runs(id),
        step_index         INTEGER NOT NULL,
        checkpoint_seq     INTEGER NOT NULL,
        tool_execution_id  TEXT NOT NULL,
        tool_call_id       TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        file_path          TEXT NOT NULL,
        change_type        TEXT NOT NULL CHECK (change_type IN ('created','modified','deleted')),
        existed_before     INTEGER NOT NULL,
        before_content_b64 TEXT,
        before_hash        TEXT,
        after_hash         TEXT,
        created_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ix_snapshots_session_seq
        ON step_file_snapshots(session_id, checkpoint_seq, created_at);
    `);

    const memoryCols = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    const memoryNames = new Set(memoryCols.map((column) => column.name));
    if (!memoryNames.has('salience')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN salience REAL NOT NULL DEFAULT 0.5');
    }
    if (!memoryNames.has('pinned')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!memoryNames.has('content_key')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN content_key TEXT');
    }
    if (!memoryNames.has('access_count')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0');
    }
    if (!memoryNames.has('last_accessed_at')) {
      this.db.exec('ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER');
    }
    if (!memoryNames.has('tags_json')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    }
    this.backfillMemoryContentKeys();
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_active_key
        ON memories(scope_type, scope_id, content_key)
        WHERE status = 'active' AND content_key IS NOT NULL
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id             TEXT PRIMARY KEY,
        session_id     TEXT NOT NULL REFERENCES sessions(id),
        summary_id     TEXT REFERENCES summaries(id),
        from_seq       INTEGER NOT NULL,
        to_seq         INTEGER NOT NULL,
        title          TEXT NOT NULL,
        content        TEXT NOT NULL,
        entities_json  TEXT NOT NULL DEFAULT '[]',
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        CHECK (from_seq <= to_seq)
      );
      CREATE INDEX IF NOT EXISTS ix_episodes_session ON episodes(session_id, to_seq);
    `);
  }

  /** Legacy rows predate content_key. Fill it, and fold exact duplicates into the older row. */
  private backfillMemoryContentKeys(): void {
    const rows = this.db.prepare(`
      SELECT id, scope_type, scope_id, kind, content, confidence, salience
      FROM memories
      WHERE status = 'active' AND (content_key IS NULL OR content_key = '')
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{
      id: string;
      scope_type: string;
      scope_id: string;
      kind: string;
      content: string;
      confidence: number;
      salience: number;
    }>;
    if (rows.length === 0) return;

    const updateKey = this.db.prepare('UPDATE memories SET content_key = ? WHERE id = ?');
    const findClash = this.db.prepare(`
      SELECT id, salience, confidence FROM memories
      WHERE scope_type = ? AND scope_id = ? AND content_key = ? AND status = 'active' AND id != ?
    `);
    const markCorrected = this.db.prepare(`
      UPDATE memories
      SET status = 'corrected', status_reason = 'legacy content key already active', updated_at = ?
      WHERE id = ?
    `);
    const reinforce = this.db.prepare(`
      UPDATE memories
      SET salience = ?, confidence = ?, access_count = access_count + 1, updated_at = ?
      WHERE id = ?
    `);
    const now = Date.now();
    this.runInTransaction(() => {
      for (const row of rows) {
        const key = memoryContentKey(String(row.kind), String(row.content));
        const clash: any = findClash.get(row.scope_type, row.scope_id, key, row.id);
        if (clash) {
          markCorrected.run(now, row.id);
          reinforce.run(
            Math.min(1, Number(clash.salience ?? 0.5) + 0.05),
            Math.max(Number(clash.confidence ?? 0), Number(row.confidence ?? 0)),
            now,
            clash.id
          );
          continue;
        }
        updateKey.run(key, row.id);
      }
    });
  }

  close(): void {
    this.db.close();
  }

  /**
   * 同步事务包装器，杜绝在事务内发生异步让出 (await)
   */
  private runInTransaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略 rollback 失败
      }
      throw err;
    }
  }

  async createSession(input: NewSession): Promise<Session> {
    const id = input.id ?? generateId('sess');
    const now = Date.now();
    const configJson = JSON.stringify(input.config);

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, config_json, next_seq, status, parent_session_id, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'active', ?, ?, ?)
    `);

    try {
      stmt.run(id, input.title ?? null, configJson, input.parentSessionId ?? null, now, now);
      return {
        id,
        title: input.title,
        config: input.config,
        nextSeq: 1,
        status: 'active',
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        createdAt: now,
        updatedAt: now,
      };
    } catch (err: any) {
      throw new InfrastructureError('Failed to create session', err);
    }
  }

  async listSessions(limit = 20): Promise<Session[]> {
    const rows = this.db.prepare(
      'SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?'
    ).all(limit) as Array<{ id: string }>;
    const sessions: Session[] = [];
    for (const row of rows) {
      const session = await this.getSession(row.id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  async updateSessionConfig(sessionId: Id, config: Session['config']): Promise<Session> {
    const now = Date.now();
    const result = this.db.prepare(
      'UPDATE sessions SET config_json = ?, updated_at = ? WHERE id = ?'
    ).run(JSON.stringify(config), now, sessionId);
    if (result.changes === 0) {
      throw new DomainError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND');
    }
    const session = await this.getSession(sessionId);
    if (!session) throw new DomainError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND');
    return session;
  }

  private mapSessionRow(row: any): Session {
    return {
      id: row.id,
      title: row.title ?? undefined,
      config: JSON.parse(row.config_json),
      nextSeq: Number(row.next_seq),
      status: row.status,
      parentSessionId: row.parent_session_id ?? undefined,
      forkedFromSeq: row.forked_from_seq !== null && row.forked_from_seq !== undefined ? Number(row.forked_from_seq) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  async getSession(id: Id): Promise<Session | null> {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row: any = stmt.get(id);
    if (!row) return null;
    return this.mapSessionRow(row);
  }

  async forkSession(sessionId: Id, opts?: ForkSessionOptions): Promise<Session> {
    const now = Date.now();
    const forkId = generateId('sess');

    try {
      return this.runInTransaction(() => {
        const srcRow: any = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
        if (!srcRow) {
          throw new DomainError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND');
        }
        const srcConfig = JSON.parse(srcRow.config_json) as Session['config'];
        const mergedConfig: Session['config'] = opts?.config ? { ...srcConfig, ...opts.config } : srcConfig;

        const maxRow: any = this.db.prepare('SELECT MAX(seq) as max_seq FROM messages WHERE session_id = ?').get(sessionId);
        const latestSeq = maxRow?.max_seq != null ? Number(maxRow.max_seq) : 0;
        const atSeq = opts?.atSeq !== undefined ? opts.atSeq : latestSeq;
        if (!Number.isInteger(atSeq) || atSeq < 0) {
          throw new DomainError(`Invalid fork sequence: ${atSeq}`, 'INVALID_FORK_SEQ');
        }

        const msgRows: any[] = atSeq > 0
          ? this.db.prepare('SELECT * FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq ASC').all(sessionId, atSeq)
          : [];
        const maxCopiedSeq = msgRows.length > 0 ? Number(msgRows[msgRows.length - 1].seq) : 0;
        const cutoffAt = msgRows.reduce<number | null>((max, msg) => {
          const created = Number(msg.created_at);
          return max == null || created > max ? created : max;
        }, null);
        const nextSeq = maxCopiedSeq + 1;
        const title = opts?.title ?? (srcRow.title ? `${srcRow.title} (fork)` : undefined);

        this.db.prepare(`
          INSERT INTO sessions (
            id, title, config_json, next_seq, status, parent_session_id, forked_from_seq, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `).run(forkId, title ?? null, JSON.stringify(mergedConfig), nextSeq, sessionId, atSeq, now, now);

        const insertMsgStmt = this.db.prepare(`
          INSERT INTO messages (
            id, session_id, run_id, seq, step_index, role, content_json,
            usage_json, model, token_estimate, synthetic, excluded_from_context, exclusion_reason, created_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const msg of msgRows) {
          insertMsgStmt.run(
            generateId('msg'),
            forkId,
            Number(msg.seq),
            msg.step_index ?? null,
            msg.role,
            msg.content_json,
            msg.usage_json ?? null,
            msg.model ?? null,
            Number(msg.token_estimate ?? 0),
            Number(msg.synthetic ?? 0),
            Number(msg.excluded_from_context ?? 0),
            msg.exclusion_reason ?? null,
            Number(msg.created_at)
          );
        }

        let copiedSummaryId: string | null = null;
        let forkedSummaryId: string | null = null;
        if (atSeq > 0) {
          const activeSum: any = this.db.prepare(`
            SELECT * FROM summaries
            WHERE session_id = ? AND status = 'active' AND to_seq <= ?
            ORDER BY to_seq DESC LIMIT 1
          `).get(sessionId, atSeq);
          if (activeSum) {
            copiedSummaryId = String(activeSum.id);
            forkedSummaryId = generateId('sum');
            this.db.prepare(`
              INSERT INTO summaries (
                id, session_id, from_seq, to_seq, content, token_estimate,
                model, prompt_version, status, supersedes_id, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)
            `).run(
              forkedSummaryId,
              forkId,
              Number(activeSum.from_seq),
              Number(activeSum.to_seq),
              activeSum.content,
              Number(activeSum.token_estimate),
              activeSum.model,
              activeSum.prompt_version,
              Number(activeSum.created_at)
            );
          }

          const episodeRows: any[] = this.db.prepare(`
            SELECT * FROM episodes WHERE session_id = ? AND to_seq <= ? ORDER BY to_seq ASC
          `).all(sessionId, atSeq);
          const insertEpisode = this.db.prepare(`
            INSERT INTO episodes (
              id, session_id, summary_id, from_seq, to_seq, title, content,
              entities_json, token_estimate, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const episode of episodeRows) {
            const summaryId = episode.summary_id && episode.summary_id === copiedSummaryId ? forkedSummaryId : null;
            insertEpisode.run(
              generateId('ep'),
              forkId,
              summaryId,
              Number(episode.from_seq),
              Number(episode.to_seq),
              episode.title,
              episode.content,
              episode.entities_json ?? '[]',
              Number(episode.token_estimate ?? 0),
              Number(episode.created_at)
            );
          }
        }

        const sessionMemories: any[] = this.db.prepare(`
          SELECT * FROM memories WHERE scope_type = 'session' AND scope_id = ? AND status = 'active'
        `).all(sessionId);
        const insertMemStmt = this.db.prepare(`
          INSERT INTO memories (
            id, scope_type, scope_id, kind, content, source_type, source_ref, source_session_id,
            confidence, salience, pinned, content_key, access_count, last_accessed_at, tags_json,
            status, supersedes_id, status_reason, created_by, created_at, updated_at
          ) VALUES (?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?, ?)
        `);
        for (const mem of sessionMemories) {
          if (!memoryVisibleAtFork(mem.source_ref, atSeq, Number(mem.created_at), cutoffAt, latestSeq)) continue;
          insertMemStmt.run(
            generateId('mem'),
            forkId,
            mem.kind,
            mem.content,
            mem.source_type,
            mem.source_ref ?? null,
            forkId,
            Number(mem.confidence),
            Number(mem.salience ?? 0.5),
            Number(mem.pinned ?? 0),
            mem.content_key ?? null,
            Number(mem.access_count ?? 0),
            mem.last_accessed_at != null ? Number(mem.last_accessed_at) : null,
            mem.tags_json ?? '[]',
            mem.created_by,
            Number(mem.created_at),
            Number(mem.updated_at ?? now)
          );
        }

        const created: any = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(forkId);
        return this.mapSessionRow(created);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to fork session', err);
    }
  }

  async listSessionBranches(sessionId: Id): Promise<Session[]> {
    const rows: any[] = this.db.prepare(
      'SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at ASC'
    ).all(sessionId);
    return rows.map((row) => this.mapSessionRow(row));
  }

  async startRun(input: {
    sessionId: Id;
    userContent: ContentBlock[];
    limits: RunLimits;
    leaseOwner: string;
    leaseMs: number;
  }): Promise<{ run: Run; userMessage: Message }> {
    const now = Date.now();
    const runId = generateId('run');
    const msgId = generateId('msg');
    const leaseExpiresAt = now + input.leaseMs;

    try {
      return this.runInTransaction(() => {
        // 1. 获取会话并检查
        const sessStmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
        const sess: any = sessStmt.get(input.sessionId);
        if (!sess) {
          throw new DomainError(`Session ${input.sessionId} not found`, 'SESSION_NOT_FOUND');
        }

        // 2. 检查是否有活动 Run
        const activeStmt = this.db.prepare(`
          SELECT id FROM runs 
          WHERE session_id = ? AND status IN ('running','waiting_input','cancelling')
        `);
        const existingActive: any = activeStmt.get(input.sessionId);
        if (existingActive) {
          throw new SessionBusyError(input.sessionId, existingActive.id);
        }

        // 3. 插入 Run
        const runStmt = this.db.prepare(`
          INSERT INTO runs (
            id, session_id, status, limits_json, model_calls, tool_calls,
            input_tokens, output_tokens, active_elapsed_ms, lease_owner,
            lease_expires_at, version, created_at, updated_at
          ) VALUES (?, ?, 'running', ?, 0, 0, 0, 0, 0, ?, ?, 0, ?, ?)
        `);
        runStmt.run(
          runId,
          input.sessionId,
          JSON.stringify(input.limits),
          input.leaseOwner,
          leaseExpiresAt,
          now,
          now
        );

        // 4. 追加 User 消息，消耗 next_seq
        const currentSeq = Number(sess.next_seq);
        const updateSessStmt = this.db.prepare(`
          UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?
        `);
        updateSessStmt.run(now, input.sessionId);

        const msgStmt = this.db.prepare(`
          INSERT INTO messages (
            id, session_id, run_id, seq, step_index, role, content_json,
            synthetic, excluded_from_context, created_at
          ) VALUES (?, ?, ?, ?, 0, 'user', ?, 0, 0, ?)
        `);
        msgStmt.run(msgId, input.sessionId, runId, currentSeq, JSON.stringify(input.userContent), now);

        const run: Run = {
          id: runId,
          sessionId: input.sessionId,
          status: 'running',
          stopReason: null,
          error: null,
          limits: input.limits,
          modelCalls: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
          activeElapsedMs: 0,
          pendingInput: null,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt,
          version: 0,
          createdAt: now,
          updatedAt: now,
          finishedAt: null,
        };

        const userMessage: Message = {
          id: msgId,
          sessionId: input.sessionId,
          runId,
          seq: currentSeq,
          stepIndex: 0,
          role: 'user',
          content: input.userContent,
          synthetic: false,
          excludedFromContext: false,
          createdAt: now,
        };

        return { run, userMessage };
      });
    } catch (err: any) {
      if (
        err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
        (err.message && (err.message.includes('ux_runs_one_active_per_session') || err.message.includes('UNIQUE constraint failed: runs.session_id')))
      ) {
        const active: any = this.db
          .prepare(`SELECT id FROM runs WHERE session_id = ? AND status IN ('running','waiting_input','cancelling')`)
          .get(input.sessionId);
        throw new SessionBusyError(input.sessionId, active?.id ?? 'unknown');
      }
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to start run', err);
    }
  }

  async getRun(id: Id): Promise<Run | null> {
    const stmt = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    const row: any = stmt.get(id);
    if (!row) return null;
    return this.mapRunRow(row);
  }

  private mapRunRow(row: any): Run {
    return {
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      stopReason: row.stop_reason ?? null,
      error: row.error_json ? JSON.parse(row.error_json) : null,
      limits: JSON.parse(row.limits_json),
      modelCalls: Number(row.model_calls),
      toolCalls: Number(row.tool_calls),
      usage: {
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
      },
      activeElapsedMs: Number(row.active_elapsed_ms),
      pendingInput: row.pending_input_json ? JSON.parse(row.pending_input_json) : null,
      leaseOwner: row.lease_owner ?? null,
      leaseExpiresAt: row.lease_expires_at ? Number(row.lease_expires_at) : null,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      finishedAt: row.finished_at ? Number(row.finished_at) : null,
    };
  }

  async getActiveRun(sessionId: Id): Promise<Run | null> {
    const stmt = this.db.prepare(`
      SELECT id FROM runs 
      WHERE session_id = ? AND status IN ('running','waiting_input','cancelling')
    `);
    const row: any = stmt.get(sessionId);
    if (!row) return null;
    return this.getRun(row.id);
  }

  async appendAssistantMessage(
    runId: Id,
    input: {
      stepIndex: number;
      content: ContentBlock[];
      usage: TokenUsage;
      model: string;
      elapsedMs: number;
    }
  ): Promise<Message> {
    const now = Date.now();
    const msgId = generateId('msg');

    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT session_id, status FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');

        const sessStmt = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?');
        const sess: any = sessStmt.get(runRow.session_id);
        const currentSeq = Number(sess.next_seq);

        this.db.prepare('UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(now, runRow.session_id);

        const msgStmt = this.db.prepare(`
          INSERT INTO messages (
            id, session_id, run_id, seq, step_index, role, content_json,
            usage_json, model, synthetic, excluded_from_context, created_at
          ) VALUES (?, ?, ?, ?, ?, 'assistant', ?, ?, ?, 0, 0, ?)
        `);
        msgStmt.run(
          msgId,
          runRow.session_id,
          runId,
          currentSeq,
          input.stepIndex,
          JSON.stringify(input.content),
          JSON.stringify(input.usage),
          input.model,
          now
        );

        const runUpdateStmt = this.db.prepare(`
          UPDATE runs SET
            model_calls = model_calls + 1,
            input_tokens = input_tokens + ?,
            output_tokens = output_tokens + ?,
            active_elapsed_ms = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
        `);
        runUpdateStmt.run(
          input.usage.inputTokens,
          input.usage.outputTokens,
          input.elapsedMs,
          now,
          runId
        );

        return {
          id: msgId,
          sessionId: runRow.session_id,
          runId,
          seq: currentSeq,
          stepIndex: input.stepIndex,
          role: 'assistant',
          content: input.content,
          usage: input.usage,
          model: input.model,
          synthetic: false,
          excludedFromContext: false,
          createdAt: now,
        };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to append assistant message', err);
    }
  }

  async beginToolExecution(input: BeginToolExecution): Promise<{ execution: ToolExecutionRecord; existing: boolean }> {
    const now = Date.now();
    const execId = generateId('texec');

    try {
      return this.runInTransaction(() => {
        // 1. 检查幂等键
        const checkStmt = this.db.prepare('SELECT * FROM tool_executions WHERE idempotency_key = ?');
        const existing: any = checkStmt.get(input.idempotencyKey);
        if (existing) {
          return {
            existing: true,
            execution: this.mapToolExecution(existing),
          };
        }

        // 2. 插入新执行意图
        const insertStmt = this.db.prepare(`
          INSERT INTO tool_executions (
            id, run_id, session_id, tool_call_id, tool_name, args_json,
            side_effect, idempotency_key, status, attempt, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 1, ?)
        `);
        insertStmt.run(
          execId,
          input.runId,
          input.sessionId,
          input.toolCallId,
          input.toolName,
          JSON.stringify(input.args),
          input.sideEffect,
          input.idempotencyKey,
          now
        );

        this.db.prepare('UPDATE runs SET tool_calls = tool_calls + 1, updated_at = ? WHERE id = ?').run(now, input.runId);

        return {
          existing: false,
          execution: {
            id: execId,
            runId: input.runId,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            args: input.args,
            sideEffect: input.sideEffect,
            idempotencyKey: input.idempotencyKey,
            status: 'running',
            attempt: 1,
            startedAt: now,
          },
        };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to begin tool execution', err);
    }
  }

  async completeToolExecution(executionId: Id, result: ToolResult, stepIndex: number): Promise<Message> {
    const now = Date.now();
    const msgId = generateId('msg');

    try {
      return this.runInTransaction(() => {
        const execStmt = this.db.prepare('SELECT * FROM tool_executions WHERE id = ?');
        const execRow: any = execStmt.get(executionId);
        if (!execRow) throw new DomainError(`Tool execution ${executionId} not found`, 'TOOL_EXECUTION_NOT_FOUND');

        const durationMs = now - Number(execRow.started_at);
        const isError = result.status === 'error';
        const status = isError ? 'failed' : result.status === 'awaiting_approval' ? 'awaiting_approval' : 'succeeded';

        // 1. 更新 tool_executions
        const updateExecStmt = this.db.prepare(`
          UPDATE tool_executions SET
            status = ?,
            result_json = ?,
            error_code = ?,
            finished_at = ?,
            duration_ms = ?
          WHERE id = ?
        `);
        updateExecStmt.run(
          status,
          JSON.stringify(result),
          result.error?.code ?? null,
          now,
          durationMs,
          executionId
        );

        // 2. 追加 Message (tool_result)
        const sessStmt = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?');
        const sess: any = sessStmt.get(execRow.session_id);
        const currentSeq = Number(sess.next_seq);

        this.db.prepare('UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(now, execRow.session_id);

        const toolContent: ContentBlock[] = [
          {
            type: 'tool_result',
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            isError,
            content: result.content,
            data: result.data,
          },
        ];

        const msgStmt = this.db.prepare(`
          INSERT INTO messages (
            id, session_id, run_id, seq, step_index, role, content_json,
            synthetic, excluded_from_context, created_at
          ) VALUES (?, ?, ?, ?, ?, 'tool', ?, 0, 0, ?)
        `);
        msgStmt.run(msgId, execRow.session_id, execRow.run_id, currentSeq, stepIndex, JSON.stringify(toolContent), now);

        return {
          id: msgId,
          sessionId: execRow.session_id,
          runId: execRow.run_id,
          seq: currentSeq,
          stepIndex,
          role: 'tool',
          content: toolContent,
          synthetic: false,
          excludedFromContext: false,
          createdAt: now,
        };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to complete tool execution', err);
    }
  }

  async appendSyntheticToolResult(
    runId: Id,
    toolCallId: string,
    toolName: string,
    content: string,
    stepIndex: number
  ): Promise<void> {
    const now = Date.now();
    const msgId = generateId('msg');

    this.runInTransaction(() => {
      const runRow: any = this.db.prepare('SELECT session_id FROM runs WHERE id = ?').get(runId);
      if (!runRow) return;

      const sessStmt = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?');
      const sess: any = sessStmt.get(runRow.session_id);
      const currentSeq = Number(sess.next_seq);

      this.db.prepare('UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(now, runRow.session_id);

      const toolContent: ContentBlock[] = [
        {
          type: 'tool_result',
          toolCallId,
          toolName,
          isError: true,
          content,
        },
      ];

      this.db.prepare(`
        INSERT INTO messages (
          id, session_id, run_id, seq, step_index, role, content_json,
          synthetic, excluded_from_context, created_at
        ) VALUES (?, ?, ?, ?, ?, 'tool', ?, 1, 0, ?)
      `).run(msgId, runRow.session_id, runId, currentSeq, stepIndex, JSON.stringify(toolContent), now);
    });
  }

  async suspendForInput(runId: Id, pending: PendingInput, elapsedMs: number): Promise<Run> {
    const now = Date.now();
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
        if (runRow.status !== 'running') {
          throw new InvalidRunStateError(runId, runRow.status, 'waiting_input');
        }

        this.db.prepare(`
          UPDATE runs SET
            status = 'waiting_input',
            pending_input_json = ?,
            active_elapsed_ms = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
        `).run(JSON.stringify(pending), elapsedMs, now, runId);

        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to suspend run for input', err);
    }
  }

  async resumeFromInput(runId: Id, leaseOwner: string, leaseMs: number): Promise<Run> {
    const now = Date.now();
    const leaseExpiresAt = now + leaseMs;
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
        if (runRow.status !== 'waiting_input') {
          throw new InvalidRunStateError(runId, runRow.status, 'running');
        }

        this.db.prepare(`
          UPDATE runs SET
            status = 'running',
            pending_input_json = NULL,
            lease_owner = ?,
            lease_expires_at = ?,
            version = version + 1,
            updated_at = ?
          WHERE id = ?
        `).run(leaseOwner, leaseExpiresAt, now, runId);

        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to resume run from input', err);
    }
  }

  async requestCancel(runId: Id): Promise<Run> {
    const now = Date.now();
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
        if (runRow.status !== 'running') {
          return this.mapRunRow(runRow);
        }

        this.db.prepare(`
          UPDATE runs SET
            status = 'cancelling',
            version = version + 1,
            updated_at = ?
          WHERE id = ?
        `).run(now, runId);

        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to request cancel', err);
    }
  }

  async finishRun(
    runId: Id,
    input: {
      status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
      stopReason: StopReason;
      error?: RuntimeErrorInfo;
      elapsedMs: number;
    }
  ): Promise<Run> {
    const now = Date.now();
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');

        this.db.prepare(`
          UPDATE runs SET
            status = ?,
            stop_reason = ?,
            error_json = ?,
            active_elapsed_ms = ?,
            lease_owner = NULL,
            lease_expires_at = NULL,
            version = version + 1,
            updated_at = ?,
            finished_at = ?
          WHERE id = ?
        `).run(
          input.status,
          input.stopReason,
          input.error ? JSON.stringify(input.error) : null,
          input.elapsedMs,
          now,
          now,
          runId
        );

        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to finish run', err);
    }
  }

  async heartbeat(runId: Id, leaseOwner: string, leaseMs: number): Promise<void> {
    const now = Date.now();
    const leaseExpiresAt = now + leaseMs;
    const stmt = this.db.prepare(`
      UPDATE runs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status IN ('running','cancelling')
    `);
    const res = stmt.run(leaseExpiresAt, now, runId, leaseOwner);
    if (res.changes === 0) {
      throw new DomainError(`Failed to heartbeat run ${runId}, lost lease or invalid state`, 'LEASE_LOST');
    }
  }

  async nextStepIndex(runId: Id): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT MAX(step_index) as max_step FROM messages WHERE run_id = ?
    `);
    const row: any = stmt.get(runId);
    if (!row || row.max_step == null) return 0;
    return Number(row.max_step) + 1;
  }

  async listMessages(
    sessionId: Id,
    range?: { fromSeq?: number; toSeq?: number; includeExcluded?: boolean }
  ): Promise<Message[]> {
    let sql = 'SELECT * FROM messages WHERE session_id = ?';
    const params: any[] = [sessionId];

    if (range?.fromSeq !== undefined) {
      sql += ' AND seq >= ?';
      params.push(range.fromSeq);
    }
    if (range?.toSeq !== undefined) {
      sql += ' AND seq <= ?';
      params.push(range.toSeq);
    }
    if (!range?.includeExcluded) {
      sql += ' AND excluded_from_context = 0';
    }
    sql += ' ORDER BY seq ASC';

    const rows: any[] = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      id: r.id,
      sessionId: r.session_id,
      runId: r.run_id ?? null,
      seq: Number(r.seq),
      stepIndex: r.step_index !== null ? Number(r.step_index) : null,
      role: r.role,
      content: JSON.parse(r.content_json),
      usage: r.usage_json ? JSON.parse(r.usage_json) : undefined,
      model: r.model ?? undefined,
      synthetic: Boolean(r.synthetic),
      excludedFromContext: Boolean(r.excluded_from_context),
      exclusionReason: r.exclusion_reason ?? undefined,
      createdAt: Number(r.created_at),
    }));
  }

  async listRecentMessages(sessionId: Id, opts: { afterSeq?: number; limit: number }): Promise<Message[]> {
    let sql = 'SELECT * FROM messages WHERE session_id = ? AND excluded_from_context = 0';
    const params: any[] = [sessionId];

    if (opts.afterSeq !== undefined) {
      sql += ' AND seq > ?';
      params.push(opts.afterSeq);
    }
    sql += ' ORDER BY seq DESC LIMIT ?';
    params.push(opts.limit);

    const rows: any[] = this.db.prepare(sql).all(...params);
    return rows.reverse().map(r => ({
      id: r.id,
      sessionId: r.session_id,
      runId: r.run_id ?? null,
      seq: Number(r.seq),
      stepIndex: r.step_index !== null ? Number(r.step_index) : null,
      role: r.role,
      content: JSON.parse(r.content_json),
      usage: r.usage_json ? JSON.parse(r.usage_json) : undefined,
      model: r.model ?? undefined,
      synthetic: Boolean(r.synthetic),
      excludedFromContext: Boolean(r.excluded_from_context),
      createdAt: Number(r.created_at),
    }));
  }

  async excludeMessages(sessionId: Id, seqs: number[], reason: string): Promise<void> {
    if (seqs.length === 0) return;
    this.runInTransaction(() => {
      const placeholders = seqs.map(() => '?').join(',');
      this.db.prepare(`
        UPDATE messages SET excluded_from_context = 1, exclusion_reason = ?
        WHERE session_id = ? AND seq IN (${placeholders})
      `).run(reason, sessionId, ...seqs);

      const minSeq = Math.min(...seqs);
      const maxSeq = Math.max(...seqs);
      // Superseded rows must be included. Revert reactivates the newest non-stale
      // summary at the cut, and that row may be an older summary of this same span.
      this.db.prepare(`
        UPDATE summaries SET status = 'stale'
        WHERE session_id = ? AND status != 'stale'
          AND NOT (to_seq < ? OR from_seq > ?)
      `).run(sessionId, minSeq, maxSeq);
    });
  }

  async getActiveSummary(sessionId: Id): Promise<Summary | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM summaries 
      WHERE session_id = ? AND status = 'active'
      ORDER BY to_seq DESC LIMIT 1
    `);
    const row: any = stmt.get(sessionId);
    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.session_id,
      fromSeq: Number(row.from_seq),
      toSeq: Number(row.to_seq),
      content: row.content,
      tokenEstimate: Number(row.token_estimate),
      model: row.model,
      promptVersion: row.prompt_version,
      status: row.status,
      supersedesId: row.supersedes_id ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  async saveSummary(input: NewSummary): Promise<Summary> {
    const id = generateId('sum');
    const now = Date.now();

    try {
      return this.runInTransaction(() => {
        if (input.supersedesId) {
          this.db.prepare(`UPDATE summaries SET status = 'superseded' WHERE id = ?`).run(input.supersedesId);
        }

        this.db.prepare(`
          INSERT INTO summaries (
            id, session_id, from_seq, to_seq, content, token_estimate,
            model, prompt_version, status, supersedes_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(
          id,
          input.sessionId,
          input.fromSeq,
          input.toSeq,
          input.content,
          input.tokenEstimate,
          input.model,
          input.promptVersion,
          input.supersedesId ?? null,
          now
        );

        return {
          id,
          sessionId: input.sessionId,
          fromSeq: input.fromSeq,
          toSeq: input.toSeq,
          content: input.content,
          tokenEstimate: input.tokenEstimate,
          model: input.model,
          promptVersion: input.promptVersion,
          status: 'active',
          supersedesId: input.supersedesId,
          createdAt: now,
        };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to save summary', err);
    }
  }

  async appendEvent(e: { runId: Id; sessionId: Id; type: string; payload: unknown }): Promise<PersistedEvent> {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO run_events (run_id, session_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const res = stmt.run(e.runId, e.sessionId, e.type, JSON.stringify(e.payload), now);
    return {
      id: Number(res.lastInsertRowid),
      runId: e.runId,
      sessionId: e.sessionId,
      type: e.type,
      payload: e.payload,
      createdAt: now,
    };
  }

  async listEvents(runId: Id, afterId?: number): Promise<PersistedEvent[]> {
    let sql = 'SELECT * FROM run_events WHERE run_id = ?';
    const params: any[] = [runId];
    if (afterId !== undefined) {
      sql += ' AND id > ?';
      params.push(afterId);
    }
    sql += ' ORDER BY id ASC';

    const rows: any[] = this.db.prepare(sql).all(...params);
    return rows.map(r => ({
      id: Number(r.id),
      runId: r.run_id,
      sessionId: r.session_id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      createdAt: Number(r.created_at),
    }));
  }

  async findRunsNeedingRecovery(now: number): Promise<Run[]> {
    const stmt = this.db.prepare(`
      SELECT id FROM runs 
      WHERE status IN ('running','cancelling') AND lease_expires_at < ?
    `);
    const rows: any[] = stmt.all(now);
    const runs: Run[] = [];
    for (const row of rows) {
      const r = await this.getRun(row.id);
      if (r) runs.push(r);
    }
    return runs;
  }

  async listOpenToolExecutions(runId: Id): Promise<ToolExecutionRecord[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM tool_executions 
      WHERE run_id = ? AND status IN ('running','awaiting_approval')
    `);
    const rows: any[] = stmt.all(runId);
    return rows.map(r => this.mapToolExecution(r));
  }

  async markInterrupted(runId: Id, resolutions: ToolResolution[]): Promise<Run> {
    const now = Date.now();
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');

        const sessStmt = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?');
        const sess: any = sessStmt.get(runRow.session_id);
        let nextSeq = Number(sess.next_seq);

        for (const res of resolutions) {
          this.db.prepare(`
            UPDATE tool_executions SET
              status = ?,
              error_code = ?,
              finished_at = ?
            WHERE id = ?
          `).run(res.status, res.errorCode, now, res.toolExecutionId);

          const msgId = generateId('msg');
          const toolContent: ContentBlock[] = [
            {
              type: 'tool_result',
              toolCallId: res.syntheticMessage.toolCallId,
              toolName: res.syntheticMessage.toolName,
              isError: true,
              content: res.syntheticMessage.content,
            },
          ];

          this.db.prepare(`
            INSERT INTO messages (
              id, session_id, run_id, seq, step_index, role, content_json,
              synthetic, excluded_from_context, created_at
            ) VALUES (?, ?, ?, ?, NULL, 'tool', ?, 1, 0, ?)
          `).run(msgId, runRow.session_id, runId, nextSeq++, JSON.stringify(toolContent), now);
        }

        this.db.prepare('UPDATE sessions SET next_seq = ?, updated_at = ? WHERE id = ?').run(nextSeq, now, runRow.session_id);

        this.db.prepare(`
          UPDATE runs SET
            status = 'interrupted',
            stop_reason = 'crashed',
            lease_owner = NULL,
            lease_expires_at = NULL,
            version = version + 1,
            updated_at = ?,
            finished_at = ?
          WHERE id = ?
        `).run(now, now, runId);

        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to mark run interrupted', err);
    }
  }

  async appendRunMessage(input: { runId: Id; content: ContentBlock[] }): Promise<Message> {
    const now = Date.now();
    const msgId = generateId('msg');
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(input.runId);
        if (!runRow) throw new DomainError(`Run ${input.runId} not found`, 'RUN_NOT_FOUND');
        const sess: any = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?').get(runRow.session_id);
        const seq = Number(sess.next_seq);
        this.db.prepare('UPDATE sessions SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(now, runRow.session_id);
        this.db.prepare(`
          INSERT INTO messages (
            id, session_id, run_id, seq, step_index, role, content_json,
            synthetic, excluded_from_context, created_at
          ) VALUES (?, ?, ?, ?, NULL, 'user', ?, 0, 0, ?)
        `).run(msgId, runRow.session_id, input.runId, seq, JSON.stringify(input.content), now);
        return {
          id: msgId,
          sessionId: runRow.session_id,
          runId: input.runId,
          seq,
          stepIndex: null,
          role: 'user' as const,
          content: input.content,
          synthetic: false,
          excludedFromContext: false,
          createdAt: now,
        };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to append run message', err);
    }
  }

  async markAwaitingApproval(executionId: Id, preconditionHash: string): Promise<ToolExecutionRecord> {
    const result = this.db.prepare(`
      UPDATE tool_executions
      SET status = 'awaiting_approval', precondition_hash = ?
      WHERE id = ? AND status IN ('running','awaiting_approval')
    `).run(preconditionHash, executionId);
    if (result.changes === 0) {
      throw new DomainError(`Tool execution ${executionId} is not awaiting approval`, 'APPROVAL_NOT_PENDING');
    }
    return this.requireToolExecution(executionId);
  }

  async setApprovalDecision(executionId: Id, decision: 'approve' | 'deny'): Promise<ToolExecutionRecord> {
    const result = this.db.prepare(`
      UPDATE tool_executions
      SET approval_decision = ?
      WHERE id = ? AND status = 'awaiting_approval'
    `).run(decision, executionId);
    if (result.changes === 0) {
      throw new DomainError(`Tool execution ${executionId} is not awaiting approval`, 'APPROVAL_NOT_PENDING');
    }
    return this.requireToolExecution(executionId);
  }

  async markToolClosed(executionId: Id, status: 'cancelled' | 'failed' | 'unknown', errorCode: string): Promise<void> {
    const now = Date.now();
    this.db.prepare(`
      UPDATE tool_executions
      SET status = ?, error_code = ?, finished_at = ?
      WHERE id = ? AND status IN ('running','awaiting_approval')
    `).run(status, errorCode, now, executionId);
  }

  async abortOpenWait(runId: Id, input: {
    status: 'cancelled' | 'interrupted';
    stopReason: StopReason;
    message: string;
    resolveToolsAs: 'cancelled' | 'recovery';
  }): Promise<Run> {
    const now = Date.now();
    try {
      return this.runInTransaction(() => {
        const runRow: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        if (!runRow) throw new DomainError(`Run ${runId} not found`, 'RUN_NOT_FOUND');
        if (runRow.status !== 'waiting_input') {
          throw new InvalidRunStateError(runId, runRow.status, input.status);
        }

        const messages: any[] = this.db.prepare(
          'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
        ).all(runRow.session_id);
        let lastAssistant: any = null;
        for (const row of messages) {
          if (row.run_id === runId && row.role === 'assistant') lastAssistant = row;
        }
        const answered = new Set<string>();
        for (const row of messages) {
          if (row.role !== 'tool') continue;
          const content = JSON.parse(row.content_json) as ContentBlock[];
          for (const block of content) {
            if (block.type === 'tool_result') answered.add(block.toolCallId);
          }
        }

        const sess: any = this.db.prepare('SELECT next_seq FROM sessions WHERE id = ?').get(runRow.session_id);
        let nextSeq = Number(sess.next_seq);
        if (lastAssistant) {
          const content = JSON.parse(lastAssistant.content_json) as ContentBlock[];
          for (const block of content) {
            if (block.type !== 'tool_call' || answered.has(block.toolCallId)) continue;
            const msgId = generateId('msg');
            const toolContent: ContentBlock[] = [{
              type: 'tool_result',
              toolCallId: block.toolCallId,
              toolName: block.toolName,
              isError: true,
              content: input.message,
            }];
            this.db.prepare(`
              INSERT INTO messages (
                id, session_id, run_id, seq, step_index, role, content_json,
                synthetic, excluded_from_context, created_at
              ) VALUES (?, ?, ?, ?, ?, 'tool', ?, 1, 0, ?)
            `).run(
              msgId,
              runRow.session_id,
              runId,
              nextSeq++,
              lastAssistant.step_index,
              JSON.stringify(toolContent),
              now
            );
          }
        }

        const openTools: any[] = this.db.prepare(`
          SELECT * FROM tool_executions
          WHERE run_id = ? AND status IN ('running','awaiting_approval')
        `).all(runId);
        for (const tool of openTools) {
          let status = 'cancelled';
          let errorCode = 'CANCELLED';
          if (input.resolveToolsAs === 'recovery') {
            status = tool.side_effect === 'non_idempotent' ? 'unknown' : 'failed';
            errorCode = 'OUTCOME_UNKNOWN';
          }
          this.db.prepare(`
            UPDATE tool_executions
            SET status = ?, error_code = ?, finished_at = ?
            WHERE id = ?
          `).run(status, errorCode, now, tool.id);
        }

        this.db.prepare('UPDATE sessions SET next_seq = ?, updated_at = ? WHERE id = ?').run(nextSeq, now, runRow.session_id);
        this.db.prepare(`
          UPDATE runs SET
            status = ?,
            stop_reason = ?,
            pending_input_json = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            version = version + 1,
            updated_at = ?,
            finished_at = ?
          WHERE id = ?
        `).run(input.status, input.stopReason, now, now, runId);
        const updated: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
        return this.mapRunRow(updated);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to abort waiting run', err);
    }
  }

  async enqueueTurnMessage(input: {
    sessionId: Id;
    kind: 'steer' | 'follow_up';
    content: ContentBlock[];
  }): Promise<QueuedTurnMessage> {
    const id = generateId('qmsg');
    const now = Date.now();
    const session = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(input.sessionId);
    if (!session) throw new DomainError(`Session ${input.sessionId} not found`, 'SESSION_NOT_FOUND');
    this.db.prepare(`
      INSERT INTO queued_messages (id, session_id, kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, input.sessionId, input.kind, JSON.stringify(input.content), now);
    return { id, sessionId: input.sessionId, kind: input.kind, content: input.content, createdAt: now };
  }

  async takeQueuedMessages(sessionId: Id, kind?: 'steer' | 'follow_up'): Promise<QueuedTurnMessage[]> {
    return this.runInTransaction(() => {
      const sql = kind
        ? 'SELECT * FROM queued_messages WHERE session_id = ? AND kind = ? ORDER BY created_at ASC, id ASC'
        : 'SELECT * FROM queued_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC';
      const rows: any[] = kind
        ? this.db.prepare(sql).all(sessionId, kind)
        : this.db.prepare(sql).all(sessionId);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM queued_messages WHERE id IN (${placeholders})`).run(...ids);
      return rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        content: JSON.parse(row.content_json) as ContentBlock[],
        createdAt: Number(row.created_at),
      }));
    });
  }

  async listWaitingRuns(): Promise<Run[]> {
    const rows = this.db.prepare(`SELECT id FROM runs WHERE status = 'waiting_input'`).all() as Array<{ id: string }>;
    const runs: Run[] = [];
    for (const row of rows) {
      const run = await this.getRun(row.id);
      if (run) runs.push(run);
    }
    return runs;
  }

  async listToolExecutions(runId: Id): Promise<ToolExecutionRecord[]> {
    const rows: any[] = this.db
      .prepare('SELECT * FROM tool_executions WHERE run_id = ? ORDER BY started_at ASC, id ASC')
      .all(runId);
    return rows.map((row) => this.mapToolExecution(row));
  }

  async saveFileSnapshot(input: NewStepFileSnapshot): Promise<StepFileSnapshot> {
    const id = generateId('snap');
    let createdAt = Date.now();
    const last: any = this.db
      .prepare('SELECT MAX(created_at) AS max_created FROM step_file_snapshots WHERE session_id = ?')
      .get(input.sessionId);
    if (last?.max_created != null && Number(last.max_created) >= createdAt) {
      createdAt = Number(last.max_created) + 1;
    }

    try {
      this.db.prepare(`
        INSERT INTO step_file_snapshots (
          id, session_id, run_id, step_index, checkpoint_seq, tool_execution_id,
          tool_call_id, tool_name, file_path, change_type, existed_before,
          before_content_b64, before_hash, after_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.sessionId,
        input.runId,
        input.stepIndex,
        input.checkpointSeq,
        input.toolExecutionId,
        input.toolCallId,
        input.toolName,
        input.filePath,
        input.changeType,
        input.existedBefore ? 1 : 0,
        input.beforeContentB64 ?? null,
        input.beforeHash ?? null,
        input.afterHash ?? null,
        createdAt
      );
      const row: any = this.db.prepare('SELECT * FROM step_file_snapshots WHERE id = ?').get(id);
      return this.mapFileSnapshot(row);
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to save file snapshot', err);
    }
  }

  async listFileSnapshots(
    sessionId: Id,
    opts?: { afterSeq?: number; runId?: Id }
  ): Promise<StepFileSnapshot[]> {
    let sql = 'SELECT * FROM step_file_snapshots WHERE session_id = ?';
    const params: any[] = [sessionId];
    if (opts?.afterSeq !== undefined) {
      sql += ' AND checkpoint_seq > ?';
      params.push(opts.afterSeq);
    }
    if (opts?.runId !== undefined) {
      sql += ' AND run_id = ?';
      params.push(opts.runId);
    }
    sql += ' ORDER BY created_at ASC, id ASC';
    const rows: any[] = this.db.prepare(sql).all(...params);
    return rows.map((row) => this.mapFileSnapshot(row));
  }

  async revertSessionToSeq(
    sessionId: Id,
    targetSeq: number
  ): Promise<{
    deletedMessages: number;
    invalidatedSummaries: number;
    deletedSnapshots: number;
    deletedEpisodes: number;
    forgottenMemories: number;
  }> {
    try {
      return this.runInTransaction(() => {
        const sess: any = this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
        if (!sess) {
          throw new DomainError(`Session ${sessionId} not found`, 'SESSION_NOT_FOUND');
        }

        const active: any = this.db.prepare(`
          SELECT id FROM runs
          WHERE session_id = ? AND status IN ('running','waiting_input','cancelling')
        `).get(sessionId);
        if (active) {
          throw new SessionBusyError(sessionId, active.id);
        }

        if (!Number.isInteger(targetSeq) || targetSeq < 0) {
          throw new DomainError(`Invalid target sequence: ${targetSeq}`, 'INVALID_TARGET_SEQ');
        }

        const maxRow: any = this.db
          .prepare('SELECT MAX(seq) AS max_seq FROM messages WHERE session_id = ?')
          .get(sessionId);
        const maxSeq = maxRow?.max_seq == null ? 0 : Number(maxRow.max_seq);
        if (targetSeq > maxSeq) {
          throw new DomainError(
            `Target sequence ${targetSeq} is beyond current max seq ${maxSeq}`,
            'TARGET_SEQ_OUT_OF_RANGE'
          );
        }

        const now = Date.now();
        const deletedMessages = Number(
          this.db.prepare('DELETE FROM messages WHERE session_id = ? AND seq > ?').run(sessionId, targetSeq).changes
        );
        this.db
          .prepare('UPDATE sessions SET next_seq = ?, updated_at = ? WHERE id = ?')
          .run(targetSeq + 1, now, sessionId);
        const deletedEpisodes = Number(
          this.db
            .prepare('DELETE FROM episodes WHERE session_id = ? AND to_seq > ?')
            .run(sessionId, targetSeq).changes
        );
        this.db.prepare(`
          UPDATE episodes SET summary_id = NULL
          WHERE session_id = ?
            AND summary_id IN (SELECT id FROM summaries WHERE session_id = ? AND to_seq > ?)
        `).run(sessionId, sessionId, targetSeq);
        const forgottenMemories = Number(
          this.db.prepare(`
            UPDATE memories
            SET status = 'deleted', status_reason = 'reverted with transcript', updated_at = ?
            WHERE status = 'active'
              AND source_session_id = ?
              AND source_ref LIKE 'msg:%'
              AND CAST(substr(source_ref, 5) AS INTEGER) > ?
              AND (
                (scope_type = 'session' AND scope_id = ?)
                OR scope_type = 'user'
                OR scope_type = 'agent'
              )
          `).run(now, sessionId, targetSeq, sessionId).changes
        );
        const invalidatedSummaries = Number(
          this.db
            .prepare('DELETE FROM summaries WHERE session_id = ? AND to_seq > ?')
            .run(sessionId, targetSeq).changes
        );
        this.db.prepare(`
          UPDATE summaries SET status = 'stale'
          WHERE session_id = ? AND status != 'stale'
            AND EXISTS (
              SELECT 1 FROM messages
              WHERE messages.session_id = summaries.session_id
                AND messages.excluded_from_context = 1
                AND messages.seq BETWEEN summaries.from_seq AND summaries.to_seq
            )
        `).run(sessionId);
        const priorSummary: any = this.db.prepare(`
          SELECT id, status FROM summaries
          WHERE session_id = ? AND to_seq <= ? AND status != 'stale'
          ORDER BY to_seq DESC, created_at DESC
          LIMIT 1
        `).get(sessionId, targetSeq);
        if (priorSummary) {
          this.db.prepare(`
            UPDATE summaries SET status = 'superseded'
            WHERE session_id = ? AND status = 'active' AND id != ?
          `).run(sessionId, priorSummary.id);
          if (priorSummary.status !== 'active') {
            this.db.prepare(`UPDATE summaries SET status = 'active' WHERE id = ?`).run(priorSummary.id);
          }
        }
        this.db.prepare('DELETE FROM queued_messages WHERE session_id = ?').run(sessionId);
        const deletedSnapshots = Number(
          this.db
            .prepare('DELETE FROM step_file_snapshots WHERE session_id = ? AND checkpoint_seq > ?')
            .run(sessionId, targetSeq).changes
        );

        return { deletedMessages, invalidatedSummaries, deletedSnapshots, deletedEpisodes, forgottenMemories };
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to revert session', err);
    }
  }

  private mapFileSnapshot(row: any): StepFileSnapshot {
    return {
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      stepIndex: Number(row.step_index),
      checkpointSeq: Number(row.checkpoint_seq),
      toolExecutionId: row.tool_execution_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      filePath: row.file_path,
      changeType: row.change_type,
      existedBefore: Number(row.existed_before) === 1,
      beforeContentB64: row.before_content_b64 ?? undefined,
      beforeHash: row.before_hash ?? undefined,
      afterHash: row.after_hash ?? undefined,
      createdAt: Number(row.created_at),
    };
  }

  async insertMemory(input: NewMemory): Promise<MemoryRecord> {
    const now = Date.now();
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
    const confidence = input.confidence ?? 1.0;
    const contentKey = input.contentKey ?? memoryContentKey(input.kind, input.content);
    const salience = input.salience ?? (input.pinned ? 0.9 : 0.5);
    const tagsJson = JSON.stringify(input.tags ?? []);

    try {
      return this.runInTransaction(() => {
        const existing: any = this.db.prepare(`
          SELECT * FROM memories
          WHERE scope_type = ? AND scope_id = ? AND content_key = ? AND status = 'active'
        `).get(input.scopeType, input.scopeId, contentKey);
        if (existing) {
          const nextSalience = Math.min(1, Number(existing.salience ?? 0.5) + 0.05);
          const nextConfidence = Math.max(Number(existing.confidence), confidence);
          this.db.prepare(`
            UPDATE memories
            SET salience = ?, confidence = ?, access_count = access_count + 1,
                pinned = CASE WHEN ? = 1 THEN 1 ELSE pinned END,
                updated_at = ?
            WHERE id = ?
          `).run(nextSalience, nextConfidence, input.pinned ? 1 : 0, now, existing.id);
          const row: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(existing.id);
          return this.mapMemoryRow(row);
        }

        const id = generateId('mem');
        this.db.prepare(`
          INSERT INTO memories (
            id, scope_type, scope_id, kind, content, source_type, source_ref,
            source_session_id, confidence, salience, pinned, content_key, access_count,
            tags_json, status, supersedes_id, status_reason, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', NULL, NULL, ?, ?, ?)
        `).run(
          id,
          input.scopeType,
          input.scopeId,
          input.kind,
          input.content,
          input.sourceType,
          input.sourceRef ?? null,
          input.sourceSessionId ?? null,
          confidence,
          salience,
          input.pinned ? 1 : 0,
          contentKey,
          tagsJson,
          input.createdBy,
          createdAt,
          now
        );
        const row: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        return this.mapMemoryRow(row);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to insert memory', err);
    }
  }

  async queryMemories(q: MemoryRecallQuery): Promise<MemoryRecord[]> {
    if (q.limit <= 0) return [];
    const bindings = q.bindings?.filter((binding) => binding.scopeId.length > 0) ?? [];
    if (q.bindings !== undefined && bindings.length === 0) return [];
    if (q.bindings === undefined && q.scopes.length === 0) return [];

    let sql = `SELECT * FROM memories WHERE status = 'active'`;
    const params: any[] = [];
    if (q.bindings !== undefined) {
      sql += ` AND (${bindings.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ')})`;
      for (const binding of bindings) params.push(binding.scopeType, binding.scopeId);
    } else {
      sql += ` AND scope_type IN (${q.scopes.map(() => '?').join(',')})`;
      params.push(...q.scopes);
      if (q.scopeId !== undefined) {
        sql += ' AND scope_id = ?';
        params.push(q.scopeId);
      }
    }
    sql += ' ORDER BY pinned DESC, salience DESC, confidence DESC, updated_at DESC LIMIT ?';
    params.push(MEMORY_RECALL_CANDIDATE_CAP);

    const rows: any[] = this.db.prepare(sql).all(...params);
    return selectRankedMemories(rows.map((row) => this.mapMemoryRow(row)), q.query, q.limit);
  }

  async correctMemory(
    id: Id,
    input: { content: string; reason: string; by: string }
  ): Promise<MemoryRecord> {
    const now = Date.now();
    const nextId = generateId('mem');

    try {
      return this.runInTransaction(() => {
        const prev: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        if (!prev) {
          throw new DomainError(`Memory ${id} not found`, 'MEMORY_NOT_FOUND');
        }
        if (prev.status !== 'active') {
          throw new DomainError(`Memory ${id} is not active`, 'MEMORY_NOT_ACTIVE');
        }

        const contentKey = memoryContentKey(String(prev.kind), input.content);
        const clash: any = this.db.prepare(`
          SELECT * FROM memories
          WHERE scope_type = ? AND scope_id = ? AND content_key = ? AND status = 'active' AND id != ?
        `).get(prev.scope_type, prev.scope_id, contentKey, id);

        this.db.prepare(`
          UPDATE memories SET status = 'corrected', status_reason = ?, updated_at = ? WHERE id = ?
        `).run(input.reason, now, id);

        if (clash) {
          this.db.prepare(`
            UPDATE memories
            SET salience = MIN(1, salience + 0.05),
                confidence = MAX(confidence, ?),
                access_count = access_count + 1,
                pinned = CASE WHEN ? = 1 THEN 1 ELSE pinned END,
                updated_at = ?
            WHERE id = ?
          `).run(Number(prev.confidence), Number(prev.pinned ?? 0), now, clash.id);
          const row: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(clash.id);
          return this.mapMemoryRow(row);
        }

        this.db.prepare(`
          INSERT INTO memories (
            id, scope_type, scope_id, kind, content, source_type, source_ref,
            source_session_id, confidence, salience, pinned, content_key, access_count,
            tags_json, status, supersedes_id, status_reason, created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, NULL, ?, ?, ?)
        `).run(
          nextId,
          prev.scope_type,
          prev.scope_id,
          prev.kind,
          input.content,
          prev.source_type,
          prev.source_ref ?? null,
          prev.source_session_id ?? null,
          Number(prev.confidence),
          Number(prev.salience ?? 0.5),
          Number(prev.pinned ?? 0),
          contentKey,
          prev.tags_json ?? '[]',
          id,
          input.by,
          now,
          now
        );

        const row: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(nextId);
        return this.mapMemoryRow(row);
      });
    } catch (err: any) {
      if (err instanceof DomainError) throw err;
      throw new InfrastructureError('Failed to correct memory', err);
    }
  }

  async forgetMemory(id: Id, input: { reason: string; by: string }): Promise<void> {
    const now = Date.now();
    const prev: any = this.db.prepare('SELECT status FROM memories WHERE id = ?').get(id);
    if (!prev) {
      throw new DomainError(`Memory ${id} not found`, 'MEMORY_NOT_FOUND');
    }
    if (prev.status !== 'active') {
      throw new DomainError(`Memory ${id} is not active`, 'MEMORY_NOT_ACTIVE');
    }
    this.db.prepare(`
      UPDATE memories SET status = 'deleted', status_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(input.reason, now, id);
  }

  async getMemoryHistory(id: Id): Promise<MemoryRecord[]> {
    const initial: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!initial) return [];

    // Walk up to root
    let current = initial;
    const seen = new Set<string>([current.id]);
    while (current.supersedes_id && !seen.has(current.supersedes_id)) {
      const parent: any = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(current.supersedes_id);
      if (!parent) break;
      seen.add(parent.id);
      current = parent;
    }

    // Walk down the chain
    const chain: MemoryRecord[] = [this.mapMemoryRow(current)];
    const visited = new Set<string>([current.id]);
    while (true) {
      const children: any[] = this.db
        .prepare('SELECT * FROM memories WHERE supersedes_id = ? ORDER BY created_at ASC')
        .all(chain[chain.length - 1].id);
      const next = children.find((child) => !visited.has(child.id));
      if (!next) break;
      visited.add(next.id);
      chain.push(this.mapMemoryRow(next));
    }

    return chain;
  }

  async touchMemories(ids: Id[]): Promise<void> {
    if (ids.length === 0) return;
    const now = Date.now();
    const staleBefore = now - 60_000;
    const stmt = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1,
          last_accessed_at = ?,
          salience = MIN(1, salience + 0.02),
          updated_at = ?
      WHERE id = ? AND status = 'active'
        AND (last_accessed_at IS NULL OR last_accessed_at <= ?)
    `);
    this.runInTransaction(() => {
      for (const id of ids) stmt.run(now, now, id, staleBefore);
    });
  }

  async saveEpisode(input: NewEpisode): Promise<Episode> {
    const id = generateId('ep');
    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO episodes (
          id, session_id, summary_id, from_seq, to_seq, title, content,
          entities_json, token_estimate, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.sessionId,
        input.summaryId ?? null,
        input.fromSeq,
        input.toSeq,
        input.title,
        input.content,
        JSON.stringify(input.entities),
        input.tokenEstimate,
        now
      );
      const row: any = this.db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
      return this.mapEpisodeRow(row);
    } catch (err: any) {
      throw new InfrastructureError('Failed to save episode', err);
    }
  }

  async listEpisodes(sessionId: Id): Promise<Episode[]> {
    const rows: any[] = this.db.prepare(
      'SELECT * FROM episodes WHERE session_id = ? ORDER BY to_seq DESC, created_at DESC'
    ).all(sessionId);
    return rows.map((row) => this.mapEpisodeRow(row));
  }

  private mapEpisodeRow(row: any): Episode {
    let entities: string[] = [];
    try {
      const parsed = JSON.parse(row.entities_json ?? '[]');
      if (Array.isArray(parsed)) entities = parsed.filter((item) => typeof item === 'string');
    } catch {
      entities = [];
    }
    return {
      id: row.id,
      sessionId: row.session_id,
      summaryId: row.summary_id ?? undefined,
      fromSeq: Number(row.from_seq),
      toSeq: Number(row.to_seq),
      title: row.title,
      content: row.content,
      entities,
      tokenEstimate: Number(row.token_estimate ?? 0),
      createdAt: Number(row.created_at),
    };
  }

  private mapMemoryRow(row: any): MemoryRecord {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(row.tags_json ?? '[]');
      if (Array.isArray(parsed)) tags = parsed.filter((item) => typeof item === 'string');
    } catch {
      tags = [];
    }
    return {
      id: row.id,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      kind: row.kind,
      content: row.content,
      sourceType: row.source_type,
      sourceRef: row.source_ref ?? undefined,
      sourceSessionId: row.source_session_id ?? undefined,
      confidence: Number(row.confidence),
      salience: Number(row.salience ?? 0.5),
      pinned: Number(row.pinned ?? 0) === 1,
      contentKey: row.content_key ?? undefined,
      accessCount: Number(row.access_count ?? 0),
      lastAccessedAt: row.last_accessed_at != null ? Number(row.last_accessed_at) : undefined,
      tags,
      status: row.status,
      supersedesId: row.supersedes_id ?? undefined,
      statusReason: row.status_reason ?? undefined,
      createdBy: row.created_by,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private requireToolExecution(executionId: Id): ToolExecutionRecord {
    const row: any = this.db.prepare('SELECT * FROM tool_executions WHERE id = ?').get(executionId);
    if (!row) throw new DomainError(`Tool execution ${executionId} not found`, 'TOOL_EXECUTION_NOT_FOUND');
    return this.mapToolExecution(row);
  }

  private mapToolExecution(row: any): ToolExecutionRecord {
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      args: JSON.parse(row.args_json),
      sideEffect: row.side_effect,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      errorCode: row.error_code ?? undefined,
      approvalDecision: row.approval_decision ?? undefined,
      preconditionHash: row.precondition_hash ?? undefined,
      attempt: Number(row.attempt),
      startedAt: Number(row.started_at),
      finishedAt: row.finished_at ? Number(row.finished_at) : undefined,
      durationMs: row.duration_ms ? Number(row.duration_ms) : undefined,
    };
  }
}
