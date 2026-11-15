import { SqliteSessionStore } from './store/sqlite/sqlite-store.js';
import { InMemoryToolRegistry } from './tools/registry.js';
import { DefaultPermissionPolicy, SandboxPermissionPolicy, type SandboxMode } from './tools/permissions.js';
import { StandardToolExecutor } from './tools/executor.js';
import { StandardMemoryManager } from './memory/memory-manager.js';
import type { Summarizer } from './memory/ports.js';
import { createMemoryTools } from './memory/tools.js';
import { InMemoryEventBus } from './events/in-memory-event-bus.js';
import { AgentLoop } from './runtime/agent-loop.js';
import { RecoveryService } from './runtime/recovery.js';
import { AgentRuntime } from './runtime/agent-runtime.js';
import type { RuntimeHook } from './runtime/hooks.js';
import { createSubagentTool, type SubagentToolOptions } from './runtime/subagent.js';
import { ShadowFsTimeMachine, type ShadowFsOptions } from './runtime/time-machine.js';
import type { ModelAdapter } from './model/ports.js';

export interface CreateRuntimeOptions {
  dbPath?: string;
  modelAdapter: ModelAdapter;
  leaseOwner?: string;
  approvalMode?: 'always' | 'ask_for_side_effects' | 'never';
  summarizer?: Summarizer;
  hooks?: RuntimeHook[];
  enableSubagentTool?: boolean | Omit<SubagentToolOptions, 'registry'>;
  enableSpeculativePrefetch?: boolean;
  /** Register memory_remember, memory_recall, memory_correct, and memory_forget. Default true. */
  enableMemoryTools?: boolean;
  shadowFs?: boolean | ShadowFsOptions;
  /**
   * Project boundary. In-project reads and, in build mode, writes and commands
   * proceed without a prompt. Protected paths stay blocked.
   */
  sandbox?: { projectRoot: string; mode?: SandboxMode };
}

export function createAgentRuntime(opts: CreateRuntimeOptions): {
  runtime: AgentRuntime;
  registry: InMemoryToolRegistry;
  store: SqliteSessionStore;
  bus: InMemoryEventBus;
  memory: StandardMemoryManager;
  timeMachine: ShadowFsTimeMachine;
  permissions: DefaultPermissionPolicy | SandboxPermissionPolicy;
} {
  const store = new SqliteSessionStore(opts.dbPath ?? ':memory:');
  const bus = new InMemoryEventBus();
  const registry = new InMemoryToolRegistry();
  const permissionPolicy = opts.sandbox
    ? new SandboxPermissionPolicy(opts.sandbox.projectRoot, opts.sandbox.mode ?? 'build', opts.approvalMode ?? 'ask_for_side_effects')
    : new DefaultPermissionPolicy(opts.approvalMode ?? 'ask_for_side_effects');
  const executor = new StandardToolExecutor(registry, permissionPolicy);
  const memory = new StandardMemoryManager(store, opts.summarizer);
  if (opts.enableMemoryTools !== false) {
    for (const tool of createMemoryTools(memory.longTerm, {
      agentIdForSession: async (sessionId) => (await store.getSession(sessionId))?.config.memory?.agentId,
    })) registry.register(tool);
  }
  const shadowOpts = typeof opts.shadowFs === 'object' ? opts.shadowFs : undefined;
  const timeMachine = new ShadowFsTimeMachine(store, shadowOpts);
  const hooks: RuntimeHook[] = [...(opts.hooks ?? [])];
  if (opts.shadowFs) {
    hooks.push(timeMachine.createHook());
  }

  const loop = new AgentLoop({
    store,
    model: opts.modelAdapter,
    registry,
    executor,
    memory,
    bus,
    hooks,
    enableSpeculativePrefetch: opts.enableSpeculativePrefetch,
  });

  const recovery = new RecoveryService(store, bus);
  const runtime = new AgentRuntime(store, loop, bus, recovery, opts.leaseOwner);

  if (opts.enableSubagentTool) {
    const toolOpts = typeof opts.enableSubagentTool === 'object' ? opts.enableSubagentTool : {};
    registry.register(createSubagentTool(runtime, store, { ...toolOpts, registry }));
  }

  return { runtime, registry, store, bus, memory, timeMachine, permissions: permissionPolicy };
}
