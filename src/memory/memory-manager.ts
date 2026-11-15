import type { ContextBudget, ContextManifest, LongTermMemory, MemoryManager, MemoryRecord, BuiltContext, ScopeBinding, Summarizer } from './ports.js';
import type { ContextMessage, ModelToolSpec } from '../model/ports.js';
import type { ContentBlock, Message, Session, Id } from '../core/types.js';
import type { Episode, SessionStore, Summary } from '../store/ports.js';
import { ContextOverflowError } from '../core/errors.js';
import { ExtractiveSummarizer } from './summarizer.js';
import { StoreLongTermMemory } from './long-term.js';
import { scoreText } from './rank.js';
import { episodeTitle, extractEntities, extractFacts } from './extract.js';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

interface MessageGroup {
  messages: Message[];
  tokens: number;
  /** A keep-region may only open on a user or assistant message. */
  canStartKeep: boolean;
}

function estimateBlockTokens(block: ContentBlock): number {
  if (block.type === 'image') return 1024;
  if (block.type === 'file') {
    if (block.text !== undefined) {
      return Math.ceil((block.name.length + block.text.length + 32) / 3);
    }
    return 512;
  }
  return Math.ceil(JSON.stringify(block).length / 3);
}

function estimateContentTokens(content: unknown): number {
  if (
    Array.isArray(content) &&
    content.some((item) => item && typeof item === 'object' && (item.type === 'image' || item.type === 'file'))
  ) {
    let total = 2;
    for (const item of content) {
      if (item && typeof item === 'object' && 'type' in item) {
        total += estimateBlockTokens(item as ContentBlock);
      } else {
        total += Math.ceil(JSON.stringify(item).length / 3);
      }
    }
    return total;
  }
  return Math.ceil(JSON.stringify(content).length / 3);
}

function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function toolCallIds(message: Message): string[] {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_call' }> => block.type === 'tool_call')
    .map((block) => block.toolCallId);
}

function toolResultIds(message: Message): string[] {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
    .map((block) => block.toolCallId);
}

/**
 * Pack messages so a tool_call and every later matching tool_result stay in one group.
 * The cut can then move only onto a user or assistant boundary.
 */
function groupMessages(messages: Message[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index];

    if (message.role === 'tool') {
      const previous = groups.at(-1);
      if (previous) {
        previous.messages.push(message);
        previous.tokens += estimateContentTokens(message.content);
      } else {
        const orphan: Message[] = [message];
        let tokens = estimateContentTokens(message.content);
        index++;
        while (index < messages.length && messages[index].role === 'tool') {
          orphan.push(messages[index]);
          tokens += estimateContentTokens(messages[index].content);
          index++;
        }
        groups.push({ messages: orphan, tokens, canStartKeep: false });
        continue;
      }
      index++;
      continue;
    }

    if (message.role === 'assistant' && toolCallIds(message).length > 0) {
      const callIds = new Set(toolCallIds(message));
      const grouped: Message[] = [message];
      let tokens = estimateContentTokens(message.content);
      index++;
      while (index < messages.length && messages[index].role === 'tool') {
        grouped.push(messages[index]);
        tokens += estimateContentTokens(messages[index].content);
        index++;
      }
      let lastNeeded = index - 1;
      for (let lookAhead = index; lookAhead < messages.length; lookAhead++) {
        if (toolResultIds(messages[lookAhead]).some((id) => callIds.has(id))) {
          lastNeeded = lookAhead;
        }
      }
      while (index <= lastNeeded) {
        grouped.push(messages[index]);
        tokens += estimateContentTokens(messages[index].content);
        index++;
      }
      groups.push({ messages: grouped, tokens, canStartKeep: true });
      continue;
    }

    groups.push({
      messages: [message],
      tokens: estimateContentTokens(message.content),
      canStartKeep: message.role === 'user' || message.role === 'assistant',
    });
    index++;
  }

  return groups;
}

function suffixTokens(groups: MessageGroup[], start: number): number {
  let tokens = 0;
  for (let index = start; index < groups.length; index++) tokens += groups[index].tokens;
  return tokens;
}

/**
 * First group index kept verbatim. Null when a legal cut would split a pair,
 * start on a tool message, or leave nothing to summarize.
 */
function selectKeepStart(groups: MessageGroup[], keepRecentTokens: number): number | null {
  if (groups.length < 2) return null;
  if (suffixTokens(groups, 0) <= keepRecentTokens) return null;

  let keepStart: number | null = null;
  for (let index = groups.length - 1; index >= 1; index--) {
    if (!groups[index].canStartKeep) continue;
    const tokens = suffixTokens(groups, index);
    if (keepStart === null) {
      keepStart = index;
      if (tokens >= keepRecentTokens) break;
      continue;
    }
    if (tokens > keepRecentTokens) break;
    keepStart = index;
  }
  return keepStart;
}

function flattenGroups(groups: MessageGroup[], start: number): Message[] {
  return groups.slice(start).flatMap((group) => group.messages);
}

function withoutLeadingToolMessages(messages: Message[]): Message[] {
  let start = 0;
  while (start < messages.length && messages[start].role === 'tool') start++;
  return start === 0 ? messages : messages.slice(start);
}

function scopeBindings(session: Session): ScopeBinding[] {
  const scopes = session.config.memoryRecall?.scopes ?? ['session', 'user', 'agent', 'global'];
  const identity = session.config.memory;
  const bindings: ScopeBinding[] = [];
  for (const scope of scopes) {
    if (scope === 'session') bindings.push({ scopeType: 'session', scopeId: session.id });
    else if (scope === 'user' && identity?.userId) bindings.push({ scopeType: 'user', scopeId: identity.userId });
    else if (scope === 'agent' && identity?.agentId) bindings.push({ scopeType: 'agent', scopeId: identity.agentId });
    else if (scope === 'global') bindings.push({ scopeType: 'global', scopeId: identity?.globalId ?? 'global' });
  }
  return bindings;
}

function visibleMemory(session: Session, record: MemoryRecord): boolean {
  const identity = session.config.memory;
  if (record.scopeType === 'session') return record.scopeId === session.id;
  if (record.scopeType === 'user') return record.scopeId === identity?.userId;
  if (record.scopeType === 'agent') return record.scopeId === identity?.agentId;
  return record.scopeId === (identity?.globalId ?? 'global');
}

function rankEpisodes(episodes: Episode[], query: string | undefined, activeSummaryId: string | null): Episode[] {
  if (!query?.trim()) return [];
  return episodes
    .filter((episode) => episode.summaryId !== activeSummaryId)
    .map((episode) => ({
      episode,
      score: scoreText(`${episode.title}\n${episode.content}\n${episode.entities.join(' ')}`, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.episode.toSeq - a.episode.toSeq)
    .slice(0, 2)
    .map((entry) => entry.episode);
}

function renderMemories(records: MemoryRecord[]): string {
  const lines = records.map((record) => {
    const pin = record.pinned ? ' pinned' : '';
    return `- [${record.scopeType}/${record.kind}${pin}] ${record.content}`;
  });
  return `\n\n<long_term_memories>\n${lines.join('\n')}\n</long_term_memories>`;
}

function renderEpisodes(episodes: Episode[]): string {
  const lines = episodes.map((episode) => {
    const body = episode.content.length > 400 ? `${episode.content.slice(0, 400)}…` : episode.content;
    return `- seq ${episode.fromSeq}-${episode.toSeq} ${episode.title}\n  ${body.replace(/\n/g, '\n  ')}`;
  });
  return `\n\n<relevant_episodes>\n${lines.join('\n')}\n</relevant_episodes>`;
}

function compactionOf(session: Session): {
  enabled: boolean;
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
} {
  const compaction = session.config.compaction;
  return {
    enabled: compaction?.enabled !== false,
    contextWindow: session.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    reserveTokens: compaction?.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: compaction?.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
  };
}

export class StandardMemoryManager implements MemoryManager {
  private readonly summarizer: Summarizer;
  private readonly longTermStore: LongTermMemory;

  constructor(private store: SessionStore, summarizer?: Summarizer) {
    this.summarizer = summarizer ?? new ExtractiveSummarizer();
    this.longTermStore = new StoreLongTermMemory(store);
  }

  get longTerm(): LongTermMemory {
    return this.longTermStore;
  }

  async buildContext(input: {
    session: Session;
    runId: Id;
    systemPrompt: string;
    tools: ModelToolSpec[];
    budget: ContextBudget;
  }): Promise<BuiltContext> {
    const { session, systemPrompt, tools, budget } = input;

    const summary = await this.store.getActiveSummary(session.id);
    const messages = await this.store.listMessages(session.id, {
      fromSeq: summary ? summary.toSeq + 1 : 1,
      includeExcluded: false,
    });

    let effectiveSystem = systemPrompt;
    if (summary) {
      effectiveSystem += `\n\n<conversation_summary>\n${summary.content}\n</conversation_summary>`;
    }

    let recalledIds: Id[] = [];
    let episodeIds: Id[] = [];
    if (session.config.memoryRecall?.enabled) {
      const limit = session.config.memoryRecall.limit ?? 8;
      const latestUserText = [...messages]
        .reverse()
        .find((m) => m.role === 'user')
        ?.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .trim();
      const query = latestUserText || undefined;
      const bindings = scopeBindings(session);
      const candidates = await this.longTermStore.recall({
        scopes: bindings.map((binding) => binding.scopeType),
        bindings,
        query,
        limit,
      });
      const filtered = candidates.filter((record) => visibleMemory(session, record)).slice(0, limit);
      if (filtered.length > 0) {
        recalledIds = filtered.map((record) => record.id);
        effectiveSystem += renderMemories(filtered);
      }

      const episodes = rankEpisodes(await this.store.listEpisodes(session.id), query, summary?.id ?? null);
      if (episodes.length > 0) {
        episodeIds = episodes.map((episode) => episode.id);
        effectiveSystem += renderEpisodes(episodes);
      }
    }

    const systemEstimate = estimateTextTokens(effectiveSystem);
    const toolsEstimate = estimateContentTokens(tools);
    const overhead = systemEstimate + toolsEstimate + budget.reserveForOutput;

    const availableTokens = budget.maxInputTokens - overhead;
    if (availableTokens <= 0) {
      throw new ContextOverflowError('System prompt and tools exceed maximum input token budget');
    }
    if (recalledIds.length > 0) {
      await this.store.touchMemories(recalledIds);
    }

    const groups = groupMessages(messages);
    const totalTokens = groups.reduce((sum, group) => sum + group.tokens, 0);
    let selected: Message[];
    if (totalTokens <= availableTokens) {
      selected = messages.slice();
    } else {
      let tokens = 0;
      let start = groups.length;
      for (let index = groups.length - 1; index >= 0; index--) {
        const next = tokens + groups[index].tokens;
        if (next > availableTokens) break;
        tokens = next;
        start = index;
      }
      selected = flattenGroups(groups, start);
    }

    selected = withoutLeadingToolMessages(selected);
    const currentTokens = selected.reduce((sum, message) => sum + estimateContentTokens(message.content), 0);
    const contextMessages: ContextMessage[] = selected.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const manifest: ContextManifest = {
      summaryId: summary?.id ?? null,
      summaryRange: summary ? [summary.fromSeq, summary.toSeq] : null,
      messageSeqRange: selected.length > 0 ? [selected[0].seq, selected[selected.length - 1].seq] : null,
      memoryIds: recalledIds,
      episodeIds,
      droppedMessageCount: messages.length - selected.length,
    };

    return {
      system: effectiveSystem,
      messages: contextMessages,
      manifest,
      estimatedTokens: currentTokens + systemEstimate + toolsEstimate,
    };
  }

  async maintain(sessionId: Id, signal: AbortSignal): Promise<{ summaryCreated?: Id }> {
    if (signal.aborted) return {};

    const session = await this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (signal.aborted) return {};

    const settings = compactionOf(session);
    if (!settings.enabled) return {};

    const previous = await this.store.getActiveSummary(sessionId);
    if (signal.aborted) return {};

    const messages = await this.store.listMessages(sessionId, {
      fromSeq: previous ? previous.toSeq + 1 : 1,
      includeExcluded: false,
    });
    const systemTokens = estimateTextTokens(session.config.systemPrompt);
    const messageTokens = messages.reduce((sum, message) => sum + estimateContentTokens(message.content), 0);
    const threshold = settings.contextWindow - settings.reserveTokens;
    if (systemTokens + messageTokens <= threshold) return {};

    const groups = groupMessages(messages);
    const keepStart = selectKeepStart(groups, settings.keepRecentTokens);
    if (keepStart === null) return {};

    const summarized = groups.slice(0, keepStart).flatMap((group) => group.messages);
    if (summarized.length === 0) return {};
    if (signal.aborted) return {};

    const result = await this.summarizer.summarize(
      previous ? { previousSummary: previous.content, messages: summarized } : { messages: summarized },
      signal
    );
    if (signal.aborted) return {};

    const saved = await this.saveCompactedSummary(sessionId, summarized, result, previous);
    if (session.config.memory?.consolidate !== false) {
      await this.consolidate(session, summarized, saved, signal);
    }
    return { summaryCreated: saved.id };
  }

  /**
   * Writes a retrievable episode for this span and promotes explicit durable
   * facts. Preferences follow the user when the session has a userId.
   * Raw messages stay in the transcript either way.
   */
  private async consolidate(session: Session, summarized: Message[], summary: Summary, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const sourceText = summarized
      .flatMap((message) =>
        message.content
          .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
          .map((block) => block.text)
      )
      .join('\n');
    await this.store.saveEpisode({
      sessionId: session.id,
      summaryId: summary.id,
      fromSeq: summary.fromSeq,
      toSeq: summary.toSeq,
      title: episodeTitle(summary.content),
      content: summary.content,
      entities: extractEntities(`${summary.content}\n${sourceText}`),
      tokenEstimate: estimateTextTokens(summary.content),
    });
    const userId = session.config.memory?.userId;
    for (const fact of extractFacts(summarized)) {
      if (signal.aborted) return;
      const userScoped = fact.kind === 'preference' && Boolean(userId);
      await this.store.insertMemory({
        scopeType: userScoped ? 'user' : 'session',
        scopeId: userScoped ? userId! : session.id,
        kind: fact.kind,
        content: fact.content,
        contentKey: fact.contentKey,
        sourceType: 'message',
        sourceRef: fact.sourceRef,
        sourceSessionId: session.id,
        confidence: 0.7,
        salience: fact.salience,
        tags: fact.tags,
        createdBy: userScoped ? userId! : 'memory-consolidator',
      });
    }
  }

  private async saveCompactedSummary(
    sessionId: Id,
    summarized: Message[],
    result: { content: string; model: string; promptVersion: string },
    previous: Summary | null
  ): Promise<Summary> {
    return this.store.saveSummary({
      sessionId,
      fromSeq: summarized[0].seq,
      toSeq: summarized[summarized.length - 1].seq,
      content: result.content,
      tokenEstimate: estimateTextTokens(result.content),
      model: result.model,
      promptVersion: result.promptVersion,
      ...(previous ? { supersedesId: previous.id } : {}),
    });
  }
}
