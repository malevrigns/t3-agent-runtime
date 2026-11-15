import type { Id } from '../core/types.js';
import type { LongTermMemory, MemoryRecallQuery, MemoryRecord, NewMemory } from './ports.js';
import type { SessionStore } from '../store/ports.js';

export class StoreLongTermMemory implements LongTermMemory {
  constructor(private readonly store: SessionStore) {}

  remember(input: NewMemory): Promise<MemoryRecord> {
    return this.store.insertMemory(input);
  }

  recall(q: MemoryRecallQuery): Promise<MemoryRecord[]> {
    return this.store.queryMemories(q);
  }

  correct(id: Id, input: { content: string; reason: string; by: string }): Promise<MemoryRecord> {
    return this.store.correctMemory(id, input);
  }

  forget(id: Id, input: { reason: string; by: string }): Promise<void> {
    return this.store.forgetMemory(id, input);
  }

  history(id: Id): Promise<MemoryRecord[]> {
    return this.store.getMemoryHistory(id);
  }
}
