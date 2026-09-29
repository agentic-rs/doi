import { useCallback, useEffect, useRef, useState } from 'react';
import { safeReferenceUrl } from './pdf-geometry';
import { openExternal } from './tauri';

interface ExternalLinkRequest {
  url: string;
  busy: boolean;
  error: string | null;
}

export function useExternalLink(on_invalid: (message: string) => void) {
  const [request, setRequest] = useState<ExternalLinkRequest | null>(null);
  const requestRef = useRef<ExternalLinkRequest | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current = null;
    };
  }, []);

  const requestOpen = useCallback((value: string) => {
    if (!mountedRef.current || requestRef.current?.busy) return;
    const url = safeReferenceUrl(value);
    const next = url ? { url, busy: false, error: null } : null;
    requestRef.current = next;
    setRequest(next);
    if (!url) on_invalid('This link is not a valid HTTP or HTTPS URL.');
  }, [on_invalid]);

  const confirmOpen = useCallback(async () => {
    // Confirm only the request shown by this render, even if another URL has
    // been queued before React renders again. The ref also locks rapid clicks.
    if (!mountedRef.current || !request || request.busy || requestRef.current !== request) return;
    const opening = { ...request, busy: true, error: null };
    requestRef.current = opening;
    setRequest(opening);
    try {
      await openExternal(opening.url);
      if (!mountedRef.current || requestRef.current !== opening) return;
      requestRef.current = null;
      setRequest(null);
    } catch (cause) {
      if (!mountedRef.current || requestRef.current !== opening) return;
      const failed = { ...opening, busy: false, error: `Could not open this link: ${String(cause)}` };
      requestRef.current = failed;
      setRequest(failed);
    }
  }, [request]);

  const cancel = useCallback(() => {
    if (!mountedRef.current || requestRef.current?.busy) return;
    requestRef.current = null;
    setRequest(null);
  }, []);

  return { request, requestOpen, confirmOpen, cancel };
}
