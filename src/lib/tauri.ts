import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AiAnswer, AiConversation, AiConversationRequest, AiConversationResponse, AiConversationSaveResult,
  AiModel, AiRequest, AiSettings, AiStreamEvent, Annotation, OperationProgress, Paper,
  ReaderCapabilities, ReaderOrientation, ReadingLayout, ReadingLocation, ReferenceCandidate,
} from './types';

export const nativeAvailable = isTauri;
export const listPapers = () => invoke<Paper[]>('list_papers');
export const openArxivPaper = (input: string, request_id: string) =>
  invoke<Paper>('open_arxiv_paper', { input, request_id });
export const getPdfBytes = async (paper_id: string) =>
  new Uint8Array(await invoke<ArrayBuffer>('get_pdf_bytes', { paper_id }));
export const saveReadingPosition = (location: ReadingLocation) =>
  invoke<void>('save_reading_position', { location });
export const getReadingLayout = (paper_id: string, layout_version: number) =>
  invoke<ReadingLayout | null>('get_reading_layout', { paper_id, layout_version });
export const saveReadingLayout = (paper_id: string, layout: ReadingLayout) =>
  invoke<void>('save_reading_layout', { paper_id, layout });
export const listAnnotations = (paper_id: string) =>
  invoke<Annotation[]>('list_annotations', { paper_id });
export const saveAnnotation = (annotation: Annotation) =>
  invoke<Annotation>('save_annotation', { annotation });
export const deleteAnnotation = (annotation_id: string) =>
  invoke<void>('delete_annotation', { annotation_id });
export const saveAnnotationFile = (file_name: string, content: string) =>
  invoke<string | null>('save_annotation_file', { file_name, content });
export const getSettings = () => invoke<AiSettings>('get_settings');
export const saveSettings = (settings: AiSettings, api_key: string | null) =>
  invoke<AiSettings>('save_settings', { settings, api_key });
export const listAiModels = (settings: AiSettings, api_key: string | null) =>
  invoke<AiModel[]>('list_ai_models', { settings, api_key });
export const askSelection = (request: AiRequest) => invoke<AiAnswer>('ask_selection', { request });
export const listAiConversations = (paper_id: string) =>
  invoke<AiConversation[]>('list_ai_conversations', { paper_id });
export const askAiConversation = (request: AiConversationRequest) =>
  invoke<AiConversationResponse>('ask_ai_conversation', { request });
export const generateAiConversationNote = (request_id: string, conversation_id: string) =>
  invoke<AiConversationResponse>('generate_ai_conversation_note', { request_id, conversation_id });
export const updateAiConversationNote = (conversation_id: string, note_id: string, content: string) =>
  invoke<AiConversation>('update_ai_conversation_note', { conversation_id, note_id, content });
export const saveAiConversationNote = (conversation_id: string, note_id: string, content: string) =>
  invoke<AiConversationSaveResult>('save_ai_conversation_note', { conversation_id, note_id, content });
export const cancelAiRequest = (request_id: string) => invoke<void>('cancel_ai_request', { request_id });
export const onAiStream = (handler: (event: AiStreamEvent) => void) =>
  listen<AiStreamEvent>('ai-stream', (event) => handler(event.payload));
export const resolveReference = (citation_text: string) =>
  invoke<ReferenceCandidate[]>('resolve_reference', { citation_text });
export const openExternal = (url: string) => invoke<void>('open_external', { url });
export const getReaderCapabilities = () => invoke<ReaderCapabilities>('reader_capabilities');
export const setReaderOrientation = (orientation: ReaderOrientation) =>
  invoke<ReaderOrientation>('set_reader_orientation', { orientation });
export const onProgress = (handler: (progress: OperationProgress) => void) =>
  listen<OperationProgress>('operation-progress', (event) => handler(event.payload));
