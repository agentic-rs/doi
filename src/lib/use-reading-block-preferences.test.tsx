// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingBlock, ReadingBlockPreference } from './types';
import { useReadingBlockPreferences } from './use-reading-block-preferences';

const fixture = vi.hoisted(() => ({ native: true, list: vi.fn(), save: vi.fn(), reset: vi.fn() }));
vi.mock('./tauri', () => ({
  nativeAvailable: () => fixture.native,
  listReadingBlockPreferences: fixture.list,
  saveReadingBlockPreference: fixture.save,
  resetReadingBlockPreference: fixture.reset,
}));

const block: ReadingBlock = {
  block_id: 'p2-b3', page_number: 2, source_rect: [50, 100, 300, 400],
  kind: 'text', block_type: 'content', text: 'A paragraph with multiple lines.', figure_label: null,
};
const preference: ReadingBlockPreference = {
  pdf_hash: 'a', page_number: block.page_number, source_rect: [...block.source_rect], split_lines: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (failure: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.native = true;
  fixture.list.mockResolvedValue([]);
  fixture.save.mockResolvedValue(undefined);
  fixture.reset.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('Reading block preferences', () => {
  it('loads on demand and matches source geometry independently of rebuilt block IDs', async () => {
    fixture.list.mockResolvedValue([preference, { ...preference, pdf_hash: 'old', page_number: 3 }]);
    const hook = renderHook(({ enabled }) => useReadingBlockPreferences('paper', 'a', enabled), { initialProps: { enabled: false } });
    expect(fixture.list).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.isSplit(block)).toBe(false);
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(fixture.list).toHaveBeenCalledExactlyOnceWith('paper');
    expect(hook.result.current.isSplit({ ...block, block_id: 'rebuilt-id', source_rect: [50.005, 100.005, 300.005, 400.005] })).toBe(true);
    expect(hook.result.current.isSplit({ ...block, source_rect: [50.02, 100, 300, 400] })).toBe(false);
    expect(hook.result.current.isSplit({ ...block, page_number: 3 })).toBe(false);
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(hook.result.current.isSplit(block)).toBe(true);
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });

  it('finishes an in-flight load while PDF mode is visible and reuses it', async () => {
    const load = deferred<ReadingBlockPreference[]>();
    fixture.list.mockReturnValue(load.promise);
    const hook = renderHook(({ enabled }) => useReadingBlockPreferences('paper', 'a', enabled), { initialProps: { enabled: true } });
    hook.rerender({ enabled: false });
    await act(async () => load.resolve([preference]));
    hook.rerender({ enabled: true });
    expect(hook.result.current.isSplit(block)).toBe(true);
    expect(fixture.list).toHaveBeenCalledTimes(1);
  });

  it('blocks mutation before a successful load and permits explicit retry after failure', async () => {
    const load = deferred<ReadingBlockPreference[]>();
    fixture.list.mockReturnValueOnce(load.promise);
    const hook = renderHook(({ enabled }) => useReadingBlockPreferences('paper', 'a', enabled), { initialProps: { enabled: false } });
    expect(await hook.result.current.setSplit(block, true)).toBe(false);
    hook.rerender({ enabled: true });
    expect(hook.result.current.loading).toBe(true);
    expect(await hook.result.current.setSplit(block, true)).toBe(false);
    await act(async () => load.reject(new Error('Database unavailable')));
    expect(hook.result.current.error).toBe('Database unavailable');
    expect(hook.result.current.loading).toBe(false);
    expect(await hook.result.current.setSplit(block, true)).toBe(false);
    expect(fixture.save).not.toHaveBeenCalled();
    fixture.list.mockResolvedValue([preference]);
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.isSplit(block)).toBe(true));
    expect(hook.result.current.error).toBeNull();
    expect(fixture.list).toHaveBeenCalledTimes(2);
  });

  it('persists splitting before changing the visible choice and retains prior state on failure', async () => {
    const save = deferred<void>();
    fixture.save.mockReturnValueOnce(save.promise);
    const hook = renderHook(() => useReadingBlockPreferences('paper', 'a', true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let result!: Promise<boolean>;
    act(() => { result = hook.result.current.setSplit(block, true); });
    expect(hook.result.current.busy).toBe(block.block_id);
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('paper', preference);
    expect(await hook.result.current.setSplit({ ...block, block_id: 'neighbor' }, true)).toBe(false);
    await act(async () => { save.reject('Disk full'); expect(await result).toBe(false); });
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(hook.result.current.error).toBe('Disk full');
    expect(hook.result.current.busy).toBeNull();
    await act(async () => { expect(await hook.result.current.setSplit(block, true)).toBe(true); });
    expect(hook.result.current.isSplit(block)).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(fixture.save).toHaveBeenCalledTimes(2);
  });

  it('persists reset before changing the visible choice and allows a failed reset to be retried', async () => {
    fixture.list.mockResolvedValue([preference]);
    const reset = deferred<void>();
    fixture.reset.mockReturnValueOnce(reset.promise);
    const hook = renderHook(() => useReadingBlockPreferences('paper', 'a', true));
    await waitFor(() => expect(hook.result.current.isSplit(block)).toBe(true));
    let result!: Promise<boolean>;
    act(() => { result = hook.result.current.setSplit(block, false); });
    expect(hook.result.current.isSplit(block)).toBe(true);
    expect(hook.result.current.busy).toBe(block.block_id);
    expect(fixture.reset).toHaveBeenCalledExactlyOnceWith('paper', { ...preference, split_lines: false });
    await act(async () => { reset.reject(new Error('Read-only database')); expect(await result).toBe(false); });
    expect(hook.result.current.isSplit(block)).toBe(true);
    expect(hook.result.current.error).toBe('Read-only database');
    await act(async () => { expect(await hook.result.current.setSplit(block, false)).toBe(true); });
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(fixture.reset).toHaveBeenCalledTimes(2);
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores a late load %s after changing papers', async (completion) => {
    const load = deferred<ReadingBlockPreference[]>();
    fixture.list.mockReturnValueOnce(load.promise);
    const hook = renderHook(({ paper_id }) => useReadingBlockPreferences(paper_id, 'a', true), { initialProps: { paper_id: 'first' } });
    hook.rerender({ paper_id: 'second' });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      if (completion === 'resolve') load.resolve([preference]);
      else load.reject(new Error('Old paper load failed'));
    });
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(hook.result.current.error).toBeNull();
    expect(fixture.list).toHaveBeenNthCalledWith(2, 'second');
  });

  it.each(['resolve', 'reject'] as const)('ignores a late mutation %s after changing papers', async (completion) => {
    const save = deferred<void>();
    fixture.save.mockReturnValueOnce(save.promise);
    const hook = renderHook(({ paper_id }) => useReadingBlockPreferences(paper_id, 'a', true), { initialProps: { paper_id: 'first' } });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let result!: Promise<boolean>;
    const stale_set_split = hook.result.current.setSplit;
    act(() => { result = hook.result.current.setSplit(block, true); });
    hook.rerender({ paper_id: 'second' });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => {
      if (completion === 'resolve') save.resolve();
      else save.reject(new Error('Old paper write failed'));
      expect(await result).toBe(false);
    });
    expect(await stale_set_split(block, true)).toBe(false);
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(hook.result.current.busy).toBeNull();
    expect(hook.result.current.error).toBeNull();
  });

  it('filters loaded choices by hash and drops old choices immediately on revision changes', async () => {
    fixture.list.mockResolvedValue([preference]);
    const hook = renderHook(({ hash }) => useReadingBlockPreferences('paper', hash, true), { initialProps: { hash: 'a' } });
    await waitFor(() => expect(hook.result.current.isSplit(block)).toBe(true));
    hook.rerender({ hash: 'b' });
    expect(hook.result.current.isSplit(block)).toBe(false);
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    expect(hook.result.current.isSplit(block)).toBe(false);
    await act(async () => { expect(await hook.result.current.setSplit(block, true)).toBe(true); });
    expect(fixture.save).toHaveBeenCalledExactlyOnceWith('paper', { ...preference, pdf_hash: 'b' });
  });

  it('invalidates pending writes and stale callbacks on unmount', async () => {
    const save = deferred<void>();
    fixture.save.mockReturnValueOnce(save.promise);
    const hook = renderHook(() => useReadingBlockPreferences('paper', 'a', true));
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    let result!: Promise<boolean>;
    const set_split = hook.result.current.setSplit;
    act(() => { result = set_split(block, true); });
    hook.unmount();
    save.resolve();
    expect(await result).toBe(false);
    expect(await set_split(block, true)).toBe(false);
    expect(fixture.save).toHaveBeenCalledTimes(1);
  });

  it('supports memory-only browser development and keeps choices within their paper', async () => {
    fixture.native = false;
    const hook = renderHook(({ paper_id, enabled }) => useReadingBlockPreferences(paper_id, 'a', enabled), {
      initialProps: { paper_id: 'first', enabled: true },
    });
    await waitFor(() => expect(hook.result.current.loading).toBe(false));
    await act(async () => { expect(await hook.result.current.setSplit(block, true)).toBe(true); });
    hook.rerender({ paper_id: 'first', enabled: false });
    hook.rerender({ paper_id: 'first', enabled: true });
    expect(hook.result.current.isSplit(block)).toBe(true);
    hook.rerender({ paper_id: 'second', enabled: true });
    expect(hook.result.current.isSplit(block)).toBe(false);
    expect(fixture.list).not.toHaveBeenCalled();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.reset).not.toHaveBeenCalled();
  });
});
