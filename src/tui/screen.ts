const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

export interface ScreenMeta {
  model: string;
  mode: string;
  root: string;
  session: string;
}

export interface ToolFinishView {
  ok: boolean;
  durationMs: number;
  prefetch?: boolean;
  savedMs?: number;
}

/**
 * Scrollback agent console. The transcript is the work: thought, tool, result.
 * It does not render a chat turn with a speaker label.
 */
export class AgentScreen {
  private live = false;
  private thought = '';
  private assistantOpen = false;
  private answered = false;
  private tools = 0;
  private meta: ScreenMeta = { model: '—', mode: 'build', root: '', session: '—' };

  constructor(
    private readonly writeOut: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
    private readonly widthOf: () => number = () => process.stdout.columns || 80
  ) {}

  get sawAssistant(): boolean {
    return this.answered;
  }

  /** A new user turn. Clears the previous answer flag. */
  beginTurn(): void {
    this.finishThought();
    this.endAssistant();
    this.answered = false;
    this.tools = 0;
  }

  open(): void {
    if (process.stdout.isTTY) this.writeOut('\x1b[2J\x1b[H');
  }

  setMeta(meta: Partial<ScreenMeta>): void {
    this.meta = { ...this.meta, ...meta };
  }

  header(): void {
    this.commitLive('');
    this.endAssistant();
    const width = Math.max(40, Math.min(this.widthOf(), 100));
    const session = this.meta.session.length > 8 ? this.meta.session.slice(-8) : this.meta.session;
    const root = shrinkPath(this.meta.root, width - 12);
    this.writeOut(
      `${ansi.bold}t3${ansi.reset}  ${ansi.cyan}${this.meta.mode}${ansi.reset}  ${this.meta.model}\n` +
        `${ansi.dim}${root}  ·  ${session}${ansi.reset}\n` +
        `${ansi.dim}${'─'.repeat(width)}${ansi.reset}\n`
    );
  }

  /** Readline prompt. The user's words stay on this line, with no speaker name. */
  composer(): string {
    return `${ansi.bold}❯ ${ansi.reset}`;
  }

  reasoning(text: string): void {
    if (!text) return;
    this.endAssistant();
    this.thought += text;
    const tail = this.thought.replace(/\s+/g, ' ').trim().slice(-Math.max(12, this.widthOf() - 12));
    this.paintLive(`  ${ansi.dim}◦ 思考  ${tail}${ansi.reset}`);
  }

  assistant(text: string): void {
    if (!text) return;
    this.finishThought();
    this.assistantOpen = true;
    this.answered = true;
    this.writeOut(text);
  }

  memory(facts: number, episodes: number): void {
    if (facts === 0 && episodes === 0) return;
    this.finishThought();
    this.line(`  ${ansi.dim}◦ 记忆  事实 ${facts} · 情节 ${episodes}${ansi.reset}`);
  }

  toolStart(name: string): void {
    this.finishThought();
    this.line(`  ${ansi.bold}●${ansi.reset} ${ansi.bold}${name}${ansi.reset}`);
  }

  toolFinish(view: ToolFinishView): void {
    this.tools += 1;
    const mark = view.ok ? `${ansi.green}ok${ansi.reset}` : `${ansi.red}failed${ansi.reset}`;
    const prefetch = view.prefetch
      ? `${ansi.dim} · 预取${view.savedMs != null ? ` ${view.savedMs}ms` : ''}${ansi.reset}`
      : '';
    this.line(`    ${ansi.dim}⎿${ansi.reset} ${mark}${ansi.dim} · ${view.durationMs}ms${ansi.reset}${prefetch}`);
  }

  stats(input: number, output: number, savedMs = 0): void {
    this.finishThought();
    this.endAssistant();
    const saved = savedMs > 0 ? ` · 预取省 ${savedMs}ms` : '';
    this.line(`  ${ansi.dim}入 ${input} · 出 ${output} · 工具 ${this.tools}${saved}${ansi.reset}`);
    this.tools = 0;
  }

  approval(tool: string, reason: string, args: unknown): void {
    this.finishThought();
    this.endAssistant();
    const preview = JSON.stringify(args ?? {}).replace(/\s+/g, ' ');
    const clipped = preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
    this.line('');
    this.line(`  ${ansi.yellow}${ansi.bold}批准 ${tool}${ansi.reset}`);
    this.line(`  ${ansi.dim}${reason}${ansi.reset}`);
    this.line(`  ${ansi.dim}${clipped}${ansi.reset}`);
  }

  error(message: string): void {
    this.finishThought();
    this.endAssistant();
    this.line(`  ${ansi.red}✖ ${message}${ansi.reset}`);
  }

  note(message: string): void {
    this.finishThought();
    this.endAssistant();
    this.line(`  ${ansi.dim}${message}${ansi.reset}`);
  }

  log(message = ''): void {
    this.finishThought();
    this.endAssistant();
    this.line(message);
  }

  /** Close any open thought or answer line. The answer flag stays until the next turn. */
  settle(): void {
    this.finishThought();
    this.endAssistant();
  }

  private finishThought(): void {
    if (!this.thought && !this.live) return;
    if (this.thought.trim()) this.commitLive(`  ${ansi.dim}◦ 思考${ansi.reset}`);
    else this.commitLive('');
    this.thought = '';
  }

  private endAssistant(): void {
    if (!this.assistantOpen) return;
    this.writeOut('\n');
    this.assistantOpen = false;
  }

  private line(text: string): void {
    this.endAssistant();
    this.commitLive('');
    this.writeOut(`${text}\n`);
  }

  private paintLive(text: string): void {
    this.writeOut(`\r\x1b[2K${text}`);
    this.live = true;
  }

  private commitLive(text: string): void {
    if (!this.live && !text) return;
    if (this.live) this.writeOut(`\r\x1b[2K${text}\n`);
    else if (text) this.writeOut(`${text}\n`);
    this.live = false;
  }
}

function shrinkPath(root: string, max: number): string {
  if (!root) return '—';
  if (root.length <= max) return root;
  return `…${root.slice(root.length - Math.max(8, max - 1))}`;
}
