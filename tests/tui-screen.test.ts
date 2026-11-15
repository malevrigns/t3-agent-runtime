import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentScreen } from '../src/tui/screen.js';

function render(chunks: string[]): string {
  let row = '';
  const lines: string[] = [];
  const text = chunks.join('');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      lines.push(row);
      row = '';
      continue;
    }
    if (ch === '\r') {
      row = '';
      continue;
    }
    if (ch === '\x1b' && text.startsWith('\x1b[2K', i)) {
      row = '';
      i += 3;
      continue;
    }
    if (ch === '\x1b') {
      const end = text.indexOf('m', i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    row += ch;
  }
  if (row) lines.push(row);
  return lines.join('\n');
}

test('agent screen is a work transcript, not a chat log', () => {
  const chunks: string[] = [];
  const screen = new AgentScreen((chunk) => chunks.push(chunk), () => 80);

  assert.match(screen.composer(), /❯/);
  assert.equal(screen.composer().includes('You >'), false);
  assert.equal(screen.sawAssistant, false);

  screen.memory(0, 0);
  screen.reasoning('先看端口');
  screen.reasoning(' 4100');
  screen.assistant('服务在 4100。');
  assert.equal(screen.sawAssistant, true);
  screen.toolStart('read_file');
  screen.toolFinish({ ok: true, durationMs: 12, prefetch: true, savedMs: 8 });
  screen.stats(3, 5, 8);
  screen.settle();
  assert.equal(screen.sawAssistant, true);
  screen.beginTurn();
  assert.equal(screen.sawAssistant, false);

  const raw = chunks.join('');
  const view = render(chunks);
  assert.match(raw, /\r\x1b\[2K/);
  assert.match(view, /◦ 思考/);
  assert.equal(view.includes('先看端口 4100'), false);
  assert.match(view, /服务在 4100。\n {2}● read_file/);
  assert.match(view, /⎿ ok · 12ms · 预取 8ms/);
  assert.match(view, /入 3 · 出 5 · 工具 1 · 预取省 8ms/);
  for (const banned of ['You >', 'Agent >', 'Tool Call', '模型流式回复', 'Step ']) {
    assert.equal(view.includes(banned), false, banned);
  }
});

test('approval card clips long arguments', () => {
  const chunks: string[] = [];
  const screen = new AgentScreen((chunk) => chunks.push(chunk), () => 80);
  screen.approval('bash', '项目外路径需要批准', { command: 'x'.repeat(200) });
  const view = render(chunks);
  assert.match(view, /批准 bash/);
  assert.match(view, /项目外路径需要批准/);
  assert.match(view, /\.\.\./);
  assert.equal(view.includes('x'.repeat(180)), false);
});

test('header shows mode, model, and a short session id', () => {
  const chunks: string[] = [];
  const screen = new AgentScreen((chunk) => chunks.push(chunk), () => 72);
  screen.setMeta({ model: 'cn:auto', mode: 'build', root: 'C:\\work\\project', session: 'sess-abcdefgh' });
  screen.header();
  const view = render(chunks);
  assert.match(view, /t3 {2}build {2}cn:auto/);
  assert.match(view, /abcdefgh/);
  assert.equal(view.includes('sess-abcdefgh'), false);
});
