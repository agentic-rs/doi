// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAnswer, Paper, PdfReaderProps, SelectionContext } from '../lib/types';
import * as backend from '../lib/tauri';
import { WorkspacePage } from './WorkspacePage';

vi.mock('../lib/tauri', () => ({
  desktopAvailable: vi.fn(), listPapers: vi.fn(), getSettings: vi.fn(), onProgress: vi.fn(),
  openArxivPaper: vi.fn(), getPdfBytes: vi.fn(), listAnnotations: vi.fn(), saveReadingPosition: vi.fn(),
  askSelection: vi.fn(), saveAnnotation: vi.fn(), deleteAnnotation: vi.fn(), saveAnnotationFile: vi.fn(),
  resolveReference: vi.fn(), openExternal: vi.fn(), saveSettings: vi.fn(),
}));

let lastReader: PdfReaderProps;
const selection: SelectionContext = {
  selected_text: 'Selected passage', context_text: 'Nearby text',
  page_anchors: [{ page_number: 4, quad_points: [[10, 20, 30, 20, 30, 10, 10, 10]],
    text_quote: { exact_text: 'Selected passage', prefix: '', suffix: '', normalization_version: 1 } }],
};

vi.mock('../components/PdfReader', () => ({
  PdfReader: (props: PdfReaderProps) => {
    lastReader = props;
    return <div data-testid="reader">
      {props.paper.title}
      <button onClick={() => props.on_location_change({ paper_id: props.paper.paper_id, page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90 })}>Scroll source</button>
      <button onClick={() => props.on_navigate({ kind: 'internal', location: { paper_id: props.paper.paper_id, page_number: 12, page_position: [0, 0.2], zoom: 1, rotation: 0 } })}>Follow internal citation</button>
      <button onClick={() => props.on_navigate({ kind: 'external', url: 'https://arxiv.org/abs/1409.0473v3' })}>Follow cited paper</button>
      <button onClick={() => props.on_selection(selection)}>Select passage</button>
    </div>;
  },
}));

const first: Paper = {
  paper_id: '1706.03762v7', arxiv_id: '1706.03762', arxiv_version: 7,
  title: 'First paper', authors: ['Author'], abstract: 'Abstract', pdf_url: '',
  pdf_hash: 'a'.repeat(64), downloaded_at: '2026-09-27T00:00:00Z', last_location: null,
};
const second: Paper = { ...first, paper_id: '1409.0473v3', arxiv_id: '1409.0473', arxiv_version: 3, title: 'Second paper', pdf_hash: 'b'.repeat(64) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(backend.desktopAvailable).mockReturnValue(true);
  vi.mocked(backend.listPapers).mockResolvedValue([first, second]);
  vi.mocked(backend.getSettings).mockResolvedValue({ base_url: 'http://127.0.0.1:11434/v1', model_id: 'local-model', has_api_key: false });
  vi.mocked(backend.onProgress).mockResolvedValue(() => {});
  vi.mocked(backend.getPdfBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(backend.listAnnotations).mockResolvedValue([]);
  vi.mocked(backend.saveReadingPosition).mockResolvedValue();
  vi.mocked(backend.saveAnnotation).mockImplementation(async (annotation) => annotation);
});
afterEach(cleanup);

async function openFirst() {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('button', { name: /^First paper/ }));
  await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('First paper'));
}

describe('assembled paper workspace', () => {
  it('restores source position across internal and cross-paper links', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    expect(lastReader.target_location?.page_number).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('Second paper'));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location?.page_number).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toMatchObject({ page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90 });
    fireEvent.click(screen.getByRole('button', { name: 'Go forward to next reading location' }));
    expect(lastReader.target_location?.page_number).toBe(12);
  });

  it('keeps the current paper and history when a destination fails', async () => {
    await openFirst();
    vi.mocked(backend.getPdfBytes).mockRejectedValueOnce(new Error('Destination unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('reader').textContent).toContain('First paper');
    expect((screen.getByRole('button', { name: 'Go back to previous reading location' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('supports a provider without a key and saves late answers to the selected paper', async () => {
    await openFirst();
    let resolveAnswer!: (answer: AiAnswer) => void;
    vi.mocked(backend.askSelection).mockReturnValue(new Promise((resolve) => { resolveAnswer = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain this passage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask & save answer' }));
    expect(backend.askSelection).toHaveBeenCalledWith(expect.objectContaining({ paper_id: first.paper_id, question: 'Explain this passage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    await act(async () => resolveAnswer({ answer: 'An explanation', provider_id: 'local', model_id: 'local-model', context_text: 'Actual prompt' }));
    await waitFor(() => expect(backend.saveAnnotation).toHaveBeenCalled());
    const saved = vi.mocked(backend.saveAnnotation).mock.calls[0][0];
    expect(saved.target).toMatchObject({ paper_id: first.paper_id, pdf_hash: first.pdf_hash });
    expect(lastReader.annotations).toHaveLength(0);
  });

  it('persists a note in our format and passes its anchor when revisiting it', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    fireEvent.change(screen.getByLabelText('Note for this selection'), { target: { value: 'A useful connection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('A useful connection');
    const saved = vi.mocked(backend.saveAnnotation).mock.calls[0][0];
    expect(saved).toMatchObject({
      schema_version: 1,
      target: { paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors },
      body: { kind: 'note', content: 'A useful connection' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Selected passage/ }));
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
  });
});
