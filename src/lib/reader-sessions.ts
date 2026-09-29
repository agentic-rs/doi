import type { NavigationHistory } from './history';
import type { Paper, ReadingLocation, SelectionContext } from './types';

export interface ReaderSession {
  paper: Paper;
  history: NavigationHistory;
  location: ReadingLocation;
  selection: SelectionContext | null;
  question: string;
  note_draft: string;
  composer_kind: 'ai' | 'note';
  inspector_tab: 'references' | 'notes';
  edit_id: string | null;
  edit_draft: string;
  source_paper_id: string | null;
}

// Removal must prune every trail, including entries before/after its cursor.
export function removePaperFromHistory(history: NavigationHistory, paperId: string): NavigationHistory {
  const before = history.entries.slice(0, history.current_index + 1).filter((entry) => entry.paper_id !== paperId);
  const entries = history.entries.filter((entry) => entry.paper_id !== paperId);
  return { entries, current_index: entries.length ? Math.max(0, before.length - 1) : -1 };
}

export function sortRecentPapers(papers: Paper[]): Paper[] {
  return [...papers].sort((left, right) => (right.last_opened_at || right.downloaded_at)
    .localeCompare(left.last_opened_at || left.downloaded_at));
}

export function findLibraryPaper(papers: Paper[], arxivId: string): Paper | undefined {
  return papers.filter((paper) => paper.paper_id === arxivId || paper.arxiv_id === arxivId)
    .sort((left, right) => right.arxiv_version - left.arxiv_version)[0];
}
