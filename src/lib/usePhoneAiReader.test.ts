// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setReaderAiMode } from './backend';
import type { ReaderOrientation } from './types';
import { usePhoneAiReader } from './usePhoneAiReader';

vi.mock('./backend', () => ({ setReaderAiMode: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function options(enabled = true) {
  return { enabled, on_error: vi.fn(), on_orientation: vi.fn() };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(setReaderAiMode).mockImplementation(async (active) => active ? 'portrait' : 'landscape');
});
afterEach(async () => { cleanup(); await act(async () => {}); });

describe('phone AI reader orientation', () => {
  it('opens only after confirmed portrait and deduplicates pending and already-open requests', async () => {
    const enter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise);
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = result.current.show(); second = result.current.show(); });
    expect(first).toBe(second);
    expect(result.current).toMatchObject({ open: false, pending: true });
    await act(async () => { enter.resolve('portrait'); expect(await first).toBe(true); });
    expect(result.current).toMatchObject({ open: true, pending: false });
    expect(callbacks.on_orientation).toHaveBeenCalledWith('portrait');
    await act(async () => expect(await result.current.show()).toBe(true));
    expect(setReaderAiMode).toHaveBeenCalledTimes(1);
  });

  it('never invokes phone orientation mode when disabled', async () => {
    const { result } = renderHook(() => usePhoneAiReader(options(false)));
    await act(async () => expect(await result.current.show()).toBe(false));
    act(() => result.current.close());
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(setReaderAiMode).not.toHaveBeenCalled();
  });

  it('closes immediately, serializes release after pending entry, and blocks reopening until restored', async () => {
    const enter = deferred<ReaderOrientation>();
    const exit = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise).mockReturnValueOnce(exit.promise);
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    let opening!: Promise<boolean>;
    await act(async () => { opening = result.current.show(); });
    act(() => { result.current.close(); result.current.close(); });
    expect(result.current).toMatchObject({ open: false, pending: true });
    await act(async () => expect(await result.current.show()).toBe(false));
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true]]);
    await act(async () => { enter.resolve('portrait'); expect(await opening).toBe(false); });
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    expect(result.current).toMatchObject({ open: false, pending: true });
    expect(callbacks.on_orientation).not.toHaveBeenCalled();
    await act(async () => exit.resolve('landscape'));
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(callbacks.on_orientation).toHaveBeenCalledExactlyOnceWith('landscape');
    await act(async () => expect(await result.current.show()).toBe(true));
    expect(result.current.open).toBe(true);
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false], [true]]);
  });

  it('hides an open view before restoration finishes and invalidates an already-open show result', async () => {
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    await act(async () => { await result.current.show(); });
    const exit = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(exit.promise);
    let stillOpen!: Promise<boolean>;
    act(() => { stillOpen = result.current.show(); result.current.close(); });
    expect(result.current).toMatchObject({ open: false, pending: true });
    await act(async () => expect(await stillOpen).toBe(false));
    await act(async () => exit.resolve('landscape'));
    expect(result.current.pending).toBe(false);
  });

  it.each(['rejected'])('keeps AI closed after %s entry and releases native mode', async (failure) => {
    if (failure === 'rejected') vi.mocked(setReaderAiMode).mockRejectedValueOnce(new Error('Rotation denied'));
    else vi.mocked(setReaderAiMode).mockResolvedValueOnce('landscape');
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    await act(async () => expect(await result.current.show()).toBe(false));
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(callbacks.on_error).toHaveBeenCalledTimes(1);
    expect(callbacks.on_error.mock.calls[0][0]).toContain('Could not open AI in portrait');
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
  });

  it('reports restoration errors once without retrying or keeping the UI busy', async () => {
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    await act(async () => { await result.current.show(); });
    vi.mocked(setReaderAiMode).mockRejectedValueOnce(new Error('Restore denied'));
    await act(async () => result.current.close());
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(callbacks.on_error).toHaveBeenCalledExactlyOnceWith('Could not restore the reader orientation: Error: Restore denied');
    expect(setReaderAiMode).toHaveBeenCalledTimes(2);
    await act(async () => expect(await result.current.show()).toBe(true));
  });

  it('ignores a superseded entry failure after close while still releasing native mode', async () => {
    const enter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise);
    const callbacks = options();
    const { result } = renderHook(() => usePhoneAiReader(callbacks));
    let opening!: Promise<boolean>;
    await act(async () => { opening = result.current.show(); });
    act(() => result.current.close());
    await act(async () => { enter.reject(new Error('Old entry failed')); expect(await opening).toBe(false); });
    expect(callbacks.on_error).not.toHaveBeenCalled();
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    expect(result.current).toMatchObject({ open: false, pending: false });
  });

  it('releases entry when capability is disabled during the transition', async () => {
    const enter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise);
    const callbacks = options();
    const { result, rerender } = renderHook(({ enabled }) => usePhoneAiReader({ ...callbacks, enabled }), { initialProps: { enabled: true } });
    let opening!: Promise<boolean>;
    await act(async () => { opening = result.current.show(); });
    rerender({ enabled: false });
    await act(async () => { enter.resolve('portrait'); expect(await opening).toBe(false); });
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    rerender({ enabled: true });
    await act(async () => expect(await result.current.show()).toBe(true));
  });

  it('releases a late entry after unmount without callbacks or a late open', async () => {
    const enter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise);
    const callbacks = options();
    const { result, unmount } = renderHook(() => usePhoneAiReader(callbacks));
    let opening!: Promise<boolean>;
    await act(async () => { opening = result.current.show(); });
    unmount();
    await act(async () => { enter.resolve('portrait'); expect(await opening).toBe(false); });
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    expect(callbacks.on_orientation).not.toHaveBeenCalled();
    expect(callbacks.on_error).not.toHaveBeenCalled();
  });

  it('finishes old-mount restoration before entering on a new mount', async () => {
    const oldEnter = deferred<ReaderOrientation>();
    const oldExit = deferred<ReaderOrientation>();
    const newEnter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(oldEnter.promise).mockReturnValueOnce(oldExit.promise).mockReturnValueOnce(newEnter.promise);
    const old = renderHook(() => usePhoneAiReader(options()));
    let oldOpening!: Promise<boolean>;
    await act(async () => { oldOpening = old.result.current.show(); });
    old.unmount();
    const callbacks = options();
    const current = renderHook(() => usePhoneAiReader(callbacks));
    let newOpening!: Promise<boolean>;
    await act(async () => { newOpening = current.result.current.show(); });
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true]]);
    await act(async () => { oldEnter.resolve('portrait'); expect(await oldOpening).toBe(false); });
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    expect(current.result.current.open).toBe(false);
    await act(async () => oldExit.resolve('landscape'));
    expect(vi.mocked(setReaderAiMode).mock.calls).toEqual([[true], [false], [true]]);
    await act(async () => { newEnter.resolve('portrait'); expect(await newOpening).toBe(true); });
    expect(current.result.current).toMatchObject({ open: true, pending: false });
    expect(callbacks.on_orientation).toHaveBeenCalledExactlyOnceWith('portrait');
  });

  it('uses current callbacks for late failures and catches both entry and cleanup rejection', async () => {
    const enter = deferred<ReaderOrientation>();
    vi.mocked(setReaderAiMode).mockReturnValueOnce(enter.promise).mockRejectedValueOnce(new Error('Cleanup failed'));
    const first = options();
    const next = options();
    const { result, rerender } = renderHook(({ callbacks }) => usePhoneAiReader(callbacks), { initialProps: { callbacks: first } });
    let opening!: Promise<boolean>;
    await act(async () => { opening = result.current.show(); });
    rerender({ callbacks: next });
    await act(async () => { enter.reject(new Error('Entry failed')); expect(await opening).toBe(false); });
    expect(first.on_error).not.toHaveBeenCalled();
    expect(next.on_error).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ open: false, pending: false });
    expect(setReaderAiMode).toHaveBeenCalledTimes(2);
  });
});
