import type { ContentBlock, Message } from '../core/types.js';
import type { ModelAdapter } from '../model/ports.js';
import type { Summarizer } from './ports.js';

export const EXTRACTIVE_MODEL = 'extractive';
export const EXTRACTIVE_PROMPT_VERSION = 'extractive-v1';

const HEADINGS = ['Goal', 'Progress', 'Key Decisions', 'Next Steps'] as const;
const TOOL_RESULT_CHAR_LIMIT = 500;

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type ToolCallBlock = Extract<ContentBlock, { type: 'tool_call' }>;
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>;

function isText(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

function isToolCall(block: ContentBlock): block is ToolCallBlock {
  return block.type === 'tool_call';
}

function isToolResult(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

function headingPresent(summary: string, heading: string): boolean {
  return summary.split(/\r?\n/).some((line) => line.trim() === heading);
}

function sectionBody(summary: string, heading: string): string | undefined {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (HEADINGS.includes(line.trim() as (typeof HEADINGS)[number])) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text.length > 0 && text !== '-' ? text : undefined;
}

function textBlocks(message: Message): string[] {
  return message.content.filter(isText).map((block) => block.text.trim()).filter(Boolean);
}

function progressLines(messages: Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const label = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : null;
    for (const block of message.content) {
      if (isText(block) && block.text.trim() && label) {
        lines.push(`${label}: ${block.text.trim()}`);
      } else if (block.type === 'image' && label) {
        lines.push(`${label} attached image (${block.mimeType}${block.alt ? `: ${block.alt}` : ''})`);
      } else if (block.type === 'file' && label) {
        lines.push(`${label} attached file ${block.name} (${block.mimeType})`);
      } else if (isToolCall(block)) {
        lines.push(`Tool call: ${block.toolName}`);
      } else if (isToolResult(block)) {
        lines.push(`Tool result (${block.toolName}): ${clip(block.content, TOOL_RESULT_CHAR_LIMIT)}`);
      }
    }
  }
  return lines;
}

function decisionLines(messages: Message[]): string[] {
  const statements: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    statements.push(...textBlocks(message));
  }
  if (statements.length > 0) return statements;
  const calls: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (isToolCall(block)) calls.push(`Called ${block.toolName}`);
    }
  }
  return calls;
}

function lastStatement(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = textBlocks(message).at(-1);
    if (text) return text;
  }
  return undefined;
}

function joinParts(parts: Array<string | undefined>): string {
  const text = parts.filter((part): part is string => Boolean(part)).join('\n');
  return text.trim() || '-';
}

export function renderExtractiveSummary(previousSummary: string | undefined, messages: Message[]): string {
  const structured = previousSummary ? HEADINGS.every((heading) => headingPresent(previousSummary, heading)) : false;
  const previousGoal = structured && previousSummary ? sectionBody(previousSummary, 'Goal') : undefined;
  const previousProgress = structured && previousSummary ? sectionBody(previousSummary, 'Progress') : previousSummary?.trim();
  const previousDecisions = structured && previousSummary ? sectionBody(previousSummary, 'Key Decisions') : undefined;
  const previousNext = structured && previousSummary ? sectionBody(previousSummary, 'Next Steps') : undefined;

  const userTexts = messages.filter((message) => message.role === 'user').flatMap(textBlocks);
  const goal = previousGoal || userTexts[0] || '-';
  const progress = joinParts([previousProgress, progressLines(messages).join('\n') || undefined]);
  const decisions = joinParts([previousDecisions, decisionLines(messages).join('\n') || undefined]);
  const nextSteps = lastStatement(messages) || previousNext || '-';

  return [
    `Goal\n${goal}`,
    `Progress\n${progress}`,
    `Key Decisions\n${decisions}`,
    `Next Steps\n${nextSteps}`,
  ].join('\n\n');
}

/**
 * Deterministic extractive summarizer. It only quotes transcript text and tool names.
 */
export class ExtractiveSummarizer implements Summarizer {
  async summarize(
    input: { previousSummary?: string; messages: Message[] },
    signal: AbortSignal
  ): Promise<{ content: string; model: string; promptVersion: string }> {
    if (signal.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    return {
      content: renderExtractiveSummary(input.previousSummary, input.messages),
      model: EXTRACTIVE_MODEL,
      promptVersion: EXTRACTIVE_PROMPT_VERSION,
    };
  }
}

export interface ModelSummarizerOptions {
  model: ModelAdapter;
  modelName: string;
  promptVersion?: string;
  maxOutputTokens?: number;
  fallback?: Summarizer | null;
}

const COMPACTION_SYSTEM_PROMPT = [
  'You are compacting an AI agent conversation transcript into a concise handoff summary.',
  'Preserve all critical goals, constraints, file paths, tool outcomes, key decisions, and pending next steps.',
  'Format your response using these exact section headings on their own lines:',
  'Goal',
  'Progress',
  'Key Decisions',
  'Next Steps',
].join('\n');

function formatTranscriptForModel(previousSummary: string | undefined, messages: Message[]): string {
  const sections: string[] = [];
  if (previousSummary) {
    sections.push(`<previous_summary>\n${previousSummary}\n</previous_summary>`);
  }
  const lines: string[] = [];
  for (const msg of messages) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.trim()) {
        parts.push(block.text.trim());
      } else if (block.type === 'image') {
        parts.push(`[image ${block.mimeType}${block.alt ? ` alt="${block.alt}"` : ''}]`);
      } else if (block.type === 'file') {
        parts.push(`[file ${block.name} (${block.mimeType})]`);
      } else if (block.type === 'tool_call') {
        parts.push(`[tool_call ${block.toolName} ${JSON.stringify(block.args)}]`);
      } else if (block.type === 'tool_result') {
        parts.push(
          `[tool_result ${block.toolName}${block.isError ? ' ERROR' : ''}: ${clip(block.content, TOOL_RESULT_CHAR_LIMIT)}]`
        );
      }
    }
    if (parts.length > 0) {
      lines.push(`[seq=${msg.seq} ${msg.role}] ${parts.join(' ')}`);
    }
  }
  sections.push(`<transcript>\n${lines.join('\n')}\n</transcript>`);
  return sections.join('\n\n');
}

export class ModelSummarizer implements Summarizer {
  private readonly promptVersion: string;
  private readonly maxOutputTokens: number;
  private readonly fallback: Summarizer | null;

  constructor(private readonly opts: ModelSummarizerOptions) {
    this.promptVersion = opts.promptVersion ?? 'llm-compaction-v1';
    this.maxOutputTokens = opts.maxOutputTokens ?? 1200;
    this.fallback = opts.fallback === undefined ? new ExtractiveSummarizer() : opts.fallback;
  }

  async summarize(
    input: { previousSummary?: string; messages: Message[] },
    signal: AbortSignal
  ): Promise<{ content: string; model: string; promptVersion: string }> {
    if (signal.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }

    try {
      const response = await this.opts.model.generate(
        {
          model: this.opts.modelName,
          system: COMPACTION_SYSTEM_PROMPT,
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: formatTranscriptForModel(input.previousSummary, input.messages) }],
            },
          ],
          tools: [],
          maxOutputTokens: this.maxOutputTokens,
          temperature: 0.1,
        },
        { signal }
      );

      const text = response.content
        .filter(isText)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join('\n')
        .trim();

      if (!text) {
        throw new Error('Model summarizer returned empty summary');
      }

      return {
        content: text,
        model: response.model || this.opts.modelName,
        promptVersion: this.promptVersion,
      };
    } catch (err) {
      if (signal.aborted) throw err;
      if (this.fallback) {
        return this.fallback.summarize(input, signal);
      }
      throw err;
    }
  }
}
