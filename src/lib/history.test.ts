import { describe, expect, it } from 'vitest';
import { canGoBack, canGoForward, createHistory, currentLocation, goBack, goForward, pushLocation, updateCurrent } from './history';
import type { ReadingLocation } from './types';

const location = (paper_id: string, page_number = 1): ReadingLocation => ({
  paper_id, page_number, page_position: [0.05, 0.7], zoom: 1.25, rotation: 0,
});

describe('paper navigation', () => {
  it('restores the position before a citation jump, including cross-paper jumps', () => {
    let history = createHistory(location('a'));
    history = updateCurrent(history, { ...location('a', 4), page_position: [0.03, 0.512], rotation: 90 });
    history = pushLocation(history, location('a', 12));
    history = pushLocation(history, location('b', 3));
    history = goBack(history);
    expect(currentLocation(history)).toEqual(location('a', 12));
    history = goBack(history);
    expect(currentLocation(history)).toEqual({ ...location('a', 4), page_position: [0.03, 0.512], rotation: 90 });
    expect(currentLocation(goForward(goForward(history)))).toEqual(location('b', 3));
  });

  it('discards the forward branch on a new jump but preserves scroll updates', () => {
    const history = goBack(pushLocation(pushLocation(createHistory(location('a')), location('b')), location('c')));
    const scrolled = updateCurrent(history, location('b', 5));
    expect(canGoForward(scrolled)).toBe(true);
    const branched = pushLocation(scrolled, location('d'));
    expect(branched.entries.map((entry) => entry.paper_id)).toEqual(['a', 'b', 'd']);
    expect(canGoForward(branched)).toBe(false);
    expect(currentLocation(goBack(branched))?.page_number).toBe(5);
  });

  it('owns coordinate arrays and safely handles empty and boundary histories', () => {
    const initial = location('a');
    const history = createHistory(initial);
    initial.page_position[0] = 999;
    expect(currentLocation(history)?.page_position[0]).toBe(0.05);
    expect(canGoBack(history)).toBe(false);
    expect(goBack(history)).toBe(history);
    expect(goForward(history)).toBe(history);
    expect(currentLocation(createHistory())).toBeNull();
  });
});
