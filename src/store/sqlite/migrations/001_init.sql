PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  title             TEXT,
  config_json       TEXT NOT NULL,
  next_seq          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  parent_session_id TEXT REFERENCES sessions(id),
  forked_from_seq   INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS runs (
  id                 TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL REFERENCES sessions(id),
  status             TEXT NOT NULL CHECK (status IN
                       ('running','waiting_input','cancelling','completed','failed','cancelled','interrupted')),
  stop_reason        TEXT,
  error_json         TEXT,
  limits_json        TEXT NOT NULL,
  model_calls        INTEGER NOT NULL DEFAULT 0,
  tool_calls         INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  active_elapsed_ms  INTEGER NOT NULL DEFAULT 0,
  pending_input_json TEXT,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  version            INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  finished_at        INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_one_active_per_session
  ON runs(session_id)
  WHERE status IN ('running','waiting_input','cancelling');

CREATE INDEX IF NOT EXISTS ix_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS messages (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  run_id                TEXT REFERENCES runs(id),
  seq                   INTEGER NOT NULL,
  step_index            INTEGER,
  role                  TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content_json          TEXT NOT NULL,
  usage_json            TEXT,
  model                 TEXT,
  token_estimate        INTEGER NOT NULL DEFAULT 0,
  synthetic             INTEGER NOT NULL DEFAULT 0,
  excluded_from_context INTEGER NOT NULL DEFAULT 0,
  exclusion_reason      TEXT,
  created_at            INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS ix_messages_run ON messages(run_id);

CREATE TABLE IF NOT EXISTS tool_executions (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES runs(id),
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  tool_call_id      TEXT NOT NULL,
  tool_name         TEXT NOT NULL,
  args_json         TEXT NOT NULL,
  side_effect       TEXT NOT NULL CHECK (side_effect IN ('none','idempotent','non_idempotent')),
  idempotency_key   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN
                      ('running','awaiting_approval','succeeded','failed','denied','cancelled','unknown')),
  result_json       TEXT,
  error_code        TEXT,
  attempt           INTEGER NOT NULL DEFAULT 1,
  started_at        INTEGER NOT NULL,
  finished_at       INTEGER,
  duration_ms       INTEGER,
  approval_decision TEXT CHECK (approval_decision IS NULL OR approval_decision IN ('approve','deny')),
  precondition_hash TEXT,
  UNIQUE (run_id, tool_call_id),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_tool_exec_status ON tool_executions(status);

CREATE TABLE IF NOT EXISTS run_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  session_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS queued_messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id),
  kind         TEXT NOT NULL CHECK (kind IN ('steer','follow_up')),
  content_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_queued_messages_session ON queued_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id),
  from_seq       INTEGER NOT NULL,
  to_seq         INTEGER NOT NULL,
  content        TEXT NOT NULL,
  token_estimate INTEGER NOT NULL,
  model          TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','stale','superseded')),
  supersedes_id  TEXT REFERENCES summaries(id),
  created_at     INTEGER NOT NULL,
  CHECK (from_seq <= to_seq)
);

CREATE INDEX IF NOT EXISTS ix_summaries_session ON summaries(session_id, status, to_seq);

CREATE TABLE IF NOT EXISTS memories (
  id             TEXT PRIMARY KEY,
  scope_type     TEXT NOT NULL CHECK (scope_type IN ('session','user','agent','global')),
  scope_id       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  content        TEXT NOT NULL,
  source_type    TEXT NOT NULL CHECK (source_type IN ('message','tool_result','user_explicit','system')),
  source_ref     TEXT,
  source_session_id TEXT,
  confidence     REAL NOT NULL DEFAULT 1.0,
  salience       REAL NOT NULL DEFAULT 0.5,
  pinned         INTEGER NOT NULL DEFAULT 0,
  content_key    TEXT,
  access_count   INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  tags_json      TEXT NOT NULL DEFAULT '[]',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','corrected','deleted')),
  supersedes_id  TEXT REFERENCES memories(id),
  status_reason  TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_memories_scope ON memories(scope_type, scope_id, status);
-- ux_memories_active_key is created in ensureRuntimeColumns after legacy
-- databases gain the content_key column. Creating it here breaks old files.

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
