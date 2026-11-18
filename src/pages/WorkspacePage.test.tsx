// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConversation, AiConversationRequest, AiConversationResponse, AiStreamEvent, Annotation, OperationProgress, Paper, PaperPreview, PdfReaderProps, ReaderOrientation, ReadingLocation, ReferenceCandidate, ReferenceItem, SelectionContext } from '../lib/types';
import * as backend from '../lib/backend';
import { WorkspacePage } from './WorkspacePage';

vi.mock('../lib/backend', () => ({
  nativeAvailable: vi.fn(), listPapers: vi.fn(), getSettings: vi.fn(), onProgress: vi.fn(),
  previewArxivPaper: vi.fn(), downloadArxivPaper: vi.fn(), cancelPaperOperation: vi.fn(), markPaperOpened: vi.fn(), removePaper: vi.fn(), getPdfBytes: vi.fn(), listAnnotations: vi.fn(), saveReadingPosition: vi.fn(),
  askAiConversation: vi.fn(), listAiConversations: vi.fn(), generateAiConversationNote: vi.fn(), updateAiConversationNote: vi.fn(), saveAiConversationNote: vi.fn(),
  updateAiTurnNoteDraft: vi.fn(), saveAiTurnNote: vi.fn(),
  onAiStream: vi.fn(), cancelAiRequest: vi.fn(), saveAnnotation: vi.fn(), deleteAnnotation: vi.fn(), saveAnnotationFile: vi.fn(),
  resolveReference: vi.fn(), openExternal: vi.fn(), saveSettings: vi.fn(), listAiModels: vi.fn(),
  getReaderCapabilities: vi.fn(), setReaderOrientation: vi.fn(), setReaderAiMode: vi.fn(),
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
      <button disabled={!props.edge_navigation} onClick={() => props.on_edge_navigation?.()}>Complete edge gesture</button>
      <button onClick={() => props.on_location_change({ paper_id: props.paper.paper_id, page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90 })}>Scroll source</button>
      <button onClick={() => props.on_navigate({ kind: 'pdf', location: { paper_id: props.paper.paper_id, page_number: 12, page_position: [0, 0.2], zoom: 1, rotation: 0, reader_mode: props.target_location?.reader_mode } })}>Follow internal citation</button>
      <button onClick={() => props.on_navigate({ kind: 'app', arxiv_id: '1409.0473v3', url: 'https://arxiv.org/abs/1409.0473v3' })}>Follow cited paper</button>
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

const preview: PaperPreview = { preview_id: 'preview-second', metadata: second, library_paper: null };

function mockLayout(compact: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
    matches: compact && query.includes('(max-width: 760px)'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function mockPhone() {
  mockLayout(true);
  vi.stubGlobal('innerWidth', 852);
  vi.stubGlobal('innerHeight', 393);
  vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'phone' });
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
  vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: false, device_kind: 'desktop' });
  vi.mocked(backend.setReaderAiMode).mockImplementation(async (active) => active ? 'portrait' : 'landscape');
  vi.mocked(backend.listPapers).mockResolvedValue([first, second]);
  vi.mocked(backend.markPaperOpened).mockImplementation(async (id) => ({ ...([first, second].find((paper) => paper.paper_id === id) ?? first), last_opened_at: '2026-09-30T00:00:00Z' }));
  vi.mocked(backend.cancelPaperOperation).mockResolvedValue();
  vi.mocked(backend.removePaper).mockResolvedValue();
  vi.mocked(backend.openExternal).mockResolvedValue();
  vi.mocked(backend.previewArxivPaper).mockResolvedValue(preview);
  vi.mocked(backend.downloadArxivPaper).mockResolvedValue(second);
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
afterEach(async () => {
  cleanup();
  await act(async () => {});
  vi.unstubAllGlobals();
});

async function openFirst() {
  render(<WorkspacePage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open First paper' }));
  await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('First paper'));
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
  it('picks PDF passages for an unsent phone question and follow-up, preserving the reader location on cancel', async () => {
    mockPhone();
    const original = await openReadingBlock();
    openSelection();
    const input = await screen.findByLabelText('Question about this selection');
    fireEvent.change(input, { target: { value: 'Compare these passages' } });
    const extra = (page: number): SelectionContext => ({
      selected_text: `Additional passage on page ${page}`, context_text: `Nearby text on page ${page}`,
      page_anchors: [{ ...selection.page_anchors[0], page_number: page,
        text_quote: { ...selection.page_anchors[0].text_quote, exact_text: `Additional passage on page ${page}` } }],
    });
    const capture = (page: number, keep: boolean) => {
      fireEvent.click(screen.getByText('Add passage'));
      const openPicker = screen.queryByRole('button', { name: 'Select in paper' });
      if (openPicker) fireEvent.click(openPicker);
      expect(screen.getByRole('region', { name: 'Attach a passage' })).toBeTruthy();
      expect(lastReader.target_location?.reader_mode).toBe('pdf');
      act(() => lastReader.on_navigate({ kind: 'pdf', location: { ...original, reader_mode: 'pdf', page_number: page } }));
      act(() => lastReader.on_selection(extra(page)));
      fireEvent.click(screen.getByRole('button', { name: keep ? 'Attach passage' : 'Cancel' }));
      expect(lastReader.target_location).toEqual(original);
    };
    capture(8, true);
    capture(9, false);
    capture(10, true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment: Additional passage on page 10' }));
    expect((screen.getByLabelText('Question about this selection') as HTMLTextAreaElement).value).toBe('Compare these passages');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(1));
    const firstRequest = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    expect(firstRequest.source?.page_anchors).toEqual(selection.page_anchors);
    expect(firstRequest.attachments).toEqual([{ ...extra(8), paper_id: first.paper_id, pdf_hash: first.pdf_hash }]);
    fireEvent.change(await screen.findByLabelText('Follow-up question'), { target: { value: 'How about page 12?' } });
    capture(12, true);
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(2));
    const follow = vi.mocked(backend.askAiConversation).mock.calls[1][0];
    expect(follow.conversation_id).toBe(firstRequest.conversation_id);
    expect(follow.question).toBe('How about page 12?');
    expect(follow.attachments?.map(p => p.page_anchors[0].page_number)).toEqual([12]);
  });
  it('asks about a whole paper, inspects the cited PDF passage, and pins an edited note with its source', async () => {
    mockPhone();
    const anchor = { ...selection.page_anchors[0], page_number: 8 };
    const citation = { citation_id: 'S1', anchor };
    vi.mocked(backend.askAiConversation).mockImplementation(async request => {
      const response = completeConversation(request, 'The derivation is in the appendix [S1].');
      response.conversation.turns.at(-1)!.citations = [citation];
      response.conversation.note_draft = null;
      return response;
    });
    vi.mocked(backend.updateAiTurnNoteDraft).mockImplementation(async (id, turnId, content, target) => {
      const conversation = conversations.get(id)!;
      conversation.turns.find(t => t.turn_id === turnId)!.note = { content, target, saved_annotation_id: null };
      return conversation;
    });
    vi.mocked(backend.saveAiTurnNote).mockImplementation(async (id, turnId, content, target) => {
      const conversation = conversations.get(id)!;
      conversation.turns.find(t => t.turn_id === turnId)!.note = { content, target, saved_annotation_id: 'pinned' };
      const annotation: Annotation = { schema_version: 1, annotation_id: 'pinned', target, created_at: first.downloaded_at, updated_at: first.downloaded_at,
        body: { kind: 'note', content, citations: [citation], origin: { conversation_id: id, turn_id: turnId } } };
      vi.mocked(backend.listAnnotations).mockResolvedValue([annotation]);
      return { conversation, annotation };
    });
    const original = await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Ask about paper' }));
    fireEvent.change(await screen.findByLabelText('Question about this paper'), { target: { value: 'Where is the derivation?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Read S1, page 8' }));
    expect(vi.mocked(backend.askAiConversation).mock.calls[0][0].source).toMatchObject({ selected_text: '', page_anchors: [], pdf_hash: first.pdf_hash });
    expect(lastReader.target_location).toMatchObject({ page_number: 8, reader_mode: 'pdf' });
    expect(lastReader.cited_anchor).toEqual(anchor);
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this' }));
    expect(lastReader.target_location).toEqual(original);
    fireEvent.change(screen.getByLabelText('Follow-up question'), { target: { value: 'Explain that line.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask follow-up' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(2));
    expect(vi.mocked(backend.askAiConversation).mock.calls[1][0].attachments?.[0].page_anchors).toEqual([anchor]);
    fireEvent.click(await screen.findByRole('button', { name: 'Save as note' }));
    fireEvent.change(screen.getByLabelText('Your note'), { target: { value: 'My edited takeaway' } });
    await waitFor(() => expect(backend.updateAiTurnNoteDraft).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Read source S1 on page 8' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to note draft' }));
    expect((screen.getByLabelText('Your note') as HTMLTextAreaElement).value).toBe('My edited takeaway');
    const whole = screen.getByRole('option', { name: 'Whole paper' }) as HTMLOptionElement;
    fireEvent.change(screen.getByLabelText('Pin to'), { target: { value: whole.value } });
    fireEvent.click(screen.getByRole('button', { name: 'Pin note' }));
    await waitFor(() => expect(lastReader.annotations).toHaveLength(1));
    expect(lastReader.annotations[0].target.scope).toBe('paper');
    expect(lastReader.annotations[0].body).toMatchObject({ content: 'My edited takeaway', citations: [citation] });

    cleanup();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Expand note: My edited takeaway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Read source S1 on page 8' }));
    expect(lastReader.cited_anchor).toEqual(anchor);
    fireEvent.click(screen.getByRole('button', { name: 'Back to saved note' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(await screen.findByRole('heading', { name: 'Explain that line.' })).toBeTruthy();
  });
  it('starts in the library and resumes cached papers directly with metadata available on demand', async () => {
    render(<WorkspacePage />);
    expect(await screen.findByRole('region', { name: 'Paper library' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent papers' })).toBeTruthy();
    expect(screen.getByLabelText('arXiv ID or link')).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(backend.getPdfBytes).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open First paper' }));
    await screen.findByTestId('reader');
    expect(screen.queryByRole('dialog')).toBeNull();
    const data = lastReader.pdf_data;
    expect(lastReader.controls_visible).toBe(false);
    expect(lastReader.reading_active).toBe(true);
    expect(lastReader.initial_fit_width).toBe(true);
    expect(backend.markPaperOpened).toHaveBeenCalledWith(first.paper_id);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show paper information' }));
    const sheet = screen.getByRole('dialog', { name: 'First paper' });
    expect(sheet.textContent).toContain('Abstract');
    expect(sheet.textContent).toContain('Author');
    expect(sheet.textContent).toContain('1706.03762');
    expect(lastReader.pdf_data).toBe(data);
    expect(lastReader.reading_active).toBe(false);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(screen.queryByRole('region', { name: 'Paper library' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Read paper' }));
    expect(lastReader.reading_active).toBe(true);
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
      fireEvent.click(await screen.findByRole('button', { name: 'Open First paper' }));
      await screen.findByTestId('reader');
      fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
      fireEvent.click(screen.getByRole('button', { name: 'Show paper information' }));
      await screen.findByRole('dialog', { name: 'First paper' });
      await waitFor(() => expect(shortcut).toHaveBeenCalledOnce());
      expect(screen.queryByRole('region', { name: 'Paper library' })).toBeNull();
    } finally {
      observer.disconnect();
    }
  });

  it('changes native direction without changing PDF rotation and reports a refused request', async () => {
    vi.stubGlobal('innerWidth', 393);
    vi.stubGlobal('innerHeight', 852);
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'phone' });
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

  it('opens a docked sidebar and keeps the desktop reader interactive', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('complementary', { name: 'References and annotations' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close references and notes panel' }).getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.desktop-inspector-open')).toBeTruthy();
    expect(screen.getByTestId('reader').closest('[inert]')).toBeNull();
    expect(lastReader.reading_active).toBe(true);
    expect(lastReader.inline_notes).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.queryByRole('banner', { name: 'Reading controls' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'References and annotations' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    expect(lastReader.reading_active).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close notes sidebar' }));
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
  });

  it('keeps the device direction when a keyboard makes a portrait viewport wider than it is tall', async () => {
    vi.stubGlobal('innerWidth', 820);
    vi.stubGlobal('innerHeight', 1180);
    const orientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
    vi.stubGlobal('screen', { orientation });
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'tablet' });
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

  it('awaits confirmed phone portrait before opening full-screen AI and retains an unsent question across Back', async () => {
    mockPhone();
    const enter = deferred<ReaderOrientation>();
    const restore = deferred<ReaderOrientation>();
    vi.mocked(backend.setReaderAiMode).mockReturnValueOnce(enter.promise).mockReturnValueOnce(restore.promise);
    await openFirst();
    const reader = screen.getByTestId('reader');
    const pdfData = lastReader.pdf_data;
    const location = lastReader.target_location;
    const edgeClose = lastReader.on_edge_navigation;
    expect(lastReader.edge_navigation).toBe('close');
    openSelection();
    await waitFor(() => expect(backend.setReaderAiMode).toHaveBeenCalledWith(true));
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Question about this selection' })).toBeNull();
    expect(screen.getByText('Changing viewing direction…')).toBeTruthy();
    expect(reader.closest('.pdf-reader-mount')?.hasAttribute('inert')).toBe(true);
    expect(lastReader.edge_navigation).toBeNull();
    act(() => edgeClose?.());
    expect(screen.getByTestId('reader')).toBe(reader);

    await act(async () => enter.resolve('portrait'));
    const dialog = await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(dialog.classList.contains('phone-ai-screen')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByTestId('reader')).toBe(reader);
    expect(lastReader.pdf_data).toBe(pdfData);
    expect(lastReader.target_location).toBe(location);
    expect(lastReader.edge_navigation).toBeNull();
    expect(screen.queryByRole('banner', { name: 'Reading controls' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export annotations as JSON' })).toBeNull();
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Back to paper' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Question about this selection' }), { target: { value: 'Keep my unfinished question' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to paper' }));
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(screen.getByTestId('reader')).toBe(reader);
    await waitFor(() => expect(backend.setReaderAiMode).toHaveBeenCalledWith(false));
    expect(screen.getByText('Changing viewing direction…')).toBeTruthy();
    expect(lastReader.edge_navigation).toBeNull();
    await act(async () => restore.resolve('landscape'));
    expect(screen.queryByText('Changing viewing direction…')).toBeNull();
    expect(reader.closest('.pdf-reader-mount')?.hasAttribute('inert')).toBe(false);
    expect(lastReader.edge_navigation).toBe('close');
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    await screen.findByRole('dialog', { name: 'Ask AI' });
    expect((screen.getByRole('textbox', { name: 'Question about this selection' }) as HTMLTextAreaElement).value).toBe('Keep my unfinished question');
    expect(backend.askAiConversation).not.toHaveBeenCalled();
  });

  it('continues phone AI in the background and preserves follow-up drafts when reopening a conversation', async () => {
    mockPhone();
    const answer = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(answer.promise);
    await openFirst();
    openSelection();
    await screen.findByRole('dialog', { name: 'Ask AI' });
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain this passage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalledTimes(1));
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Back to paper' }));
    await waitFor(() => expect(screen.queryByText('Changing viewing direction…')).toBeNull());
    expect(backend.cancelAiRequest).not.toHaveBeenCalled();
    await act(async () => answer.resolve(completeConversation(request)));
    expect(screen.queryByText('An explanation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    const preview = await screen.findByRole('button', { name: /Explain this passage.*Open conversation/ });
    expect(screen.queryByRole('textbox', { name: 'Follow-up question' })).toBeNull();
    fireEvent.click(preview);
    await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(screen.getByText('An explanation')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Follow-up question' }), { target: { value: 'What about the limitations?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to paper' }));
    await waitFor(() => expect(screen.queryByText('Changing viewing direction…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    await screen.findByRole('dialog', { name: 'Ask AI' });
    expect((screen.getByRole('textbox', { name: 'Follow-up question' }) as HTMLTextAreaElement).value).toBe('What about the limitations?');
    expect(backend.askAiConversation).toHaveBeenCalledTimes(1);
    expect(backend.cancelAiRequest).not.toHaveBeenCalled();
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
  });

  it('keeps phone AI closed when portrait is refused and permits retry with the same passage', async () => {
    mockPhone();
    vi.mocked(backend.setReaderAiMode).mockRejectedValueOnce(new Error('Rotation was denied'));
    await openFirst();
    openSelection();
    expect((await screen.findByRole('alert')).textContent).toContain('Rotation was denied');
    await waitFor(() => expect(screen.queryByText('Changing viewing direction…')).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Question about this selection' })).toBeNull();
    expect(backend.askAiConversation).not.toHaveBeenCalled();
    expect(vi.mocked(backend.setReaderAiMode).mock.calls).toEqual([[true], [false]]);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(within(dialog).getByText('Selected passage')).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Question about this selection' })).toBeTruthy();
    expect(vi.mocked(backend.setReaderAiMode).mock.calls).toEqual([[true], [false], [true]]);
  });

  it('uses the regular AI panel on a narrow tablet without requesting phone portrait mode', async () => {
    mockLayout(true);
    vi.stubGlobal('innerWidth', 640);
    vi.stubGlobal('innerHeight', 900);
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'tablet' });
    vi.mocked(backend.setReaderOrientation).mockResolvedValue('landscape');
    await openFirst();
    openSelection();
    const panel = screen.getByRole('complementary', { name: 'References and annotations' });
    expect(panel.classList.contains('phone-ai-screen')).toBe(false);
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Question about this selection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch viewer to landscape' }));
    await waitFor(() => expect(backend.setReaderOrientation).toHaveBeenCalledWith('landscape'));
    expect(screen.getByRole('complementary', { name: 'References and annotations' })).toBe(panel);
    expect(backend.setReaderAiMode).not.toHaveBeenCalled();
  });

  it('keeps manual phone notes in the regular panel and opens conversation previews in portrait AI', async () => {
    mockPhone();
    completeConversation({ request_id: 'previous-turn', conversation_id: 'previous-conversation', question: 'Earlier question', source: { ...selection, paper_id: first.paper_id, pdf_hash: first.pdf_hash } });
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('complementary', { name: 'References and annotations' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Question about this selection' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Follow-up question' })).toBeNull();
    expect(screen.queryByText('An explanation')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Note for this selection' }), { target: { value: 'A manual phone note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await screen.findByText('A manual phone note');
    expect(lastReader.annotations[0].target.page_anchors).toEqual(selection.page_anchors);
    expect(screen.getByRole('button', { name: 'Export annotations as JSON' })).toBeTruthy();
    expect(backend.setReaderAiMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Earlier question.*Open conversation/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(within(dialog).getByText('An explanation')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Note for this selection' })).toBeNull();
    expect(screen.queryByText('A manual phone note')).toBeNull();
    expect(backend.setReaderAiMode).toHaveBeenCalledWith(true);
    expect(backend.askAiConversation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /Collapse conversation/ }));
    const collapsedHeading = within(dialog).getByRole('button', { name: /Expand conversation/ });
    const back = within(dialog).getByRole('button', { name: 'Back to paper' });
    back.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(collapsedHeading);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(back);
  });

  it('withholds AI inputs while native device detection fails and retries before opening phone AI', async () => {
    mockLayout(true);
    vi.mocked(backend.getReaderCapabilities).mockRejectedValueOnce(new Error('Device detection unavailable'));
    completeConversation({ request_id: 'previous-turn', conversation_id: 'previous-conversation', question: 'Earlier question', source: { ...selection, paper_id: first.paper_id, pdf_hash: first.pdf_hash } });
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Select passage' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('textbox', { name: 'Note for this selection' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Question about this selection' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Follow-up question' })).toBeNull();
    expect(screen.queryByRole('article', { name: /AI conversation/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Earlier question.*Open conversation/ })).toBeTruthy();
    vi.mocked(backend.getReaderCapabilities).mockRejectedValueOnce(new Error('Detection retry failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Detection retry failed');
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Question about this selection' })).toBeNull();
    expect(backend.setReaderAiMode).not.toHaveBeenCalled();
    expect(backend.askAiConversation).not.toHaveBeenCalled();
    vi.mocked(backend.getReaderCapabilities).mockResolvedValueOnce({ supports_orientation: true, device_kind: 'phone' });
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI' }));
    await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(backend.getReaderCapabilities).toHaveBeenCalledTimes(3);
    expect(backend.setReaderAiMode).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole('textbox', { name: 'Question about this selection' })).toBeTruthy();
    expect(backend.askAiConversation).not.toHaveBeenCalled();
  });

  it('keeps compact tablet reading space available and retains a touch selection across panel changes', async () => {
    mockLayout(true);
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'tablet' });
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open First paper' }));
    await screen.findByTestId('reader');
    expect(screen.queryByRole('region', { name: 'Paper library' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
  });

  it('keeps the active phone reader mounted when the viewport grows or becomes landscape', async () => {
    mockPhone();
    await openFirst();
    const reader = screen.getByTestId('reader');
    expect(screen.queryByRole('navigation', { name: 'Open papers' })).toBeNull();
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('region', { name: 'Paper library' })).toBeNull();
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('reader')).toBe(reader);
    expect(screen.queryByRole('navigation', { name: 'Open papers' })).toBeNull();
    vi.stubGlobal('innerWidth', 393);
    vi.stubGlobal('innerHeight', 852);
    fireEvent(window, new Event('resize'));
    expect(screen.getByTestId('reader')).toBe(reader);
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
  });

  it('restores source position across internal and cross-paper links', async () => {
    mockPhone();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    expect(lastReader.target_location?.page_number).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(screen.getByTestId('reader').textContent).toContain('Second paper'));
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
    mockPhone();
    const readingLocation = await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location?.reader_mode).toBe('reading');
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
    fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
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
      label: '12', title: null, authors: [], publication_year: null, venue: null, source_rect: null, parse_confidence: 'raw',
      page_number: 12, arxiv_id: null, doi: null, url: null,
    }]));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'View bibliography on page 12' }));
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
    mockPhone();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
      fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));

    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open paper library' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Second paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location).toMatchObject({
      paper_id: second.paper_id, page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90,
    });
    expect(lastReader.initial_fit_width).toBe(false);
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
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    await act(async () => resolveAnswer(completeConversation(vi.mocked(backend.askAiConversation).mock.calls[0][0])));
    expect(backend.saveAnnotation).not.toHaveBeenCalled();
    expect(screen.queryByText('An explanation')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to source paper: First paper' }));
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
    fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
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
      await screen.findByTestId('reader');
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
    fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit note'), { target: { value: 'My concise note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(backend.saveAnnotation).toHaveBeenCalled());
    expect(vi.mocked(backend.saveAnnotation).mock.calls[0][0].body).toEqual({ ...legacy.body, note_content: 'My concise note' });
    expect(await screen.findByRole('button', { name: 'Collapse note: My concise note' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Full answer' }));
    expect(screen.getByText('Original detailed answer')).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Open First paper' }));
    await act(async () => completeSave());
    expect(screen.queryByTestId('reader')).toBeNull();
    await act(async () => completePdf(new Uint8Array([1, 2, 3])));
    await screen.findByTestId('reader');
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
    fireEvent.click(screen.getByRole('button', { name: /^Expand note:/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
  });
});

async function findNewPaper() {
  fireEvent.change(screen.getByLabelText('arXiv ID or link'), { target: { value: '1409.0473v3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
  return screen.findByRole('dialog', { name: 'Second paper' });
}

async function showRemoveConfirmation(title = 'First paper') {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${title}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
  return screen.findByRole('dialog', { name: 'Remove paper?' });
}

describe('library, previews, and open papers', () => {
  it('previews metadata with exactly Download and Cancel, preserving the input on Cancel', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    const dialog = await findNewPaper();
    expect(within(dialog).getByRole('heading', { name: 'Abstract' })).toBeTruthy();
    expect(within(dialog).getByText('Author')).toBeTruthy();
    expect(within(dialog).getByText('1409.0473')).toBeTruthy();
    expect(within(dialog).getByText('v3')).toBeTruthy();
    expect(within(dialog).getAllByRole('button').map((button) => button.textContent?.trim())).toEqual(['Cancel', 'Download & add to library']);
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    expect(backend.getPdfBytes).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('arXiv ID or link') as HTMLInputElement).value).toBe('1409.0473v3');
    expect(screen.queryByRole('button', { name: 'Open Second paper' })).toBeNull();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
  });

  it('downloads only after confirmation and retries a failed PDF without repeating metadata lookup', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    vi.mocked(backend.downloadArxivPaper).mockRejectedValueOnce(new Error('PDF download interrupted'));
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    const dialog = await findNewPaper();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download & add to library' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('PDF download interrupted');
    expect(screen.queryByTestId('reader')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download & add to library' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(backend.downloadArxivPaper).toHaveBeenCalledTimes(2);
    expect(backend.downloadArxivPaper).toHaveBeenLastCalledWith(preview.preview_id, expect.any(String));
    expect(backend.previewArxivPaper).toHaveBeenCalledExactlyOnceWith('1409.0473v3', expect.any(String));
    expect(backend.getPdfBytes).toHaveBeenCalledExactlyOnceWith(second.paper_id);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lastReader.reading_active).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    expect(screen.getByRole('button', { name: 'Open Second paper' })).toBeTruthy();
  });

  it('shows arXiv cooldown progress, cancels metadata lookup, and ignores its late result and progress', async () => {
    const lookup = deferred<PaperPreview>();
    let progress!: (event: OperationProgress) => void;
    vi.mocked(backend.previewArxivPaper).mockReturnValueOnce(lookup.promise);
    vi.mocked(backend.onProgress).mockImplementation(async (listener) => { progress = listener; return () => {}; });
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    fireEvent.change(screen.getByLabelText('arXiv ID or link'), { target: { value: '1409.0473v3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
    const requestId = vi.mocked(backend.previewArxivPaper).mock.calls[0][1];
    const waiting: OperationProgress = { request_id: requestId, phase: 'waiting', message: 'Waiting for arXiv. Retrying in 30 seconds.', received_bytes: 0, total_bytes: null, retry_at: '2026-09-30T00:00:30Z' };
    act(() => progress(waiting));
    expect(screen.getByRole('status').textContent).toContain('Waiting for arXiv');
    expect((screen.getByLabelText('arXiv ID or link') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(backend.cancelPaperOperation).toHaveBeenCalledExactlyOnceWith(requestId);
    expect((screen.getByLabelText('arXiv ID or link') as HTMLInputElement).value).toBe('1409.0473v3');
    expect((screen.getByLabelText('arXiv ID or link') as HTMLInputElement).disabled).toBe(false);
    act(() => progress(waiting));
    await act(async () => lookup.resolve(preview));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(/Waiting for arXiv/)).toBeNull();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
    await screen.findByRole('dialog', { name: 'Second paper' });
    expect(backend.previewArxivPaper).toHaveBeenCalledTimes(2);
  });

  it('keeps a canceled download closed when the backend reports completion after Cancel', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    const download = deferred<Paper>();
    vi.mocked(backend.downloadArxivPaper).mockReturnValueOnce(download.promise);
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    const dialog = await findNewPaper();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download & add to library' }));
    const requestId = vi.mocked(backend.downloadArxivPaper).mock.calls[0][1];
    expect((within(dialog).getByRole('button', { name: 'Download & add to library' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(backend.cancelPaperOperation).toHaveBeenCalledWith(requestId);
    vi.mocked(backend.listPapers).mockResolvedValue([first, second]);
    await act(async () => download.resolve(second));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(backend.getPdfBytes).not.toHaveBeenCalled();
    // The backend's atomic save may have won the race with Cancel. Keep that
    // successfully saved paper reachable without unexpectedly opening it.
    expect(screen.getByRole('button', { name: 'Open Second paper' })).toBeTruthy();
    expect((screen.getByLabelText('arXiv ID or link') as HTMLInputElement).value).toBe('1409.0473v3');
  });

  it('opens an already downloaded lookup result without requesting the PDF from arXiv again', async () => {
    vi.mocked(backend.previewArxivPaper).mockResolvedValue({ ...preview, library_paper: second });
    render(<WorkspacePage />);
    await screen.findByRole('button', { name: 'Open First paper' });
    fireEvent.change(screen.getByLabelText('arXiv ID or link'), { target: { value: '1409.0473v3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    expect(backend.getPdfBytes).toHaveBeenCalledWith(second.paper_id);
  });

  it('previews an unsaved reference over the source reader and returns to the same passage on Cancel', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    const location = lastReader.target_location;
    const reader = screen.getByTestId('reader');
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Second paper' });
    expect(screen.getByTestId('reader')).toBe(reader);
    expect(lastReader.reading_active).toBe(false);
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('reader')).toBe(reader);
    expect(lastReader.reading_active).toBe(true);
    expect(lastReader.target_location).toEqual(location);
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
  });

  it('closes the single iPhone reader to home, keeps its paper, and resumes its saved position', async () => {
    mockPhone();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close paper' }));
    expect(screen.getByRole('region', { name: 'Paper library' })).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Open papers' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open First paper' })).toBeTruthy();
    expect(backend.removePaper).not.toHaveBeenCalled();
    expect(backend.saveReadingPosition).toHaveBeenCalledWith(expect.objectContaining({ paper_id: first.paper_id, page_number: 4 }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Second paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(screen.getAllByTestId('reader')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect((screen.getByRole('button', { name: 'Go back to previous reading location' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open First paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location).toMatchObject({ page_number: 4, page_position: [0.1, 0.6], zoom: 1.5 });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the phone edge gesture for Back before Close and restores mode, zoom, and position', async () => {
    mockPhone();
    const readingLocation = await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    expect(lastReader.edge_navigation).toBe('back');
    fireEvent.click(screen.getByRole('button', { name: 'Complete edge gesture' }));
    expect(lastReader.target_location).toEqual(readingLocation);
    expect(lastReader.edge_navigation).toBe('back');
    const staleBack = lastReader.on_edge_navigation;
    fireEvent.click(screen.getByRole('button', { name: 'Complete edge gesture' }));
    expect(lastReader.target_location?.reader_mode ?? 'pdf').toBe('pdf');
    expect(lastReader.edge_navigation).toBe('close');
    act(() => staleBack?.());
    expect(screen.getByTestId('reader')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete edge gesture' }));
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open First paper' })).toBeTruthy();
    expect(backend.removePaper).not.toHaveBeenCalled();
    expect(backend.saveReadingPosition).toHaveBeenCalledWith(readingLocation);
  });

  it('keeps a failed phone edge Back retryable and rejects duplicate or stale cross-paper gestures', async () => {
    mockPhone();
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    const source = { paper_id: first.paper_id, page_number: 4, page_position: [0.1, 0.6], zoom: 1.5, rotation: 90 };
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    const failedLoad = deferred<Awaited<ReturnType<typeof backend.getPdfBytes>>>();
    vi.mocked(backend.getPdfBytes).mockReturnValueOnce(failedLoad.promise);
    const back = lastReader.on_edge_navigation;
    act(() => { back?.(); back?.(); });
    expect(backend.getPdfBytes).toHaveBeenCalledTimes(3);
    expect(lastReader.edge_navigation).toBeNull();
    await act(async () => failedLoad.reject(new Error('Cached source unavailable')));
    expect((await screen.findByRole('alert')).textContent).toContain('Cached source unavailable');
    expect(lastReader.paper.paper_id).toBe(second.paper_id);
    expect(lastReader.edge_navigation).toBe('back');
    const staleSecond = lastReader.on_edge_navigation;
    fireEvent.click(screen.getByRole('button', { name: 'Complete edge gesture' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location).toMatchObject(source);
    expect(lastReader.edge_navigation).toBe('close');
    act(() => staleSecond?.());
    expect(screen.getByTestId('reader').textContent).toContain('First paper');
    expect(backend.previewArxivPaper).not.toHaveBeenCalled();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    expect(backend.removePaper).not.toHaveBeenCalled();
  });

  it('closes only the current iPad tab and ignores a gesture started on the previous paper', async () => {
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind: 'tablet' });
    await openFirst();
    const staleFirst = lastReader.on_edge_navigation;
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.edge_navigation).toBe('close');
    act(() => staleFirst?.());
    expect(lastReader.paper.paper_id).toBe(second.paper_id);
    const tabs = screen.getByRole('navigation', { name: 'Open papers' });
    expect(within(tabs).getByRole('button', { name: 'First paper' })).toBeTruthy();
    expect(within(tabs).getByRole('button', { name: 'Second paper' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Complete edge gesture' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(within(tabs).queryByRole('button', { name: 'Second paper' })).toBeNull();
    expect(within(tabs).getByRole('button', { name: 'First paper' })).toBeTruthy();
    expect(backend.removePaper).not.toHaveBeenCalled();
  });

  it.each(['desktop', 'unknown'] as const)('disables edge navigation for the %s device kind', async (device_kind) => {
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: false, device_kind });
    await openFirst();
    expect(lastReader.edge_navigation).toBeNull();
    act(() => lastReader.on_edge_navigation?.());
    expect(screen.getByTestId('reader')).toBeTruthy();
  });

  it.each(['Show paper information', 'AI provider settings', 'Open references and notes panel'])(
    'cancels a phone edge gesture when %s opens', async (button_name) => {
      mockPhone();
      await openFirst();
      const staleClose = lastReader.on_edge_navigation;
      fireEvent.click(screen.getByRole('button', { name: button_name }));
      expect(lastReader.edge_navigation).toBeNull();
      act(() => staleClose?.());
      expect(screen.getByTestId('reader')).toBeTruthy();
    },
  );

  it('blocks an edge gesture during orientation changes and inline note editing', async () => {
    mockPhone();
    const rotation = deferred<ReaderOrientation>();
    vi.mocked(backend.setReaderOrientation).mockReturnValueOnce(rotation.promise);
    await openFirst();
    const staleClose = lastReader.on_edge_navigation;
    fireEvent.click(screen.getByRole('button', { name: 'Switch viewer to portrait' }));
    expect(lastReader.edge_navigation).toBeNull();
    act(() => staleClose?.());
    expect(screen.getByTestId('reader')).toBeTruthy();
    await act(async () => rotation.resolve('portrait'));
    expect(lastReader.edge_navigation).toBe('close');
    const note: Annotation = {
      schema_version: 1, annotation_id: 'editing-note',
      target: { paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors },
      body: { kind: 'note', content: 'Keep this draft' },
      created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z',
    };
    act(() => lastReader.on_edit_annotation?.(note, 'Editing beside the paper'));
    expect(lastReader.edge_navigation).toBeNull();
    act(() => staleClose?.());
    expect(lastReader.annotation_edit?.content).toBe('Editing beside the paper');
    act(() => lastReader.on_edit_annotation?.(note, null));
    expect(lastReader.edge_navigation).toBe('close');
  });

  it.each(['desktop', 'tablet'] as const)('keeps distinct tabs, histories, and draft questions on %s', async (deviceKind) => {
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: deviceKind === 'tablet', device_kind: deviceKind });
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Draft for first paper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    const tabs = screen.getByRole('navigation', { name: 'Open papers' });
    expect(within(tabs).getAllByRole('button', { name: 'First paper' })).toHaveLength(1);
    expect(within(tabs).getAllByRole('button', { name: 'Second paper' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect((screen.getByRole('button', { name: 'Go back to previous reading location' }) as HTMLButtonElement).disabled).toBe(true);
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Draft for second paper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to source paper: First paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location?.page_number).toBe(12);
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    expect((screen.getByLabelText('Question about this selection') as HTMLTextAreaElement).value).toBe('Draft for first paper');
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location?.page_number).toBe(4);
    fireEvent.click(within(tabs).getByRole('button', { name: 'Second paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI or add a note to this passage' }));
    expect((screen.getByLabelText('Question about this selection') as HTMLTextAreaElement).value).toBe('Draft for second paper');
    expect(within(tabs).getAllByRole('button', { name: 'First paper' })).toHaveLength(1);
    fireEvent.click(within(tabs).getByRole('button', { name: 'Close Second paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    expect(lastReader.target_location?.page_number).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Close First paper' }));
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Open papers' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Paper library' })).toBeTruthy();
    expect(backend.removePaper).not.toHaveBeenCalled();
  });

  it.each(['desktop', 'tablet'] as const)('updates an existing paper tab to return to its latest citation source on %s', async (deviceKind) => {
    const third: Paper = { ...first, paper_id: '2005.14165v4', arxiv_id: '2005.14165', arxiv_version: 4, title: 'Third paper', pdf_hash: 'c'.repeat(64) };
    const papers = [first, second, third];
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: deviceKind === 'tablet', device_kind: deviceKind });
    vi.mocked(backend.listPapers).mockResolvedValue(papers);
    vi.mocked(backend.markPaperOpened).mockImplementation(async (id) => ({ ...papers.find((paper) => paper.paper_id === id)!, last_opened_at: '2026-09-30T00:00:00Z' }));
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.getByRole('button', { name: 'Back to source paper: First paper' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll source' }));

    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Third paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(third.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Follow internal citation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location?.page_number).toBe(4);
    const tabs = screen.getByRole('navigation', { name: 'Open papers' });
    expect(within(tabs).getAllByRole('button', { name: 'Second paper' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.queryByRole('button', { name: 'Back to source paper: First paper' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to source paper: Third paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(third.paper_id));
    expect(lastReader.target_location?.page_number).toBe(12);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(backend.previewArxivPaper).not.toHaveBeenCalled();
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
  });

  it('requires confirmation before removal and retains the paper and tab when removal fails', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    let dialog = await showRemoveConfirmation();
    expect(dialog.textContent).toContain('notes, and its AI conversations from your library');
    expect(backend.removePaper).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Open First paper' })).toBeTruthy();
    expect(backend.removePaper).not.toHaveBeenCalled();
    vi.mocked(backend.removePaper).mockRejectedValueOnce(new Error('Could not remove the cached PDF'));
    dialog = await showRemoveConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove paper' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Could not remove the cached PDF');
    expect(backend.removePaper).toHaveBeenCalledExactlyOnceWith(first.paper_id);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Open First paper' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Open papers' })).getByRole('button', { name: 'First paper' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open First paper' }));
    await screen.findByTestId('reader');
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
  });

  it('removes saved papers and their tabs, prunes reference sources, and keeps remaining tabs usable', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    const dialog = await showRemoveConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove paper' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Open First paper' })).toBeNull();
    const tabs = screen.getByRole('navigation', { name: 'Open papers' });
    expect(within(tabs).queryByRole('button', { name: 'First paper' })).toBeNull();
    fireEvent.click(within(tabs).getByRole('button', { name: 'Second paper' }));
    await screen.findByTestId('reader');
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    expect(screen.queryByRole('button', { name: 'Back to source paper: First paper' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Go back to previous reading location' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('cancels deleted papers AI work and ignores a late answer when that paper is downloaded again', async () => {
    const answer = deferred<AiConversationResponse>();
    vi.mocked(backend.askAiConversation).mockReturnValueOnce(answer.promise);
    await openFirst();
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Question before removal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(backend.askAiConversation).toHaveBeenCalled());
    const request = vi.mocked(backend.askAiConversation).mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    const dialog = await showRemoveConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove paper' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(backend.cancelAiRequest).toHaveBeenCalledWith(request.request_id);
    await act(async () => answer.resolve(completeConversation(request, 'Late deleted answer')));
    expect(screen.queryByText('Late deleted answer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open First paper' })).toBeNull();
    expect(backend.saveAiConversationNote).not.toHaveBeenCalled();
    conversations.clear();
    vi.mocked(backend.previewArxivPaper).mockResolvedValue({ preview_id: 'first-again', metadata: first, library_paper: null });
    vi.mocked(backend.downloadArxivPaper).mockResolvedValue(first);
    fireEvent.change(screen.getByLabelText('arXiv ID or link'), { target: { value: first.arxiv_id } });
    fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
    const previewDialog = await screen.findByRole('dialog', { name: 'First paper' });
    fireEvent.click(within(previewDialog).getByRole('button', { name: 'Download & add to library' }));
    await screen.findByTestId('reader');
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('tab', { name: /Notes/ }));
    expect(screen.queryByRole('article', { name: 'AI conversation: Question before removal' })).toBeNull();
    expect(screen.queryByText('Late deleted answer')).toBeNull();
    expect(lastReader.annotations).toHaveLength(0);
  });
});

describe('removal completion races', () => {
  it('does not open a PDF whose cached load completes after the paper was removed', async () => {
    const pdf = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(backend.getPdfBytes).mockReturnValueOnce(pdf.promise);
    render(<WorkspacePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open First paper' }));
    expect(screen.queryByTestId('reader')).toBeNull();
    const dialog = await showRemoveConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove paper' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Open First paper' })).toBeNull();
    await act(async () => pdf.resolve(new Uint8Array([1, 2, 3])));
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Open papers' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open First paper' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open Second paper' })).toBeTruthy();
  });

  it('does not restore a deleted annotation from a late Save note response', async () => {
    await openFirst();
    openSelection();
    fireEvent.change(screen.getByLabelText('Question about this selection'), { target: { value: 'Explain before removing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByLabelText('Suggested note');
    const save = deferred<ReturnType<typeof saveConversationNote>>();
    let saved!: ReturnType<typeof saveConversationNote>;
    vi.mocked(backend.saveAiConversationNote).mockImplementationOnce((id, noteId, content) => {
      saved = saveConversationNote(id, noteId, content);
      return save.promise;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(backend.saveAiConversationNote).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Library home' }));
    const dialog = await showRemoveConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove paper' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => save.resolve(saved));
    expect(screen.queryByRole('button', { name: 'Open First paper' })).toBeNull();
    conversations.clear();
    vi.mocked(backend.previewArxivPaper).mockResolvedValue({ preview_id: 'first-again', metadata: first, library_paper: null });
    vi.mocked(backend.downloadArxivPaper).mockResolvedValue(first);
    fireEvent.change(screen.getByLabelText('arXiv ID or link'), { target: { value: first.arxiv_id } });
    fireEvent.click(screen.getByRole('button', { name: 'Find paper' }));
    const previewDialog = await screen.findByRole('dialog', { name: 'First paper' });
    fireEvent.click(within(previewDialog).getByRole('button', { name: 'Download & add to library' }));
    await screen.findByTestId('reader');
    expect(lastReader.annotations).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('tab', { name: /Notes/ }));
    expect(screen.queryByText('A concise takeaway')).toBeNull();
    expect(screen.queryByRole('article', { name: 'AI conversation: Explain before removing' })).toBeNull();
  });
});


describe('classified hyperlink flows', () => {
  it('keeps a superseded paper load from changing the reader behind external confirmation', async () => {
    await openReadingBlock();
    const location = lastReader.target_location;
    const loading = deferred<Uint8Array<ArrayBuffer>>();
    vi.mocked(backend.getPdfBytes).mockReturnValueOnce(loading.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    expect(backend.getPdfBytes).toHaveBeenLastCalledWith(second.paper_id);
    act(() => lastReader.on_navigate({ kind: 'external', url: 'https://example.org/paper' }));
    const dialog = screen.getByRole('dialog', { name: 'External link' });
    await act(async () => loading.resolve(new Uint8Array([4, 5, 6])));
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
    expect(lastReader.target_location).toEqual(location);
    expect(screen.getAllByRole('dialog')).toEqual([dialog]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
    expect(backend.openExternal).not.toHaveBeenCalled();
  });

  it('confirms outside links without moving the reader and cancellation never opens a browser', async () => {
    await openReadingBlock();
    const location = lastReader.target_location;
    act(() => lastReader.on_navigate({ kind: 'external', url: 'https://example.org/research?q=paper#figure-2' }));
    const dialog = screen.getByRole('dialog', { name: 'External link' });
    expect(within(dialog).getByText('example.org')).toBeTruthy();
    expect(within(dialog).getByDisplayValue('https://example.org/research?q=paper#figure-2')).toBeTruthy();
    expect(lastReader.reading_active).toBe(false);
    expect(backend.openExternal).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(screen.getByTestId('reader')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(lastReader.reading_active).toBe(true);
    expect(lastReader.target_location).toEqual(location);
    expect(backend.openExternal).not.toHaveBeenCalled();
  });

  it('shows a copyable DOI and restores the citation popup on dismissal', async () => {
    await openFirst();
    const reference: ReferenceItem = {
      reference_id: 'doi-reference', label: '7', citation_text: '[7] A cited paper.', title: null,
      authors: [], publication_year: null, venue: null, parse_confidence: 'raw', source_rect: null,
      page_number: 9, arxiv_id: null, doi: '10.1234/example', url: null,
    };
    act(() => lastReader.on_navigate({ kind: 'reference', reference }));
    fireEvent.click(screen.getByRole('button', { name: 'Open DOI' }));
    const dialog = screen.getByRole('dialog', { name: 'External link' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Reference details' })).toBeNull();
    expect(backend.openExternal).not.toHaveBeenCalled();
    expect(within(dialog).getByDisplayValue('https://doi.org/10.1234/example')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await screen.findByRole('dialog', { name: 'Reference details' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(backend.openExternal).not.toHaveBeenCalled();
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
  });

  it('confirms explicit View on arXiv browser actions and returns to the info sheet on Cancel', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Show paper abstract and metadata' }));
    fireEvent.click(screen.getByRole('button', { name: 'View on arXiv' }));
    const dialog = screen.getByRole('dialog', { name: 'External link' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(within(dialog).getByDisplayValue('https://arxiv.org/abs/1706.03762v7')).toBeTruthy();
    expect(backend.openExternal).not.toHaveBeenCalled();
    expect(backend.previewArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'View on arXiv' })).toBeTruthy();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('rejects unsafe browser targets even when they bypass PDF classification', async () => {
    await openFirst();
    act(() => lastReader.on_navigate({ kind: 'external', url: 'javascript:alert(1)' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('not a valid HTTP or HTTPS URL');
    expect(backend.openExternal).not.toHaveBeenCalled();
  });

  it('opens a cached paper in the source mode while retaining its saved page and rotation', async () => {
    const destination: ReadingLocation = {
      paper_id: second.paper_id, page_number: 7, page_position: [.3, .6], rotation: 90,
      reader_mode: 'pdf', zoom: 2.7, zoom_mode: 'custom', reading_block_id: null,
    };
    vi.mocked(backend.listPapers).mockResolvedValue([first, { ...second, last_location: destination }]);
    await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location).toEqual({ ...destination, reader_mode: 'reading', zoom: 1, zoom_mode: 'fit_width' });
    expect(backend.previewArxivPaper).not.toHaveBeenCalled();
    expect(backend.openExternal).not.toHaveBeenCalled();
  });

  it('carries Reading mode through abstract preview and explicit download', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    const dialog = await screen.findByRole('dialog', { name: 'Second paper' });
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download & add to library' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location).toMatchObject({ reader_mode: 'reading', page_number: 1, zoom_mode: 'fit_width' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(backend.openExternal).not.toHaveBeenCalled();
  });

  it('keeps PDF mode when a linked paper was previously saved in Reading view', async () => {
    const destination: ReadingLocation = {
      paper_id: second.paper_id, page_number: 3, page_position: [.1, .4], rotation: 0,
      reader_mode: 'reading', zoom: 1.6, zoom_mode: 'custom', reading_block_id: 'page-3-block-2',
    };
    vi.mocked(backend.listPapers).mockResolvedValue([first, { ...second, last_location: destination }]);
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location).toEqual({ ...destination, reader_mode: 'pdf', zoom: 1, zoom_mode: 'fit_width', reading_block_id: null });
  });

  it('carries the source mode when metadata lookup discovers an already saved paper', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    vi.mocked(backend.previewArxivPaper).mockResolvedValue({ ...preview, library_paper: second });
    await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location?.reader_mode).toBe('reading');
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
  });

  it('reuses an existing tab in the source mode and retains its previous mode in Back history', async () => {
    await openFirst();
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    const saved: ReadingLocation = {
      paper_id: second.paper_id, reader_mode: 'pdf', page_number: 5, page_position: [.2, .4],
      zoom: 2.2, zoom_mode: 'custom', rotation: 0,
    };
    act(() => lastReader.on_location_change(saved));
    const tabs = screen.getByRole('navigation', { name: 'Open papers' });
    fireEvent.click(within(tabs).getByRole('button', { name: 'First paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Reading view' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    expect(lastReader.target_location).toMatchObject({ reader_mode: 'reading', page_number: 5, page_position: [.2, .4], zoom: 1 });
    expect(within(tabs).getAllByRole('button', { name: 'Second paper' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(saved);
  });
});

describe('shared reference previews', () => {
  const reference: ReferenceItem = {
    reference_id: 'ref-7', label: '7', citation_text: '[7] Author. Related paper. 2020.',
    title: 'Related paper', authors: ['Author'], publication_year: '2020', venue: null,
    parse_confidence: 'parsed', page_number: 12, source_rect: [50, 610, 300, 640],
    arxiv_id: '1409.0473v3', doi: null, url: null,
  };

  it('opens citation details locally and requires download confirmation after the arXiv preview', async () => {
    vi.mocked(backend.listPapers).mockResolvedValue([first]);
    await openFirst();
    const location = lastReader.target_location;
    act(() => lastReader.on_navigate({ kind: 'reference', reference }));
    const details = screen.getByRole('dialog', { name: 'Reference details' });
    expect(within(details).getByText('Related paper')).toBeTruthy();
    expect(backend.previewArxivPaper).not.toHaveBeenCalled();
    expect(lastReader.target_location).toEqual(location);
    expect(lastReader.reading_active).toBe(false);
    fireEvent.click(within(details).getByRole('button', { name: 'Preview paper' }));
    const previewDialog = await screen.findByRole('dialog', { name: 'Second paper' });
    expect(backend.previewArxivPaper).toHaveBeenCalledExactlyOnceWith('1409.0473v3', expect.any(String));
    expect(backend.downloadArxivPaper).not.toHaveBeenCalled();
    fireEvent.click(within(previewDialog).getByRole('button', { name: 'Cancel' }));
    expect(lastReader.paper.paper_id).toBe(first.paper_id);
    expect(lastReader.target_location).toEqual(location);
    expect(lastReader.reading_active).toBe(true);
  });

  it('jumps to the actual bibliography anchor and Back returns to the citing Reading block', async () => {
    const original = await openReadingBlock();
    act(() => lastReader.on_navigate({ kind: 'reference', reference }));
    fireEvent.click(screen.getByRole('button', { name: 'View bibliography on page 12' }));
    expect(lastReader.target_location).toMatchObject({ reader_mode: 'reading', page_number: 12, reading_block_id: null });
    expect(lastReader.target_anchor?.quad_points).toEqual([[50, 640, 300, 640, 300, 610, 50, 610]]);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go back to previous reading location' }));
    expect(lastReader.target_location).toEqual(original);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('ignores stale lookup UI after a paper switch and reuses the successful lookup on demand', async () => {
    const lookup = deferred<ReferenceCandidate[]>();
    vi.mocked(backend.resolveReference).mockReturnValue(lookup.promise);
    const unresolved = { ...reference, arxiv_id: null };
    await openFirst();
    act(() => lastReader.on_navigate({ kind: 'reference', reference: unresolved }));
    fireEvent.click(screen.getByRole('button', { name: 'Find a match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close reference details' }));
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    await act(async () => lookup.resolve([{ title: 'Matched title', authors: ['Author'], publication_year: '2020', venue: null, match_kind: 'suggestion', arxiv_id: null, doi: '10.1234/test', url: 'https://doi.org/10.1234/test' }]));
    expect(screen.queryByText('Matched title')).toBeNull();
    act(() => lastReader.on_navigate({ kind: 'reference', reference: unresolved }));
    fireEvent.click(screen.getByRole('button', { name: 'Find a match' }));
    await screen.findByText('Matched title');
    expect(backend.resolveReference).toHaveBeenCalledTimes(1);
  });
});

describe('saved note presentation', () => {
  const saved_note: Annotation = {
    schema_version: 1, annotation_id: 'saved-passage-note',
    target: { paper_id: first.paper_id, pdf_hash: first.pdf_hash, page_anchors: selection.page_anchors },
    body: { kind: 'note', content: 'A saved takeaway\nDetails about the passage.' },
    created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z',
  };

  function openNote() {
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand note: A saved takeaway' }));
    return screen.getByRole('article', { name: 'Saved note: A saved takeaway' });
  }

  it('shows one collapsed sidebar item per note and keeps it open while jumping to its Reading passage', async () => {
    vi.mocked(backend.listAnnotations).mockResolvedValue([saved_note]);
    await openReadingBlock();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('tab', { name: /Notes/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getAllByRole('article', { name: 'Saved note: A saved takeaway' })).toHaveLength(1);
    expect(screen.queryByText('Details about the passage.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand note: A saved takeaway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Go to passage' }));
    expect(lastReader.target_location).toMatchObject({ reader_mode: 'reading', reading_block_id: null, page_number: 4 });
    expect(lastReader.target_anchor).toEqual(selection.page_anchors[0]);
    expect(lastReader.inline_notes).toBe(false);
    expect(lastReader.reading_active).toBe(true);
    expect(screen.getByRole('button', { name: 'Collapse note: A saved takeaway' })).toBeTruthy();
    expect(screen.getByTestId('reader').closest('[inert]')).toBeNull();
  });

  it.each(['phone', 'tablet'] as const)('enables inline notes on %s and navigates using the clicked block anchor', async (device_kind) => {
    vi.mocked(backend.getReaderCapabilities).mockResolvedValue({ supports_orientation: true, device_kind });
    vi.mocked(backend.listAnnotations).mockResolvedValue([saved_note]);
    await openFirst();
    expect(lastReader.inline_notes).toBe(true);
    expect(document.querySelector('.desktop-reader')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(lastReader.reading_active).toBe(false);
    expect(screen.getByTestId('reader').closest('[inert]')).toBeTruthy();
    const anchor = { ...selection.page_anchors[0], page_number: 7 };
    act(() => lastReader.on_navigate_annotation?.(saved_note, anchor));
    expect(lastReader.target_anchor).toEqual(anchor);
    expect(lastReader.target_location?.page_number).toBe(7);
    expect(lastReader.reading_active).toBe(true);
    expect(screen.queryByRole('complementary', { name: 'References and annotations' })).toBeNull();
  });

  it('retains an unfinished edit across sidebar close and paper tabs, and retries a failed save', async () => {
    vi.mocked(backend.listAnnotations).mockImplementation(async (id) => id === first.paper_id ? [saved_note] : []);
    await openFirst();
    openNote();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'An unfinished revision' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close notes sidebar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('An unfinished revision');
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Open papers' })).getByRole('button', { name: 'First paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('An unfinished revision');
    vi.mocked(backend.saveAnnotation).mockRejectedValueOnce(new Error('Storage unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable');
    expect((screen.getByRole('textbox', { name: 'Edit note' }) as HTMLTextAreaElement).value).toBe('An unfinished revision');
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull());
    expect(lastReader.annotations[0].body).toEqual({ kind: 'note', content: 'An unfinished revision' });
    expect(backend.saveAnnotation).toHaveBeenCalledTimes(2);
  });

  it('merges a save completed on another tab without restoring its old edit draft or stale note snapshot', async () => {
    vi.mocked(backend.listAnnotations).mockImplementation(async (id) => id === first.paper_id ? [saved_note] : []);
    const save = deferred<Annotation>();
    vi.mocked(backend.saveAnnotation).mockReturnValueOnce(save.promise);
    await openFirst();
    openNote();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit note' }), { target: { value: 'Saved while away' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    const previous_reader = lastReader;
    fireEvent.click(screen.getByRole('button', { name: 'Follow cited paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(second.paper_id));
    let stale_result: boolean | undefined;
    await act(async () => { stale_result = await previous_reader.on_update_annotation?.(saved_note, 'Stale callback'); });
    expect(stale_result).toBe(false);
    expect(backend.saveAnnotation).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve({ ...saved_note, body: { kind: 'note', content: 'Saved while away' } }));
    expect(lastReader.annotations).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Open papers' })).getByRole('button', { name: 'First paper' }));
    await waitFor(() => expect(lastReader.paper.paper_id).toBe(first.paper_id));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle reading controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open references and notes panel' }));
    expect(screen.getByRole('button', { name: 'Expand note: Saved while away' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Edit note' })).toBeNull();
    expect(lastReader.annotations[0].body).toEqual({ kind: 'note', content: 'Saved while away' });
  });

  it('keeps a note on deletion failure and removes it only after a successful retry', async () => {
    vi.mocked(backend.listAnnotations).mockResolvedValue([saved_note]);
    await openFirst();
    openNote();
    vi.mocked(backend.deleteAnnotation).mockRejectedValueOnce(new Error('Storage unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Storage unavailable');
    expect(lastReader.annotations).toEqual([saved_note]);
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation' }));
    await waitFor(() => expect(lastReader.annotations).toHaveLength(0));
    expect(screen.queryByRole('article', { name: 'Saved note: A saved takeaway' })).toBeNull();
    expect(screen.getByText('Select a passage to save your first note. Saved notes will appear here.')).toBeTruthy();
  });
});
