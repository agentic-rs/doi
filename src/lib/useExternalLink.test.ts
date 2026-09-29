// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openExternal } from './tauri';
import { useExternalLink } from './useExternalLink';

vi.mock('./tauri', () => ({ openExternal: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(openExternal).mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('external link confirmation', () => {
  it('invalidates a canceled or replaced confirmation before the next render', async () => {
    const { result } = renderHook(() => useExternalLink(vi.fn()));
    act(() => result.current.requestOpen('https://example.com/first'));
    const firstConfirmation = result.current.confirmOpen;
    await act(async () => {
      result.current.cancel();
      await firstConfirmation();
    });
    expect(openExternal).not.toHaveBeenCalled();
    act(() => result.current.requestOpen('https://example.com/first'));
    const replacedConfirmation = result.current.confirmOpen;
    await act(async () => {
      result.current.requestOpen('https://example.com/second');
      await replacedConfirmation();
    });
    expect(openExternal).not.toHaveBeenCalled();
    expect(result.current.request?.url).toBe('https://example.com/second');
    await act(async () => result.current.confirmOpen());
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/second');
  });

  it('locks confirmation synchronously and rejects cancel and replacement while opening', async () => {
    const opening = deferred();
    vi.mocked(openExternal).mockReturnValueOnce(opening.promise);
    const { result } = renderHook(() => useExternalLink(vi.fn()));
    act(() => result.current.requestOpen('https://example.com'));
    expect(openExternal).not.toHaveBeenCalled();
    let confirmation!: Promise<void>;
    act(() => {
      confirmation = result.current.confirmOpen();
      void result.current.confirmOpen();
      result.current.cancel();
      result.current.requestOpen('https://example.org');
    });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/');
    expect(result.current.request).toEqual({ url: 'https://example.com/', busy: true, error: null });
    await act(async () => { opening.resolve(); await confirmation; });
    expect(result.current.request).toBeNull();
  });

  it('keeps a failed opening available for retry using a new confirmation', async () => {
    vi.mocked(openExternal).mockRejectedValueOnce(new Error('Browser unavailable'));
    const { result } = renderHook(() => useExternalLink(vi.fn()));
    act(() => result.current.requestOpen('https://example.com'));
    const firstConfirmation = result.current.confirmOpen;
    await act(async () => firstConfirmation());
    expect(result.current.request).toEqual({
      url: 'https://example.com/', busy: false, error: 'Could not open this link: Error: Browser unavailable',
    });
    await act(async () => firstConfirmation());
    expect(openExternal).toHaveBeenCalledTimes(1);
    await act(async () => result.current.confirmOpen());
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(result.current.request).toBeNull();
  });

  it('invalidates earlier confirmation when an invalid URL is requested', async () => {
    const on_invalid = vi.fn();
    const { result } = renderHook(() => useExternalLink(on_invalid));
    act(() => result.current.requestOpen('https://example.com'));
    const confirmation = result.current.confirmOpen;
    await act(async () => {
      result.current.requestOpen('javascript:alert(1)');
      await confirmation();
    });
    expect(on_invalid).toHaveBeenCalledExactlyOnceWith('This link is not a valid HTTP or HTTPS URL.');
    expect(result.current.request).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('ignores stale handlers and pending failures after unmount', async () => {
    const opening = deferred();
    vi.mocked(openExternal).mockReturnValueOnce(opening.promise);
    const on_invalid = vi.fn();
    const { result, unmount } = renderHook(() => useExternalLink(on_invalid));
    act(() => result.current.requestOpen('https://example.com'));
    const stale = result.current;
    let confirmation!: Promise<void>;
    act(() => { confirmation = stale.confirmOpen(); });
    unmount();
    stale.requestOpen('https://example.org');
    stale.requestOpen('invalid');
    stale.cancel();
    await stale.confirmOpen();
    await act(async () => { opening.reject(new Error('Late failure')); await confirmation; });
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/');
    expect(on_invalid).not.toHaveBeenCalled();
  });
});
