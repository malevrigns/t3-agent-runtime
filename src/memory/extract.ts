import type { Message } from '../core/types.js';
import { memoryContentKey } from './rank.js';

export interface ExtractedFact {
  kind: 'preference' | 'fact' | 'decision';
  content: string;
  contentKey: string;
  sourceRef: string;
  salience: number;
  tags: string[];
}

const LINE_RULES: Array<{ kind: ExtractedFact['kind']; re: RegExp; salience: number }> = [
  { kind: 'preference', re: /^(?:请)?记住[:：\s]+(.{4,200})$/, salience: 0.8 },
  { kind: 'fact', re: /^remember(?:\s+that)?[:：\s]+(.{4,200})$/i, salience: 0.8 },
  { kind: 'preference', re: /^(?:我的)?偏好(?:是)?[:：\s]+(.{4,200})$/, salience: 0.85 },
  { kind: 'preference', re: /^I (?:always|never|prefer)\b.{4,180}$/i, salience: 0.75 },
  { kind: 'decision', re: /^(?:决定|决策)[:：\s]+(.{4,200})$/, salience: 0.7 },
  { kind: 'decision', re: /^Decision[:：\s]+(.{4,200})$/i, salience: 0.7 },
];

function textOf(message: Message): string[] {
  return message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text);
}

/**
 * Pull durable facts out of a span that is about to leave the verbatim window.
 * The transcript stays; these rows are an index, not a replacement.
 */
export function extractFacts(messages: Message[]): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    for (const text of textOf(message)) {
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        for (const rule of LINE_RULES) {
          const match = rule.re.exec(trimmed);
          if (!match) continue;
          const content = (match[1] ?? trimmed).trim();
          if (content.length < 4) continue;
          const contentKey = memoryContentKey(rule.kind, content);
          if (seen.has(contentKey)) break;
          seen.add(contentKey);
          facts.push({
            kind: rule.kind,
            content,
            contentKey,
            sourceRef: `msg:${message.seq}`,
            salience: rule.salience,
            tags: [],
          });
          break;
        }
        if (facts.length >= 8) return facts;
      }
    }
  }
  return facts;
}

export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b[\w./\\-]{1,120}\.(?:json|ts|tsx|js|mjs|md|sql|py|yml|yaml|toml)\b/g)) {
    found.add(match[0]);
  }
  for (const match of text.matchAll(/`([^`]{1,80})`/g)) {
    const token = match[1]?.trim();
    if (token) found.add(token);
  }
  return [...found].slice(0, 12);
}

export function episodeTitle(summary: string): string {
  const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const body = lines.find((line) => !['Goal', 'Progress', 'Key Decisions', 'Next Steps', '-'].includes(line));
  const title = (body ?? lines[0] ?? 'Episode').replace(/^-\s*/, '');
  return title.length <= 80 ? title : `${title.slice(0, 79)}…`;
}
