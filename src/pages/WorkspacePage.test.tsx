// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConversation, AiConversationRequest, AiConversationResponse, AiStreamEvent, Annotation, Paper, PdfReaderProps, ReadingLocation, SelectionContext } from '../lib/types';
import * as backend from '../lib/tauri';
import { WorkspacePage } from './WorkspacePage';

vi.mock('../lib/tauri', () => ({
  nativeAvailable: vi.fn(), listPapers: vi.fn(), getSettings: vi.fn(), onProgress: vi.fn(),
  openArxivPaper: vi.fn(), getPdfBytes: vi.fn(), listAnnotations: vi.fn(), saveReadingPosition: vi.fn(),
  askAiConversation: vi.fn(), listAiConversations: vi.fn(), generateAiConversationNote: vi.fn(), updateAiConversationNote: vi.fn(), saveAiConversationNote: vi.fn(),
  onAiStream: vi.fn(), cancelAiRequest: vi.fn(), saveAnnotation: vi.fn(), deleteAnnotation: vi.fn(), saveAnnotationFile: vi.fn(),
  resolveReference: vi.fn(), openExternal: vi.fn(), saveSettings: vi.fn(), listAiModels: vi.fn(),
  getReaderCapabilities: vi.fn(), setReaderOrientation: vi.fn(),
}));

let lastReader: PdfReaderProps;
let readerRenderCount = 0;
const selection: SelectionContext = {
  selected_text: 'Selected passage', context_text: 'Nearby text',
  page_anchors: [{ page_number: 4, quad_points: [[10, 20, 30, 20, 30, 10, 10, 10]],
    text_quote: { exact_text: 'Selected passage', prefix: '', suffix: '', normalization_version: 1 } }],
};

vi.mock('../components/PdfReader', () => ({
  PdfReader: (props: PdfReaderProps) => {
    readerRenderCount += 1;
    lastReader = props;
    return <div data-testid="reader">
      {props.paper.title}
      <button onClick={() => props.on_toggle_controls?.()}>Toggle reading controls</button>
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

function mockLayout(compact: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: compact && query.includes('(max-width: 760px)'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

let conversations: Map<string, AiConversation>;

function completeConversation(request: AiConversationRequest, answer = 'An explanation', content = 'A concise takeaway'): AiConversationResponse {
  const previous = conversations.get(request.conversation_id);
  const now = '2026-09-29T00:00:00Z';
  const conversation: AiConversation = {
    conversation_id: request.conversation_id,
    target: previous?.target ?? { paper_id: request.source!.paper_id, pdf_hash: request.source!.pdf_hash, page_anchors: request.source!.page_anchors },
    selected_text: previous?.selected_text ?? request.source!.selected_text,
    context_text: previous?.context_text ?? request.source!.context_text,
    paper_title: 'First paper', created_at: now, updated_at: now,
    active_request_id: null, active_operation: null,
    turns: [...previous?.turns ?? [], { turn_id: request.request_id, question: request.question, answer, phase: 'complete', provider_id: 'local', model_id: 'model', error: null, created_at: now }],
    note_draft: previous?.note_draft ?? {
      note_id: `note-${request.request_id}`, content, answer, question: request.question,
      provider_id: 'local', model_id: 'model', context_text: 'Actual prompt', created_at: now,
      saved_annotation_id: null, source_turn_count: 1,
    },
  };
  conversations.set(conversation.conversation_id, conversation);
  return { conversation, thinking: '' };
}

function saveConversationNote(conversationId: string, noteId: string, content: string) {
  const conversation = conversations.get(conversationId)!;
  const note = conversation.note_draft!;
  const annotation: Annotation = {
    schema_version: 1, annotation_id: noteId, target: conversation.target,
    body: { kind: 'ai_answer', question: note.question, answer: note.answer, note_content: content,
      provider_id: note.provider_id, model_id: note.model_id, context_text: note.context_text },
    created_at: note.created_at, updated_at: note.created_at,
  };
  const updated = { ...conversation, note_draft: { ...note, content, saved_annotation_id: noteId } };
  conversations.set(conversationId, updated);
  return { conversation: updated, annotation };
}

beforeEach(() => {
  vi.resetAllMocks();
  conversations = new Map();
  readerRenderCount = 0;
  mockLayout(false);
  vi.mocked(backend.nativeAvailable).mockReturnValue(true);
  vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: false });
  vi.mocked(backend.listPapers).mockResolvedValue([first, second]);
  vi.mocked(backend.getSettings).mockResolvedValue({ provider_kind: 'openai_compatible', base_url: 'http://127.0.0.1:11434/v1', model_id: 'local-model', has_api_key: false });
  vi.mocked(backend.onProgress).mockResolvedValue(() => {});
  vi.mocked(backend.onAiStream).mockResolvedValue(() => {});
  vi.mocked(backend.cancelAiRequest).mockResolvedValue();
  vi.mocked(backend.getPdfBytes).mockResolvedValue(new Uint8Array([1, 2, 3]));
  vi.mocked(backend.listAnnotations).mockResolvedValue([]);
  vi.mocked(backend.saveReadingPosition).mockResolvedValue();
  vi.mocked(backend.saveAnnotation).mockImplementation(async (annotation) => annotation);
  vi.mocked(backend.listAiConversations).mockImplementation(async (paperId) => [...conversations.values()].filter((conversation) => conversation.target.paper_id === paperId));
  vi.mocked(backend.askAiConversation).mockImplementation(async (request) => completeConversation(request));
  vi.mocked(backend.updateAiConversationNote).mockImplementation(async (id, _noteId, content) => {
    const previous = conversations.get(id)!;
    const updated = { ...previous, note_draft: { ...previous.note_draft!, content } };
    conversations.set(id, updated);
    return updated;
  });
  vi.mocked(backend.saveAiConversationNote).mockImplementation(async (id, noteId, content) => saveConversationNote(id, noteId, content));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openFirst() {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('button', { name: /^First paper/ }));
  await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('First paper'));
  fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
}

function openSelection() {
  fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
}

async function openReadingBlock(): Promise<ReadingLocation> {
  await openFirst();
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Reading view' }));
  const location: ReadingLocation = {
    paper_id: first.paper_id, page_number: 6, page_position: [0.15, 0.7],
    zoom: 1.4, zoom_mode: 'custom', rotation: 0,
    reader_mode: 'reading', reading_block_id: 'page-6-figure-2',
  };
  act(() => lastReader.on_location_change(location));
  return location;
}

describe('assembled paper workspace', () => {
  it('shows metadata on opening, then hides controls until requested without replacing the reader', async () => {
    render(<WorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: /^First paper/ }));
    const sheet = await screen.findByRole('dialog', { name: 'First paper' });
    expect(sheet.textContent).toContain('Abstract');
    expect(sheet.textContent).toContain('Author');
    expect(sheet.textContent).toContain('1706.03762');
    const data = lastReader.pdf_data;
    expect(lastReader.controls_visible).toBe(false);
    expect(lastReader.reading_active).toBe(false);
    expect(lastReader.initial_fit_width).toBe(true);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('dialog', { name: 'Paper library' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read paper' }));
    expect(lastReader.reading_active).toBe(true);
    expect(screen.queryByRole('banner', { name: 'Reading controls' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(lastReader.controls_visible).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show paper information' }));
    expect(lastReader.pdf_data).toBe(data);
    expect(screen.getByRole('dialog', { name: 'First paper' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read paper' }));
    expect(lastReader.controls_visible).toBe(false);
  });

  it('keeps the library shortcut blocked as soon as an asynchronously loaded paper sheet appears', async () => {
    const { container } = render(<WorkspacePage />);
    const shortcut = vi.fn(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'k', ctrlKey: true, bubbles: true,
    })));
    // Mutation observers run after the DOM commit, without waiting for passive
    // effects. A keyboard event then must already respect the visible modal.
    const observer = new MutationObserver(() => {
      if (!container.querySelector('.paper-info-sheet')) return;
      observer.disconnect();
      shortcut();
    });
    observer.observe(container, { childList: true, subtree: true });
    try {
      fireEvent.click(await screen.findByRole('button', { name: /^First paper/ }));
      await screen.findByRole('dialog', { name: 'First paper' });
      await waitFor(() => expect(shortcut).toHaveBeenCalledOnce());
      expect(screen.queryByRole('dialog', { name: 'Paper library' })).toBeNull();
    } finally {
      observer.disconnect();
    }
  });

  it('changes native direction without changing PDF rotation and reports a refused request', async () => {
    vi.stubGlobal('innerWidth', 393);
    vi.stubGlobal('innerHeight', 852);
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true });
    vi.mocked(backend.setReaderOrientation).mockResolvedValueOnce('landscape');
    await openFirst();
    const location = lastReader.target_location;
    fireEvent.click(screen.getByRole('button', { name: 'Switch viewer to landscape' }));
    await screen.findByRole('button', { name: 'Switch viewer to portrait' });
    expect(backend.setReaderOrientation).toHaveBeenCalledWith('landscape');
    expect(lastReader.target_location).toBe(location);
    expect(lastReader.target_location?.rotation).toBe(0);
    vi.mocked(backend.setReaderOrientation).mockRejectedValueOnce(new Error('Rotation was denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Switch viewer to portrait' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Rotation was denied');
    expect(screen.getByRole('button', { name: 'Switch viewer to portrait' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
    expect(lastReader.controls_visible).toBe(false);
  });

  it('opens paper details as an overlay over the mounted reader on desktop', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('complementary', { name: 'References and annotations' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close references and notes panel' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the device direction when a keyboard makes a portrait viewport wider than it is tall', async () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 1180);
    const orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
    vi.stubGlobal('screen', { orientation });
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true });
    await openFirst();
    const location = lastReader.target_location;

    vi.stubGlobal('innerHeight', 500);
    fireEvent(window, new Event('resize'));
    expect(screen.getByRole('button', { name: 'Switch viewer to landscape' })).toBeTruthy();
    expect(lastReader.target_location).toBe(location);

    orientation.type = 'landscape-primary';
    act(() => orientation.dispatchEvent(new Event('change')));
    expect(screen.getByRole('button', { name: 'Switch viewer to portrait' })).toBeTruthy();
  });

  it('keeps mobile reading space available and retains a touch selection across panel changes', async () => {
    mockLayout(true);
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: /^First paper/ });
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open paper library' }));
    expect(screen.getByRole('dialog', { name: 'Paper library' }).getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^First paper/ }));
    await screen.findByTestId('reader');
    fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
    expect(screen.queryByRole('dialog', { name: 'Paper library' })).toBeNull();
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    expect(screen.getByText('Selected passage')).toBeTruthy();
    // iOS collapses its native range when the notes panel takes focus. The
    // captured PDF quads must remain available to save an annotation.
    act(() => lastReader.on_selection(null));
    expect(screen.getByText('Selected passage')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    fireEvent.change(screen.getByLabelText('Note for this selection'), { target: { value: 'A mobile note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('A mobile note');
    expect(vi.mocked(backend.saveAnnotation).mock.calls[0][0].target.page_anchors).toEqual(selection.page_anchors);
    fireEvent.click(screen.getByRole('button', { name: /Selected passage/ }));
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
  });

  it('keeps short touch screens compact at landscape widths and handles a larger viewport', async () => {
    vi.stubGlobal('innerWidth', 852);
    vi.stubGlobal('innerHeight', 393);
    let changeLayout!: (event: MediaQueryListEvent) => void;
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('(pointer: coarse)') && query.includes('(max-height: 500px)'),
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => { changeLayout = listener; },
      removeEventListener: vi.fn(),
    })));
    await openFirst();
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open paper library' }));
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true);

    act(() => changeLayout({ matches: false } as MediaQueryListEvent));
    expect(screen.queryByRole('dialog', { name: 'Paper library' })).toBeNull();
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();

    act(() => changeLayout({ matches: true } as MediaQueryListEvent));
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
    expect(screen.getByTestId('reader').textContent).toContain('First paper');
  });

  it('restores source position across internal and cross-paper links', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    expect(lastReader.target_location?.page_number).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('Second paper'));
    fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location?.page_number).toBe(12);
    expect(screen.queryByRole('dialog', { name: 'First paper' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toMatchObject({ page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90 });
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go forward to next reading location' }));
    expect(lastReader.target_location?.page_number).toBe(12);
  });

  it('restores Reading view blocks and original PDF positions with Back and Forward', async () => {
    const readingLocation = await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to original PDF' }));
    expect(lastReader.target_location).toMatchObject({
      reader_mode: 'pdf', reading_block_id: null,
      page_number: 6, page_position: readingLocation.page_position, zoom_mode: 'fit_width',
    });
    expect(backend.saveReadingPosition).toHaveBeenCalledWith(readingLocation);
    const originalLocation: ReadingLocation = {
      ...readingLocation, reader_mode: 'pdf', reading_block_id: null,
      page_position: [0.2, 0.8], zoom: 1.8, rotation: 90,
    };
    act(() => lastReader.on_location_change(originalLocation));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(readingLocation);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.getByRole('button', { name: 'Switch to original PDF' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go forward to next reading location' }));
    expect(lastReader.target_location).toEqual(originalLocation);
  });

  it('ignores delayed location reports from the previous reader mode', async () => {
    const readingLocation = await openReadingBlock();
    const stalePdfReport: ReadingLocation = {
      ...readingLocation, reader_mode: 'pdf', reading_block_id: null, page_number: 99,
    };
    act(() => lastReader.on_location_change(stalePdfReport));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to original PDF' }));
    expect(lastReader.target_location?.page_number).toBe(6);
    const target = lastReader.target_location;
    act(() => lastReader.on_location_change({ ...readingLocation, page_number: 98 }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.getByRole('button', { name: 'Switch to Reading view' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(readingLocation);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go forward to next reading location' }));
    expect(lastReader.target_location).toEqual(target);
  });

  it('returns to a Reading view block after following a citation to another paper', async () => {
    const readingLocation = await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location).toEqual(readingLocation);
    expect(screen.queryByRole('dialog', { name: 'First paper' })).toBeNull();
  });

  it('clears the old Reading view block when jumping to a saved annotation', async () => {
    const readingLocation = await openReadingBlock();
    openSelection();
    fireEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    fireEvent.change(screen.getByLabelText('Note for this selection'), { target: { value: 'A reading-view note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('A reading-view note');
    fireEvent.click(screen.getByRole('button', { name: /Selected passage/ }));
    expect(lastReader.target_location).toMatchObject({
      reader_mode: 'reading', reading_block_id: null, page_number: 4, page_position: [0, 0],
    });
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(readingLocation);
    expect(lastReader.target_anchor).toBeNull();
  });

  it('clears the old Reading view block when jumping to a bibliography page', async () => {
    const readingLocation = await openReadingBlock();
    act(() => lastReader.on_references([{
      reference_id: 'reference-12', citation_text: 'An interesting related paper',
      page_number: 12, arxiv_id: null, doi: null, url: null,
    }]));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to reference on page 12' }));
    expect(lastReader.target_location).toMatchObject({
      reader_mode: 'reading', reading_block_id: null, page_number: 12, page_position: [0, 0],
    });
    expect(lastReader.target_anchor).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(readingLocation);
  });

  it('keeps the current paper and history when a destination fails', async () => {
    await openFirst();
    vi.mocked(backend.getPdfBytes).mockRejectedValueOnce(new Error('Destination unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('reader').textContent).toContain('First paper');
    expect((screen.getByRole('button', { name: 'Go back to previous reading location' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reopens a cached paper at its latest passage after returning to another paper', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open paper library' }));
    fireEvent.click(screen.getByRole('button', { name: /^Second paper/ }));
    await screen.findByRole('dialog', { name: 'Second paper' });
    expect(lastReader.target_location).toMatchObject({
      paper_id: second.paper_id, page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90,
    });
    expect(lastReader.initial_fit_width).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Resume reading' }));
    expect(lastReader.reading_active).toBe(true);
    expect(lastReader.controls_visible).toBe(false);
  });

  it('keeps late AI answers unsaved and saves the edited note to the original passage after navigation', async () => {
    await openFirst();
    let resolveAnswer!: (answer: AiConversationResponse) => void;
    vi.mocked(backend.askAiConversation).mockReturnValue(new Promise((resolve) => { resolveAnswer = resolve; }));
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain this passage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledWith(expect.objectContaining({ source: expect.objectContaining({ paper_id: first.paper_id }), question: 'Explain this passage' })));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    await act(async () => resolveAnswer(completeConversation(vi.mocked(backend.askAiConversation).mock.calls[0][0])));
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
    expect(screen.queryByText('An explanation')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Read paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(await screen.findByText('An explanation')).toBeTruthy();
    act(() => lastReader.on_selection({ ...selection, selected_text: 'A different selection', page_anchors: [{ ...selection.page_anchors[0], page_number: 9 }] }));
    fireEvent.change(screen.getByLabelText('Suggested note'), { target: { value: 'My edited takeaway' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(backend.saveAiConversationNote).toHaveBeenCalled());
    const saved = lastReader.annotations[0];
    expect(saved.target).toMatchObject({ paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors });
    expect(saved.body).toMatchObject({ answer: 'An explanation', note_content: 'My edited takeaway' });
    expect(await screen.findByRole('button', { name: 'Saved' })).toBeTruthy();
    expect(backend.askAiConversation).toHaveBeenCalledTimes(1);
    expect(lastReader.annotations).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }));
    await waitFor(() => expect(lastReader.annotations).toHaveLength(0));
    expect(screen.getByRole('article', { name: 'AI conversation: Explain this passage' })).toBeTruthy();
  });

  it('reopens a conversation and generates a note only when requested, keeping the original passage', async () => {
    await openFirst();
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain this passage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByText('An explanation');
    fireEvent.change(screen.getByLabelText('Follow-up question'), { target: { value: 'What are the limitations?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(2));
    expect(vi.mocked(backend.askAiConversation).mock.calls[1][0]).toMatchObject({ question: 'What are the limitations?' });
    expect(vi.mocked(backend.askAiConversation).mock.calls[1][0].source).toBeUndefined();
    expect(backend.generateAiConversationNote).not.toHaveBeenCalled();
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
    await waitFor(() => expect([...conversations.values()][0].turns).toHaveLength(2));

    cleanup();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('tab', { name: /Notes/ }));
    expect(await screen.findByText('What are the limitations?')).toBeTruthy();
    expect(backend.askAiConversation).toHaveBeenCalledTimes(2);

    vi.mocked(backend.generateAiConversationNote).mockImplementation(async (_requestId, id) => {
      const previous = conversations.get(id)!;
      const updated = { ...previous, note_draft: { ...previous.note_draft!, note_id: 'generated-note', content: 'Combined takeaway and limitations', source_turn_count: 2 } };
      conversations.set(id, updated);
      return { conversation: updated, thinking: '' };
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate new note' }));
    await waitFor(() => expect((screen.getByLabelText('Suggested note') as HTMLTextAreaElement).value).toBe('Combined takeaway and limitations'));
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(lastReader.annotations).toHaveLength(1));
    expect(lastReader.annotations[0].target).toEqual({ paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors });
    expect(lastReader.annotations[0].body).toMatchObject({ note_content: 'Combined takeaway and limitations' });
    expect(backend.askAiConversation).toHaveBeenCalledTimes(2);
  });

  it('streams in the Notes panel without rendering the PDF again', async () => {
    let stream!: (event: AiStreamEvent) => void;
    vi.mocked(backend.onAiStream).mockImplementation(async (listener) => { stream = listener; return () => {}; });
    vi.mocked(backend.askAiConversation).mockReturnValue(new Promise(() => {}));
    await openFirst();
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    const renders = readerRenderCount;
    const requestId = vi.mocked(backend.askAiConversation).mock.calls[0][0].request_id;
    act(() => {
      stream({ request_id: requestId, kind: 'thinking_delta', text: 'Provider reasoning' });
      stream({ request_id: requestId, kind: 'answer_delta', text: 'Streaming answer' });
    });
    expect(await screen.findByText('Streaming answer')).toBeTruthy();
    expect(readerRenderCount).toBe(renders);
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss selected passage' }));
    expect(screen.getByText('Streaming answer')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(backend.cancelAiRequest).toHaveBeenCalledWith(requestId);
  });

  it.each([false, true])('reveals an AI response inside Notes without moving the reader (reduced motion: %s)', async (reducedMotion) => {
    vi.mocked(backend.askAiConversation).mockReturnValue(new Promise(() => {}));
    await openFirst();
    openSelection();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    vi.mocked(window.matchMedia).mockReturnValue({ matches: reducedMotion } as MediaQueryList);
    const windowScroll = vi.fn();
    vi.stubGlobal('scrollTo', windowScroll);
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));

    const panel = screen.getByRole('tabpanel', { name: /Notes/ });
    const draft = screen.getByRole('article', { name: 'AI conversation: Explain' });
    const shell = document.querySelector<HTMLElement>('.app-shell')!;
    const workbench = document.querySelector<HTMLElement>('.workbench')!;
    const reader = screen.getByTestId('reader');
    for (const element of [panel, shell, workbench, reader]) element.scrollTo = vi.fn();
    draft.scrollIntoView = vi.fn();
    panel.scrollTop = 120;
    Object.defineProperty(panel, 'clientTop', { value: 1 });
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 400, 280));
    vi.spyOn(draft, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 600, 400, 240));
    act(() => frames[0](0));

    expect(panel.scrollTo).toHaveBeenCalledWith({ top: 639, behavior: reducedMotion ? 'auto' : 'smooth' });
    expect(draft.scrollIntoView).not.toHaveBeenCalled();
    expect(windowScroll).not.toHaveBeenCalled();
    for (const element of [shell, workbench, reader]) {
      expect(element.scrollTo).not.toHaveBeenCalled();
      expect(element.scrollTop).toBe(0);
    }
  });

  it.each(['reopened panel', 'different paper'])('does not apply a stale AI reveal to a %s', async (destination) => {
    vi.mocked(backend.askAiConversation).mockReturnValue(new Promise(() => {}));
    await openFirst();
    openSelection();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    const oldPanel = screen.getByRole('tabpanel', { name: /Notes/ });
    oldPanel.scrollTo = vi.fn();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    if (destination === 'reopened panel') {
      fireEvent.click(screen.getByRole('button', { name: 'Close references and notes panel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));

    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
      await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    }
    const currentPanel = screen.queryByRole('tabpanel', { name: /Notes/ });
    if (currentPanel && currentPanel !== oldPanel) currentPanel.scrollTo = vi.fn();
    act(() => frames[0](0));
    expect(oldPanel.scrollTo).not.toHaveBeenCalled();
    if (currentPanel) expect(currentPanel.scrollTo).not.toHaveBeenCalled();
  });

  it('edits a legacy AI annotation as a note while preserving its original answer and provenance', async () => {
    const legacy: Annotation = {
      schema_version: 1, annotation_id: 'legacy-answer',
      target: { paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors },
      body: { kind: 'ai_answer', answer: 'Original detailed answer', question: 'Explain', provider_id: 'local', model_id: 'local-model', context_text: 'Original context' },
      created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
    };
    vi.mocked(backend.listAnnotations).mockResolvedValue([legacy]);
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('tab', { name: /Notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'My concise note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend.saveAnnotation).toHaveBeenCalled());
    expect(vi.mocked(backend.saveAnnotation).mock.calls[0][0].body).toEqual({ ...legacy.body, note_content: 'My concise note' });
    expect(await screen.findByText('My concise note')).toBeTruthy();
    expect(screen.getByText('Full answer').closest('details')?.textContent).toContain('Original detailed answer');
  });

  it('preserves a saved draft when a pending PDF load returns an older annotation snapshot', async () => {
    vi.mocked(backend.askAiConversation).mockImplementation(async (request) => completeConversation(request, 'Full answer', 'A takeaway'));
    await openFirst();
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByLabelText('Suggested note');
    let completeSave!: () => void;
    vi.mocked(backend.saveAiConversationNote).mockImplementationOnce((id, noteId, content) => new Promise((resolve) => { completeSave = () => resolve(saveConversationNote(id, noteId, content)); }));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    let completePdf!: (data: Uint8Array<ArrayBuffer>) => void;
    vi.mocked(backend.getPdfBytes).mockReturnValueOnce(new Promise((resolve) => { completePdf = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Open paper library' }));
    fireEvent.click(screen.getByRole('button', { name: /^First paper/ }));
    await act(async () => completeSave());
    expect(lastReader.annotations).toHaveLength(1);
    await act(async () => completePdf(new Uint8Array([1, 2, 3])));
    await screen.findByRole('dialog', { name: 'First paper' });
    expect(lastReader.annotations).toHaveLength(1);
    expect(lastReader.annotations[0].body).toMatchObject({ note_content: 'A takeaway' });
  });

  it('persists a note in our format and passes its anchor when revisiting it', async () => {
    await openFirst();
    openSelection();
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
