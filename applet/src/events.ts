import type { AiStreamEvent, OperationProgress } from '../../src/lib/types';

export function eventBus<T>() {
  const handlers = new Set<(event: T) => void>();
  return {
    emit(event: T) { for (const handler of handlers) handler(event); },
    async listen(handler: (event: T) => void) {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
  };
}

export const ai_events = eventBus<AiStreamEvent>();
export const progress_events = eventBus<OperationProgress>();
