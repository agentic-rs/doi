import { describe, expect, it } from 'vitest';
import { canGoBack, canGoForward, currentLocation, goBack, goForward } from './history';
import type { NavigationHistory } from './history';
import { findLibraryPaper, removePaperFromHistory, sortRecentPapers } from './reader-sessions';
import type { Paper, ReadingLocation } from './types';

function location(paper_id: string, page_number: number): ReadingLocation {
  return { paper_id, page_number, page_position: [.2, .7], zoom: 1.5, zoom_mode: 'custom', rotation: 90, reader_mode: 'pdf' };
}

function paper(arxiv_id: string, version: number, opened: string | null = null): Paper {
  return {
    paper_id: `${arxiv_id}v${version}`, arxiv_id, arxiv_version: version, title: `${arxiv_id} version ${version}`,
    authors: [], abstract: '', pdf_url: '', pdf_hash: 'a'.repeat(64),
    downloaded_at: '2026-09-20T00:00:00Z', last_opened_at: opened, last_location: null,
  };
}

describe('reader sessions after paper removal', () => {
  it('prunes repeated visits on both sides of the cursor while preserving the current surviving passage', () => {
    const entries = [location('a', 1), location('b', 2), location('a', 3), location('c', 4), location('b', 5), location('d', 6)];
    const history: NavigationHistory = { entries, current_index: 3 };
    const remaining = removePaperFromHistory(history, 'b');
    expect(remaining.entries.map((entry) => [entry.paper_id, entry.page_number])).toEqual([['a', 1], ['a', 3], ['c', 4], ['d', 6]]);
    expect(remaining.current_index).toBe(2);
    expect(currentLocation(remaining)).toEqual(location('c', 4));
    expect(currentLocation(goBack(remaining))).toEqual(location('a', 3));
    expect(currentLocation(goForward(remaining))).toEqual(location('d', 6));
    expect(history.entries).toHaveLength(6);
    expect(history.current_index).toBe(3);
  });

  it('moves a deleted current entry to its surviving predecessor, or the first successor at the start', () => {
    const entries = [location('a', 1), location('b', 2), location('c', 3)];
    const middle = removePaperFromHistory({ entries, current_index: 1 }, 'b');
    expect(currentLocation(middle)).toEqual(location('a', 1));
    expect(canGoBack(middle)).toBe(false);
    expect(canGoForward(middle)).toBe(true);
    const first = removePaperFromHistory({ entries: [location('b', 2), location('a', 1), location('c', 3)], current_index: 0 }, 'b');
    expect(currentLocation(first)).toEqual(location('a', 1));
    expect(first.current_index).toBe(0);
  });

  it('returns a valid empty history when all entries are removed and preserves unrelated histories', () => {
    expect(removePaperFromHistory({ entries: [location('b', 1), location('b', 8)], current_index: 1 }, 'b'))
      .toEqual({ entries: [], current_index: -1 });
    expect(removePaperFromHistory({ entries: [], current_index: -1 }, 'b')).toEqual({ entries: [], current_index: -1 });
    const unrelated = { entries: [location('a', 7), location('c', 2)], current_index: 1 };
    expect(removePaperFromHistory(unrelated, 'b')).toEqual(unrelated);
  });
});

describe('canonical library paper matching', () => {
  it('uses the latest cached numeric version for an unversioned ID and the exact requested version otherwise', () => {
    const older = paper('1706.03762', 1);
    const latest = paper('1706.03762', 10);
    const ninth = paper('1706.03762', 9);
    const others = paper('2005.14165', 20);
    const papers = [ninth, others, latest, older];
    expect(findLibraryPaper(papers, '1706.03762')).toBe(latest);
    expect(findLibraryPaper(papers, '1706.03762v1')).toBe(older);
    expect(findLibraryPaper(papers, '1706.03762v2')).toBeUndefined();
    expect(findLibraryPaper(papers, '1706.0376')).toBeUndefined();
    expect(papers).toEqual([ninth, others, latest, older]);
  });

  it('supports canonical legacy IDs with archive prefixes without matching similar archive names', () => {
    const first = paper('hep-th/9901001', 1);
    const second = paper('hep-th/9901001', 2);
    const otherArchive = paper('hep-ph/9901001', 5);
    expect(findLibraryPaper([otherArchive, first, second], 'hep-th/9901001')).toBe(second);
    expect(findLibraryPaper([otherArchive, first, second], 'hep-th/9901001v1')).toBe(first);
    expect(findLibraryPaper([otherArchive, first, second], 'hep-th/9901001v3')).toBeUndefined();
  });

  it('sorts by last opening and falls back to download time for legacy or unopened papers', () => {
    const recent = paper('1706.03762', 7, '2026-09-29T00:00:00Z');
    const unopened = { ...paper('2005.14165', 4), downloaded_at: '2026-09-28T00:00:00Z' };
    const legacy = paper('1409.0473', 3);
    delete legacy.last_opened_at;
    const papers = [legacy, unopened, recent];
    expect(sortRecentPapers(papers)).toEqual([recent, unopened, legacy]);
    expect(papers).toEqual([legacy, unopened, recent]);
  });
});
