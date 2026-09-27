import type { ReadingLocation } from './types';

export interface NavigationHistory {
  entries: ReadingLocation[];
  current_index: number;
}

const cloneLocation = (location: ReadingLocation): ReadingLocation => ({
  ...location,
  page_position: [...location.page_position],
});

export function createHistory(initial: ReadingLocation | null = null): NavigationHistory {
  return { entries: initial ? [cloneLocation(initial)] : [], current_index: initial ? 0 : -1 };
}

export const currentLocation = (history: NavigationHistory): ReadingLocation | null =>
  history.entries[history.current_index] ?? null;
export const canGoBack = (history: NavigationHistory) => history.current_index > 0;
export const canGoForward = (history: NavigationHistory) =>
  history.current_index >= 0 && history.current_index < history.entries.length - 1;

export function updateCurrent(history: NavigationHistory, location: ReadingLocation): NavigationHistory {
  if (history.current_index < 0) return createHistory(location);
  const entries = [...history.entries];
  entries[history.current_index] = cloneLocation(location);
  return { ...history, entries };
}

export function pushLocation(history: NavigationHistory, target: ReadingLocation): NavigationHistory {
  const entries = [...history.entries.slice(0, history.current_index + 1), cloneLocation(target)].slice(-200);
  return { entries, current_index: entries.length - 1 };
}

export function goBack(history: NavigationHistory): NavigationHistory {
  return canGoBack(history) ? { ...history, current_index: history.current_index - 1 } : history;
}

export function goForward(history: NavigationHistory): NavigationHistory {
  return canGoForward(history) ? { ...history, current_index: history.current_index + 1 } : history;
}
