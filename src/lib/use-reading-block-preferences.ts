import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingBlock, ReadingBlockPreference } from './types';
import { listReadingBlockPreferences, nativeAvailable, resetReadingBlockPreference, saveReadingBlockPreference, saveReadingBlockPreferences } from './backend';

interface PreferenceState {
  paper_id: string;
  pdf_hash: string;
  status: 'idle' | 'loading' | 'ready' | 'failed';
  preferences: ReadingBlockPreference[];
  busy: { kind: 'block'; block_id: string } | { kind: 'all' } | null;
  error: string | null;
}

function initialState(paper_id: string, pdf_hash: string): PreferenceState {
  return { paper_id, pdf_hash, status: 'idle', preferences: [], busy: null, error: null };
}

function matchesBlock(preference: ReadingBlockPreference, block: ReadingBlock): boolean {
  return preference.page_number === block.page_number && preference.source_rect.every((coordinate, index) =>
    coordinate >= block.source_rect[index] - 0.01 && coordinate <= block.source_rect[index] + 0.01);
}

function errorMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : fallback;
}

/** Durable choices use original PDF geometry, independently of derived block IDs. */
export function useReadingBlockPreferences(paper_id: string, pdf_hash: string, enabled: boolean) {
  const [state, setState] = useState(() => initialState(paper_id, pdf_hash));
  const state_ref = useRef(state);
  const mounted = useRef(false);
  const generation = useRef(0);
  const latest_source = useRef({ paper_id, pdf_hash });
  latest_source.current = { paper_id, pdf_hash };
  const [attempt, setAttempt] = useState(0);

  const publish = useCallback((next: PreferenceState) => {
    state_ref.current = next;
    setState(next);
  }, []);
  const isCurrent = useCallback((request_generation: number) => mounted.current
    && generation.current === request_generation
    && latest_source.current.paper_id === paper_id && latest_source.current.pdf_hash === pdf_hash, [paper_id, pdf_hash]);

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    publish(initialState(paper_id, pdf_hash));
    return () => { mounted.current = false; generation.current++; };
  }, [paper_id, pdf_hash, publish]);

  useEffect(() => {
    if (!enabled || state_ref.current.status !== 'idle') return;
    const request_generation = generation.current;
    publish({ ...state_ref.current, status: 'loading', error: null });
    // Once requested, a load can finish while PDF mode is visible. Only changing
    // the paper/revision or unmounting invalidates it, so mode switches reuse it.
    void (async () => {
      try {
        const preferences = nativeAvailable() ? await listReadingBlockPreferences(paper_id) : [];
        if (!isCurrent(request_generation)) return;
        publish({ ...state_ref.current, status: 'ready',
          preferences: preferences.filter((preference) => preference.pdf_hash === pdf_hash && preference.split_lines), error: null });
      } catch (failure) {
        if (!isCurrent(request_generation)) return;
        publish({ ...state_ref.current, status: 'failed', error: errorMessage(failure, 'Could not load reading preferences.') });
      }
    })();
  }, [paper_id, pdf_hash, enabled, attempt, isCurrent, publish]);

  const retry = useCallback(() => {
    if (!isCurrent(generation.current) || state_ref.current.status !== 'failed') return;
    publish({ ...state_ref.current, status: 'idle', error: null });
    setAttempt((value) => value + 1);
  }, [isCurrent, publish]);

  const setChoices = useCallback(async (blocks: ReadingBlock[], split: boolean, busy: NonNullable<PreferenceState['busy']>): Promise<boolean> => {
    const request_generation = generation.current;
    const current = state_ref.current;
    if (!isCurrent(request_generation) || current.status !== 'ready' || current.busy !== null) return false;
    const changed = blocks.filter((block) => block.block_type === 'content'
      && current.preferences.some((preference) => matchesBlock(preference, block)) !== split);
    if (!changed.length) {
      if (current.error) publish({ ...current, error: null });
      return true;
    }
    const choices: ReadingBlockPreference[] = changed.map((block) => ({
      pdf_hash, page_number: block.page_number, source_rect: [...block.source_rect], split_lines: split,
    }));
    publish({ ...current, busy, error: null });
    try {
      if (nativeAvailable()) {
        if (busy.kind === 'all') await saveReadingBlockPreferences(paper_id, choices);
        else if (split) await saveReadingBlockPreference(paper_id, choices[0]);
        else await resetReadingBlockPreference(paper_id, choices[0]);
      }
      if (!isCurrent(request_generation)) return false;
      const preferences = current.preferences.filter((item) => !changed.some((block) => matchesBlock(item, block)));
      if (split) preferences.push(...choices);
      publish({ ...current, preferences, busy: null, error: null });
      return true;
    } catch (failure) {
      if (!isCurrent(request_generation)) return false;
      publish({ ...current, busy: null, error: errorMessage(failure, 'Could not save reading preferences.') });
      return false;
    }
  }, [paper_id, pdf_hash, isCurrent, publish]);

  const setSplit = useCallback((block: ReadingBlock, split: boolean) =>
    setChoices([block], split, { kind: 'block', block_id: block.block_id }), [setChoices]);
  const setAllSplit = useCallback((blocks: ReadingBlock[], split: boolean) =>
    setChoices(blocks, split, { kind: 'all' }), [setChoices]);

  const current = state.paper_id === paper_id && state.pdf_hash === pdf_hash ? state : null;
  const isSplit = useCallback((block: ReadingBlock) => current?.status === 'ready'
    && current.preferences.some((preference) => matchesBlock(preference, block)), [current]);
  return {
    isSplit,
    loading: current?.status === 'loading' || (enabled && (!current || current.status === 'idle')),
    load_failed: current?.status === 'failed',
    busy: current?.busy?.kind === 'block' ? current.busy.block_id : null,
    busy_all: current?.busy?.kind === 'all',
    saving: !!current?.busy,
    error: current?.error ?? null,
    retry,
    setSplit,
    setAllSplit,
  };
}
