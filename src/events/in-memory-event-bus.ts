import type { EventBus, RunEvent } from './ports.js';
import type { Id } from '../core/types.js';

interface Subscription {
  filter: { runId?: Id; sessionId?: Id };
  fn: (e: RunEvent) => void;
}

export class InMemoryEventBus implements EventBus {
  private subs = new Set<Subscription>();
  private runToSession = new Map<Id, Id>();

  registerRunSession(runId: Id, sessionId: Id): void {
    this.runToSession.set(runId, sessionId);
  }

  publish(e: RunEvent): void {
    if (e.type === 'run_started') {
      this.runToSession.set(e.runId, e.sessionId);
    }
    const eventSessionId = 'sessionId' in e ? e.sessionId : this.runToSession.get(e.runId);

    for (const sub of this.subs) {
      if (sub.filter.runId && 'runId' in e && sub.filter.runId !== e.runId) {
        continue;
      }
      if (sub.filter.sessionId && eventSessionId !== sub.filter.sessionId) {
        continue;
      }
      try {
        sub.fn(e);
      } catch (err) {
        // 监听器异常绝对不能阻塞主 Loop
        console.error('[EventBus] Listener error:', err);
      }
    }
  }

  subscribe(filter: { runId?: Id; sessionId?: Id }, fn: (e: RunEvent) => void): () => void {
    const sub: Subscription = { filter, fn };
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }
}
