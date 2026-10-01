// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { ReadingLayout } from './types';
import { useReadingLayout } from './use-reading-layout';

const fixture = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), build: vi.fn() }));
vi.mock('./tauri', () => ({ nativeAvailable: () => true, getReadingLayout: fixture.get, saveReadingLayout: fixture.save }));
vi.mock('./reading-layout', () => ({ READING_LAYOUT_VERSION: 3, buildReadingLayout: fixture.build }));
const pages = [{ pageNumber: 1 }] as PDFPageProxy[];
const layout: ReadingLayout = { layout_version: 3, pdf_hash: 'a', page_count: 1, blocks: [{
  block_id: 'p1-b0', page_number: 1, source_rect: [0, 0, 100, 100], kind: 'original', block_type: 'others', text: '', figure_label: null,
}] };
beforeEach(() => { vi.resetAllMocks(); fixture.get.mockResolvedValue(null); fixture.save.mockResolvedValue(undefined); fixture.build.mockResolvedValue(layout); });
afterEach(cleanup);

describe('Reading layout lifecycle', () => {
  it.each([1, 2])('rebuilds version %i derived layouts and reuses a current cache', async (layout_version) => {
    fixture.get.mockResolvedValueOnce({ ...layout, layout_version });
    const stale = renderHook(() => useReadingLayout(pages, 'a', 'paper', true));
    await waitFor(() => expect(stale.result.current.layout).toEqual(layout));
    expect(fixture.get).toHaveBeenCalledWith('paper', 3);
    expect(fixture.build).toHaveBeenCalledTimes(1);
    expect(fixture.save).toHaveBeenCalledWith('paper', layout);
    stale.unmount();
    fixture.get.mockResolvedValue(layout);
    const current = renderHook(() => useReadingLayout(pages, 'a', 'paper', true));
    await waitFor(() => expect(current.result.current.layout).toEqual(layout));
    expect(fixture.build).toHaveBeenCalledTimes(1);
  });

  it('starts only on demand, reuses the result across mode switches, and survives cache write errors', async () => {
    fixture.save.mockRejectedValue(new Error('Disk full'));
    const hook = renderHook(({ enabled }) => useReadingLayout(pages, 'a', 'paper', enabled), { initialProps: { enabled: false } });
    expect(fixture.build).not.toHaveBeenCalled();
    hook.rerender({ enabled: true });
    await waitFor(() => expect(hook.result.current.layout).toEqual(layout));
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(fixture.build).toHaveBeenCalledTimes(1);
    expect(hook.result.current.error).toBeNull();
  });

  it('ignores stale results after cancellation and a paper switch', async () => {
    let complete!: (value: ReadingLayout) => void;
    fixture.build.mockImplementationOnce(() => new Promise<ReadingLayout>((resolve) => { complete = resolve; }));
    const hook = renderHook(({ source, hash, enabled }) => useReadingLayout(source, hash, hash, enabled), {
      initialProps: { source: pages, hash: 'a', enabled: true },
    });
    await waitFor(() => expect(fixture.build).toHaveBeenCalledTimes(1));
    const signal = fixture.build.mock.calls[0][2] as AbortSignal;
    const other_pages = [{ pageNumber: 1 }] as PDFPageProxy[];
    const other_layout = { ...layout, pdf_hash: 'b' };
    fixture.build.mockResolvedValue(other_layout);
    hook.rerender({ source: other_pages, hash: 'b', enabled: true });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(hook.result.current.layout).toEqual(other_layout));
    await act(async () => { complete(layout); });
    expect(hook.result.current.layout).toEqual(other_layout);
    expect(fixture.save).toHaveBeenCalledTimes(1);
    expect(fixture.save).toHaveBeenCalledWith('b', other_layout);
  });

  it('rejects a stale hash and retries a failed analysis', async () => {
    fixture.get.mockResolvedValue({ ...layout, pdf_hash: 'old-hash' });
    fixture.build.mockRejectedValueOnce(new Error('Canvas unavailable'));
    const hook = renderHook(() => useReadingLayout(pages, 'a', 'paper', true));
    await waitFor(() => expect(hook.result.current.error).toBe('Canvas unavailable'));
    expect(hook.result.current.layout).toBeNull();
    act(() => hook.result.current.retry());
    await waitFor(() => expect(hook.result.current.layout).toEqual(layout));
    expect(hook.result.current.error).toBeNull();
    expect(fixture.build).toHaveBeenCalledTimes(2);
  });
});
