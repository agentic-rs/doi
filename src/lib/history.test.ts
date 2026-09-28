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

  it('returns from an original-PDF jump to the reordered reading block and forward again', () => {
    const reading: ReadingLocation = {
      ...location('a', 6), reader_mode: 'reading', reading_block_id: 'page-6-figure-2',
      page_position: [0.1, 0.3], zoom_mode: 'fit_width',
    };
    const original: ReadingLocation = {
      ...location('a', 6), reader_mode: 'pdf', reading_block_id: null,
      page_position: [0.2, 0.75], zoom: 1.8, zoom_mode: 'custom', rotation: 90,
    };
    let history = createHistory(reading);
    history = pushLocation(history, original);
    const scrolledOriginal = { ...original, page_position: [0.25, 0.8] as [number, number] };
    history = updateCurrent(history, scrolledOriginal);
    history = goBack(history);
    expect(currentLocation(history)).toEqual(reading);
    expect(currentLocation(goForward(history))).toEqual(scrolledOriginal);
    original.page_position[0] = 1;
    reading.page_position[0] = 1;
    expect(currentLocation(history)?.page_position).toEqual([0.1, 0.3]);
  });

  it('preserves each paper’s reader mode and block through citation navigation', () => {
    const reading: ReadingLocation = {
      ...location('a', 8), reader_mode: 'reading', reading_block_id: 'page-8-text-3',
    };
    const citation: ReadingLocation = {
      ...location('b', 3), reader_mode: 'reading', reading_block_id: 'page-3-text-1',
    };
    let history = pushLocation(createHistory(reading), citation);
    history = pushLocation(history, { ...location('c'), reader_mode: 'pdf' });
    history = goBack(history);
    expect(currentLocation(history)).toEqual(citation);
    expect(currentLocation(goBack(history))).toEqual(reading);

    const laterPassage: ReadingLocation = { ...citation, reading_block_id: 'page-3-text-2' };
    history = updateCurrent(history, laterPassage);
    history = goForward(history);
    expect(currentLocation(history)?.reader_mode).toBe('pdf');
    expect(currentLocation(goBack(history))).toEqual(laterPassage);
  });
});
