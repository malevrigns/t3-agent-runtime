import * as os from 'node:os';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { createAgentRuntime } from './composition.js';
import { OpenAICompatibleAdapter } from './model/openai-adapter.js';
import { FakeModelAdapter } from './model/fake-adapter.js';
import type { ModelAdapter } from './model/ports.js';
import type { Principal } from './core/types.js';
import type { AgentRuntime } from './runtime/agent-runtime.js';
import type { RunOutcome } from './runtime/agent-loop.js';
import type { ScopeBinding } from './memory/ports.js';
import { SandboxPermissionPolicy, parseSandboxMode, type SandboxMode } from './tools/permissions.js';
import { resolveProjectPath } from './tools/sandbox.js';
import { AgentScreen } from './tui/screen.js';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
};

function databasePath(): string {
  if (process.env.PI_AGENT_DB) return process.env.PI_AGENT_DB;
  const dir = join(process.cwd(), '.pi-agent');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'runtime.sqlite');
}

function projectRootPath(): string {
  const dir = process.env.PI_AGENT_WORKSPACE || process.cwd();
  return path.resolve(dir);
}

function initialSandboxMode(): SandboxMode {
  return parseSandboxMode(process.env.PI_AGENT_PERM) ?? 'build';
}

const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', '.pi-agent', '.vscode', '.idea']);

function openProjectFile(projectRoot: string, targetPath: string, mode: SandboxMode, writing: boolean): string | { error: string } {
  const resolved = resolveProjectPath(projectRoot, targetPath);
  if (writing && resolved.protectedWrite && mode !== 'yolo') {
    return { error: `Path is protected: ${targetPath}` };
  }
  return resolved.absolute;
}

function evaluateMath(expression: string): number {
  const src = expression.replace(/\s+/g, '');
  if (!src || !/^[\d.+\-*/%()]+$/.test(src)) {
    throw new Error('unsupported expression');
  }
  let index = 0;
  const parseExpression = (): number => {
    let value = parseTerm();
    while (src[index] === '+' || src[index] === '-') {
      const operator = src[index++];
      const right = parseTerm();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    while (src[index] === '*' || src[index] === '/' || src[index] === '%') {
      const operator = src[index++];
      const right = parseFactor();
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('division by zero');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  const parseFactor = (): number => {
    if (src[index] === '+' || src[index] === '-') {
      const operator = src[index++];
      const value = parseFactor();
      return operator === '-' ? -value : value;
    }
    if (src[index] === '(') {
      index++;
      const value = parseExpression();
      if (src[index] !== ')') throw new Error('missing )');
      index++;
      return value;
    }
    const start = index;
    while (index < src.length && /[\d.]/.test(src[index])) index++;
    if (start === index) throw new Error('expected number');
    const value = Number(src.slice(start, index));
    if (Number.isNaN(value)) throw new Error('invalid number');
    return value;
  };
  const value = parseExpression();
  if (index !== src.length) throw new Error('trailing input');
  return value;
}

async function settleApproval(
  rl: readline.Interface,
  runtime: AgentRuntime,
  principal: Principal,
  outcome: RunOutcome,
  permissions: SandboxPermissionPolicy,
  sessionId: string,
  screen: AgentScreen
): Promise<RunOutcome> {
  let current = outcome;
  while (current.status === 'waiting_input' && current.pendingInput?.kind === 'approval') {
    const pending = current.pendingInput;
    screen.approval(pending.toolName, pending.reason, pending.args);
    const answer = (await rl.question(`  ${C.dim}y 一次  a 本会话  n 拒绝  exit 取消${C.reset}\n  `)).trim().toLowerCase();
    if (answer === 'exit') {
      await runtime.cancelRun(current.runId);
      screen.note('已取消，会话已解锁。');
      return current;
    }
    const allow = answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'always' || answer === 'session';
    if (allow && (answer === 'a' || answer === 'always' || answer === 'session')) {
      permissions.grant(sessionId, pending.toolName, pending.args);
    }
    const next = await runtime.submitToolDecision(current.runId, allow ? 'approve' : 'deny', principal);
    current = await next.result;
  }
  return current;
}

function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, windowsHide: true })
      : spawn('bash', ['-lc', command], { cwd });
    let output = '';
    const append = (chunk: Buffer) => {
      if (output.length < 100_000) output += chunk.toString('utf8');
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort);
    child.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code: 1, output: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({ code, output: output.slice(0, 100_000) });
    });
  });
}

function printHelp(screen: AgentScreen) {
  screen.log('');
  screen.log(`${C.bold}命令${C.reset}`);
  screen.log(`  ${C.cyan}/model${C.reset} [name]   当前模型，或换成 cn:deepseek-v4-pro`);
  screen.log(`  ${C.cyan}/history${C.reset}         消息序号`);
  screen.log(`  ${C.cyan}/snapshots${C.reset}       文件快照`);
  screen.log(`  ${C.cyan}/revert${C.reset} <seq>    把文件和对话回退到这一步`);
  screen.log(`  ${C.cyan}/fork${C.reset} [seq]      从这一步分出新会话`);
  screen.log(`  ${C.cyan}/new${C.reset}             新会话`);
  screen.log(`  ${C.cyan}/memories${C.reset}        当前可见记忆`);
  screen.log(`  ${C.cyan}/perm${C.reset} [mode]     default / build / plan / yolo`);
  screen.log(`  ${C.cyan}/perm clear${C.reset}      忘掉本会话的批准`);
  screen.log(`  ${C.cyan}exit${C.reset}             离开`);
  screen.log('');
}

function loadLocalEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '.pi-agent', '.env'),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    const raw = readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

function normalizeOpenAIBaseURL(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      return `${trimmed}/v1`;
    }
  } catch {
    // Keep as-is if invalid URL; OpenAICompatibleAdapter will report clearly
  }
  return trimmed;
}

async function main() {
  loadLocalEnv();
  const screen = new AgentScreen();
  screen.open();

  const rl = readline.createInterface({ input, output });

  const hasApiKey = Boolean(process.env.PI_AGENT_API_KEY || process.env.OPENAI_API_KEY);
  const configuredBaseURL = normalizeOpenAIBaseURL(process.env.PI_AGENT_BASE_URL || 'https://api.openai.com/v1');
  screen.setMeta({ model: '选择连接', mode: 'boot', root: projectRootPath(), session: '—' });
  screen.header();
  screen.log(`  ${C.bold}1${C.reset}  连接   ${hasApiKey ? configuredBaseURL : '需要 PI_AGENT_API_KEY'}`);
  screen.log(`  ${C.bold}2${C.reset}  离线   本地演示，不访问网络`);
  const defaultChoice = hasApiKey ? '1' : '2';
  const modeChoice = ((await rl.question(`  ${C.dim}选择 1 或 2，回车默认 ${defaultChoice}${C.reset}\n  `)).trim() || defaultChoice);

  let modelAdapter: ModelAdapter;
  let modelName = process.env.PI_AGENT_MODEL || 'cn:auto';

  if (modeChoice === '1') {
    let apiKey = process.env.PI_AGENT_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      apiKey = (await rl.question('请输入 API Key (PI_AGENT_API_KEY): ')).trim();
    }
    if (!apiKey) {
      screen.error('没有 API Key，已退出。');
      rl.close();
      return;
    }
    const baseURL = configuredBaseURL;
    const proxy = process.env.PI_AGENT_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
    const selectedModel = (await rl.question(`  ${C.dim}模型，回车默认 ${modelName}${C.reset}\n  `)).trim();
    if (selectedModel) modelName = selectedModel;
    modelAdapter = new OpenAICompatibleAdapter({ apiKey, baseURL, proxy });
    screen.note(`已连接 ${baseURL}${proxy ? ` · 代理 ${proxy}` : ''}`);
  } else {
    const fake = new FakeModelAdapter();
    fake.enqueueStreamedDeltas({
      chunks: [
        {
          delta: {
            type: 'tool_call_delta',
            index: 0,
            toolCallId: 'call_demo_info',
            toolName: 'system_info',
            argsDelta: '{}',
          },
        },
        {
          delta: { type: 'text_delta', text: '正在检查系统与沙箱环境...' },
          delayMs: 120,
        },
      ],
      response: {
        content: [
          { type: 'text', text: '正在检查系统与沙箱环境...' },
          { type: 'tool_call', toolCallId: 'call_demo_info', toolName: 'system_info', args: {} },
        ],
        finishReason: 'tool_use',
        usage: { inputTokens: 40, outputTokens: 25 },
        model: 'offline-simulator',
      },
    });
    fake.enqueueText('当前系统运行良好！你可以继续体验 /history、/snapshots、/revert 等命令。');
    modelAdapter = fake;
    modelName = 'offline-simulator';
    screen.note('离线演示。预置一次工具调用。');
  }

  const projectRoot = projectRootPath();

  // 2. 初始化 Runtime（项目目录为沙箱边界，Shadow FS 保护真实文件）
  const { runtime, registry, store, memory, permissions } = createAgentRuntime({
    dbPath: databasePath(),
    modelAdapter,
    approvalMode: 'ask_for_side_effects',
    enableSpeculativePrefetch: true,
    sandbox: { projectRoot, mode: initialSandboxMode() },
    shadowFs: { workspaceDir: projectRoot },
  });
  if (!(permissions instanceof SandboxPermissionPolicy)) {
    throw new Error('Sandbox permission policy was not installed');
  }

  // 3. 注册实用工具（只读工具支持流式投机预取，写工具受审批与 Shadow FS 快照保护）
  registry.register({
    name: 'system_info',
    description: '获取当前操作系统的基本环境状态（平台、整机内存、CPU、Node 版本、沙箱目录等）',
    inputSchema: { type: 'object', properties: {} },
    sideEffect: 'none',
    requiredPermissions: ['sys:read'],
    async execute() {
      const totalBytes = os.totalmem();
      const freeBytes = os.freemem();
      const usedBytes = totalBytes - freeBytes;
      return {
        content: JSON.stringify({
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
          cpuCores: os.cpus().length,
          totalMemoryGB: Number((totalBytes / 1024 / 1024 / 1024).toFixed(2)),
          freeMemoryGB: Number((freeBytes / 1024 / 1024 / 1024).toFixed(2)),
          memoryUsedPercent: Number(((usedBytes / totalBytes) * 100).toFixed(1)),
          processHeapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          projectRoot,
          permissionMode: permissions.currentMode,
          time: new Date().toISOString(),
        }),
      };
    },
  });

  registry.register({
    name: 'execute_calc',
    description: '执行精准数学计算表达式',
    inputSchema: {
      type: 'object',
      required: ['expression'],
      properties: { expression: { type: 'string' } },
    },
    sideEffect: 'none',
    requiredPermissions: ['math:calc'],
    async execute(args: { expression: string }) {
      try {
        return { content: `Result: ${evaluateMath(args.expression)}` };
      } catch (err: any) {
        return { content: `Error: ${err.message}`, isError: true };
      }
    },
  });

  registry.register({
    name: 'list_files',
    description: '列出项目目录中的文件。相对路径相对于项目根。',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute(args: { dir?: string }) {
      const opened = openProjectFile(projectRoot, args?.dir || '.', permissions.currentMode, false);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      if (!existsSync(opened)) return { content: '[]' };
      const entries = readdirSync(opened, { withFileTypes: true }).map((entry) =>
        entry.isDirectory() ? `${entry.name}/` : entry.name
      );
      return { content: JSON.stringify(entries) };
    },
  });

  registry.register({
    name: 'read_file',
    description: '读取项目中的文件。项目外路径和密钥文件需要用户批准。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute(args: { path: string }) {
      const opened = openProjectFile(projectRoot, args.path, permissions.currentMode, false);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      if (!existsSync(opened)) return { content: `File not found: ${args.path}`, isError: true };
      return { content: readFileSync(opened, 'utf8') };
    },
  });

  registry.register({
    name: 'grep_files',
    description: '在项目中搜索文本。跳过依赖目录和密钥文件。',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' }, path: { type: 'string' } },
    },
    sideEffect: 'none',
    requiredPermissions: ['fs:read'],
    async execute(args: { query?: string; path?: string }) {
      const query = args.query?.trim() ?? '';
      if (query.length < 1) return { content: 'query is required', isError: true };
      const opened = openProjectFile(projectRoot, args.path || '.', permissions.currentMode, false);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      const hits: string[] = [];
      const visit = (dir: string, depth: number) => {
        if (depth > 8 || hits.length >= 80) return;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (hits.length >= 80) return;
          if (WALK_IGNORE.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          const flags = resolveProjectPath(projectRoot, full);
          if (flags.outside || flags.secret) continue;
          if (entry.isDirectory()) {
            visit(full, depth + 1);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            if (statSync(full).size > 1_000_000) continue;
            const text = readFileSync(full, 'utf8');
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && hits.length < 80; i++) {
              if (lines[i]?.includes(query)) hits.push(`${path.relative(projectRoot, full)}:${i + 1}: ${lines[i]}`);
            }
          } catch {
            // Unreadable files are skipped.
          }
        }
      };
      const startStat = existsSync(opened) ? statSync(opened) : null;
      if (!startStat) return { content: '[]' };
      if (startStat.isFile()) {
        const text = readFileSync(opened, 'utf8');
        text.split(/\r?\n/).forEach((line, index) => {
          if (line.includes(query) && hits.length < 80) hits.push(`${args.path}:${index + 1}: ${line}`);
        });
      } else {
        visit(opened, 0);
      }
      return { content: hits.join('\n') || 'No matches.' };
    },
  });

  registry.register({
    name: 'write_file',
    description: '写入项目中的文件。build 模式允许项目内写入；.env、.git、密钥等受保护路径会被拒绝。',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: { path: { type: 'string' }, content: { type: 'string' } },
    },
    sideEffect: 'non_idempotent',
    requiredPermissions: ['fs:write'],
    async execute(args: { path: string; content: string }) {
      const opened = openProjectFile(projectRoot, args.path, permissions.currentMode, true);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      mkdirSync(path.dirname(opened), { recursive: true });
      writeFileSync(opened, args.content, 'utf8');
      return { content: `Successfully wrote ${args.path} (${Buffer.byteLength(args.content, 'utf8')} bytes)` };
    },
  });

  registry.register({
    name: 'edit_file',
    description: '把文件中的一段原文替换成新文本。权限与 write_file 相同。',
    inputSchema: {
      type: 'object',
      required: ['path', 'old', 'new'],
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' },
        replaceAll: { type: 'boolean' },
      },
    },
    sideEffect: 'non_idempotent',
    requiredPermissions: ['fs:write'],
    async execute(args: { path: string; old: string; new: string; replaceAll?: boolean }) {
      const opened = openProjectFile(projectRoot, args.path, permissions.currentMode, true);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      if (!existsSync(opened)) return { content: `File not found: ${args.path}`, isError: true };
      const text = readFileSync(opened, 'utf8');
      if (!args.old || !text.includes(args.old)) return { content: 'old text not found', isError: true };
      const next = args.replaceAll ? text.split(args.old).join(args.new) : text.replace(args.old, args.new);
      writeFileSync(opened, next, 'utf8');
      return { content: `Edited ${args.path}` };
    },
  });

  registry.register({
    name: 'delete_file',
    description: '删除项目中的文件。受保护路径会被拒绝。',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    sideEffect: 'non_idempotent',
    requiredPermissions: ['fs:write'],
    async execute(args: { path: string }) {
      const opened = openProjectFile(projectRoot, args.path, permissions.currentMode, true);
      if (typeof opened !== 'string') return { content: opened.error, isError: true };
      if (!existsSync(opened)) return { content: `File not found: ${args.path}`, isError: true };
      rmSync(opened, { force: true });
      return { content: `Deleted ${args.path}` };
    },
  });

  registry.register({
    name: 'bash',
    description: '在项目目录中执行命令。build 模式放行项目内的普通命令；越界、密钥、git push、rm 需要批准；sudo 和删除根目录会被拒绝。',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
    sideEffect: 'non_idempotent',
    requiredPermissions: ['shell:exec'],
    timeoutMs: 120_000,
    async execute(args: { command: string }, ctx) {
      const command = args.command?.trim() ?? '';
      if (!command) return { content: 'command is required', isError: true };
      const result = await runShell(command, projectRoot, ctx.signal, 120_000);
      const text = result.output.trim() || `(exit ${result.code ?? 1})`;
      return { content: text.slice(0, 100_000), isError: result.code !== 0 };
    },
  });

  const principal: Principal = {
    id: 'live_user',
    kind: 'user',
    grants: ['sys:read', 'math:calc', 'fs:read', 'fs:write', 'shell:exec'],
  };

  await runtime.recover(Date.now() + 86_400_000);
  const systemPrompt =
    `你是 T3 的终端 Agent，工作目录是项目根 ${projectRoot}。` +
    '可以调用 list_files、read_file、grep_files、write_file、edit_file、delete_file、bash、system_info、execute_calc。' +
    '项目内的读取和 build 模式下的普通写入、命令可以直接做。不要读取或修改 .env、密钥、.git、.ssh。' +
    '项目外路径、危险命令会等用户批准。用户说出稳定偏好或事实时，用 memory_remember 记下；纠正用 memory_correct，作废用 memory_forget，查找用 memory_recall。请用精炼亲切的中文回答。';
  const sessionConfig = (maxOutputTokens = 2000) => ({
    model: modelName,
    systemPrompt,
    maxOutputTokens,
    memoryRecall: { enabled: true, limit: 8 },
    memory: { userId: principal.id, agentId: 'pi-cli' },
  });
  const existing = process.env.PI_AGENT_NEW_SESSION === '1' ? [] : await store.listSessions(1);
  let session = existing[0];
  if (!session) {
    session = await runtime.createSession({
      title: 'T3 Session',
      config: sessionConfig(),
    });
  } else {
    session = await store.updateSessionConfig(session.id, {
      ...session.config,
      ...sessionConfig(session.config.maxOutputTokens || 2000),
    });
  }

  const pending = await store.getActiveRun(session.id);
  if (pending?.status === 'waiting_input' && pending.pendingInput?.kind === 'approval') {
    screen.note('恢复上次未完成的批准。');
    await settleApproval(rl, runtime, principal, {
      runId: pending.id,
      status: pending.status,
      stopReason: pending.stopReason,
      finalText: null,
      usage: pending.usage,
      pendingInput: pending.pendingInput,
    }, permissions, session.id, screen);
  }

  const subscription: { unsub: (() => void) | null } = { unsub: null };
  const bindSessionEvents = (sessionId: string) => {
    subscription.unsub?.();
    subscription.unsub = runtime.subscribe({ sessionId }, (e) => {
      switch (e.type) {
        case 'context_built':
          screen.memory(e.manifest.memoryIds.length, e.manifest.episodeIds.length);
          break;
        case 'model_reasoning_delta':
          screen.reasoning(e.text);
          break;
        case 'model_delta':
          screen.assistant(e.text);
          break;
        case 'model_call_failed':
          screen.error(e.error.message);
          break;
        case 'tool_execution_started':
          screen.toolStart(e.toolName);
          break;
        case 'tool_execution_finished':
          screen.toolFinish({
            ok: e.status === 'succeeded' || e.status === 'success',
            durationMs: e.durationMs,
            prefetch: e.speculativeHit,
            savedMs: e.savedMs,
          });
          break;
        case 'run_finished':
          screen.stats(e.usage.inputTokens, e.usage.outputTokens, e.speculativeStats?.savedMs ?? 0);
          if (e.status === 'failed' && e.stopReason !== 'model_error') screen.error(e.stopReason);
          else if (e.status === 'cancelled') screen.note('已取消');
          screen.settle();
          break;
        case 'run_interrupted':
          screen.note('已中断');
          break;
        default:
          break;
      }
    });
  };
  bindSessionEvents(session.id);

  const showSession = (hint = '就绪 · /help') => {
    screen.setMeta({
      model: modelName,
      mode: permissions.currentMode,
      root: projectRoot,
      session: session.id,
    });
    screen.header();
    screen.note(hint);
  };
  showSession();

  while (true) {
    const prompt = await rl.question(screen.composer());
    const trimmed = prompt.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === 'exit') {
      screen.note('会话已保存。');
      break;
    }

    if (trimmed === '/help') {
      printHelp(screen);
      continue;
    }

    if (trimmed === '/history') {
      const msgs = await store.listMessages(session.id);
      screen.log(`${C.bold}消息 ${msgs.length}${C.reset}`);
      for (const m of msgs) {
        const preview = m.content
          .map((b) =>
            b.type === 'text'
              ? b.text
              : b.type === 'tool_call'
              ? `[call:${b.toolName}]`
              : b.type === 'tool_result'
              ? `[result:${b.toolName}]`
              : `[${b.type}]`
          )
          .join(' ')
          .replace(/\s+/g, ' ')
          .slice(0, 70);
        screen.log(`  ${C.cyan}${m.seq}${C.reset}  ${m.role}  ${preview}`);
      }
      continue;
    }

    if (trimmed === '/snapshots') {
      const snaps = await runtime.listFileSnapshots(session.id);
      screen.log(`${C.bold}快照 ${snaps.length}${C.reset}`);
      for (const s of snaps) {
        screen.log(
          `  ${C.cyan}${s.checkpointSeq}${C.reset}  ${s.changeType}  ${path.relative(projectRoot, s.filePath) || s.filePath}  ${s.toolName}`
        );
      }
      continue;
    }

    if (trimmed.startsWith('/revert')) {
      const arg = trimmed.slice('/revert'.length).trim();
      const targetSeq = Number(arg);
      if (!arg || !Number.isInteger(targetSeq) || targetSeq < 0) {
        screen.note('用法: /revert <seq>。先看 /history 或 /snapshots。');
        continue;
      }
      try {
        const report = await runtime.revertToSeq(session.id, targetSeq, { preserveBackupBranch: true });
        screen.note(`已回退到 seq ${targetSeq}`);
        screen.log(
          `  文件 ${report.restoredFiles.length} · 删除 ${report.deletedFiles.length} · 消息 ${report.deletedMessages} · 情节 ${report.deletedEpisodes} · 派生记忆 ${report.forgottenMemories}`
        );
        if (report.backupSessionId) screen.note(`备份 ${report.backupSessionId}`);
      } catch (err: any) {
        screen.error(`回退失败: ${err.message}`);
      }
      continue;
    }

    if (trimmed.startsWith('/fork')) {
      const arg = trimmed.slice('/fork'.length).trim();
      const atSeq = arg ? Number(arg) : undefined;
      try {
        const forked = await runtime.forkSession(session.id, atSeq !== undefined ? { atSeq } : undefined);
        session = forked;
        bindSessionEvents(session.id);
        showSession('已分叉');
      } catch (err: any) {
        screen.error(`分叉失败: ${err.message}`);
      }
      continue;
    }

    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const nextModel = trimmed.slice('/model'.length).trim();
      if (!nextModel) {
        screen.note(`模型 ${modelName} · /model cn:deepseek-v4-pro`);
      } else {
        modelName = nextModel;
        session = await store.updateSessionConfig(session.id, {
          ...session.config,
          model: modelName,
        });
        showSession(`模型 ${modelName}`);
      }
      continue;
    }

    if (trimmed === '/memories') {
      const identity = session.config.memory;
      const bindings: ScopeBinding[] = [
        { scopeType: 'session', scopeId: session.id },
        { scopeType: 'user', scopeId: principal.id },
        { scopeType: 'global', scopeId: identity?.globalId ?? 'global' },
      ];
      if (identity?.agentId) bindings.push({ scopeType: 'agent', scopeId: identity.agentId });
      const records = await memory.longTerm.recall({
        scopes: bindings.map((binding) => binding.scopeType),
        bindings,
        limit: 20,
      });
      screen.log(`${C.bold}记忆 ${records.length}${C.reset}`);
      if (records.length === 0) screen.note('还没有事实。说「记住 ……」即可。');
      for (const record of records) {
        const pin = record.pinned ? ' pin' : '';
        screen.log(`  ${C.cyan}${record.id}${C.reset}  ${record.scopeType}/${record.kind}${pin}  ${record.content}`);
      }
      continue;
    }

    if (trimmed === '/perm' || trimmed.startsWith('/perm ')) {
      const arg = trimmed.slice('/perm'.length).trim();
      if (!arg) {
        screen.note(`沙箱 ${permissions.currentMode}`);
        screen.note(projectRoot);
        screen.note('default 写入和命令要批准；build 放行项目内普通操作；plan 只读；yolo 连受保护路径也放行。');
      } else if (arg === 'clear') {
        permissions.clearGrants(session.id);
        screen.note('已清除本会话的批准。');
      } else {
        const next = parseSandboxMode(arg);
        if (!next) screen.error('未知模式。可选 default、build、plan、yolo。');
        else {
          permissions.setMode(next);
          showSession(`沙箱 ${next}`);
        }
      }
      continue;
    }

    if (trimmed === '/new') {
      session = await runtime.createSession({
        title: 'T3 Session',
        config: sessionConfig(),
      });
      bindSessionEvents(session.id);
      showSession('新会话');
      continue;
    }

    try {
      screen.beginTurn();
      const handle = await runtime.startRun({
        sessionId: session.id,
        userInput: prompt,
        principal,
      });

      const settled = await settleApproval(rl, runtime, principal, await handle.result, permissions, session.id, screen);
      if (settled.finalText && !screen.sawAssistant) screen.log(settled.finalText);
      screen.settle();
    } catch (err: any) {
      screen.error(err?.message || String(err));
    }
  }

  subscription.unsub?.();
  rl.close();
}

main().catch(console.error);
