import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AiAnswer, AiRequest, AiSettings, Annotation, OperationProgress, Paper,
  ReaderCapabilities, ReaderOrientation, ReadingLocation, ReferenceCandidate,
} from './types';

export const nativeAvailable = isTauri;
export const listPapers = () => invoke<Paper[]>('list_papers');
export const openArxivPaper = (input: string, request_id: string) =>
  invoke<Paper>('open_arxiv_paper', { input, request_id });
export const getPdfBytes = async (paper_id: string) =>
  new Uint8Array(await invoke<ArrayBuffer>('get_pdf_bytes', { paper_id }));
export const saveReadingPosition = (location: ReadingLocation) =>
  invoke<void>('save_reading_position', { location });
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
export const askSelection = (request: AiRequest) => invoke<AiAnswer>('ask_selection', { request });
export const resolveReference = (citation_text: string) =>
  invoke<ReferenceCandidate[]>('resolve_reference', { citation_text });
export const openExternal = (url: string) => invoke<void>('open_external', { url });
export const getReaderCapabilities = () => invoke<ReaderCapabilities>('reader_capabilities');
export const setReaderOrientation = (orientation: ReaderOrientation) =>
  invoke<ReaderOrientation>('set_reader_orientation', { orientation });
export const onProgress = (handler: (progress: OperationProgress) => void) =>
  listen<OperationProgress>('operation-progress', (event) => handler(event.payload));
