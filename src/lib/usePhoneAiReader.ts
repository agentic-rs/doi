import { useCallback, useEffect, useRef, useState } from 'react';
import { setReaderAiMode } from './backend';
import type { ReaderOrientation } from './types';

interface PhoneAiReaderOptions {
  enabled: boolean;
  on_error: (message: string) => void;
  on_orientation: (orientation: ReaderOrientation) => void;
}

type Phase = 'closed' | 'entering' | 'open' | 'closing';

// The native reader belongs to the window, not a React component. Include
// cleanup from an old mount before allowing a new mount to acquire its lock.
let nativeQueue: Promise<void> = Promise.resolve();
function setMode(active: boolean): Promise<ReaderOrientation> {
  const operation = nativeQueue.then(() => setReaderAiMode(active));
  nativeQueue = operation.then(() => {}, () => {});
  return operation;
}

export function usePhoneAiReader({ enabled, on_error, on_orientation }: PhoneAiReaderOptions) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const callbacksRef = useRef({ on_error, on_orientation });
  callbacksRef.current = { on_error, on_orientation };
  const phaseRef = useRef<Phase>('closed');
  const generationRef = useRef(0);
  const enterRef = useRef<Promise<boolean> | null>(null);

  const close = useCallback(() => {
    if (mountedRef.current) setOpen(false);
    if (phaseRef.current === 'closed' || phaseRef.current === 'closing') return;
    phaseRef.current = 'closing';
    const generation = ++generationRef.current;
    if (mountedRef.current) setPending(true);
    // Queue release immediately, even if entry has not finished yet. A later
    // show remains blocked until the prior orientation has been restored.
    void setMode(false).then((orientation) => {
      if (mountedRef.current && generationRef.current === generation) {
        callbacksRef.current.on_orientation(orientation);
      }
    }).catch((cause) => {
      if (mountedRef.current && generationRef.current === generation) {
        callbacksRef.current.on_error(`Could not restore the reader orientation: ${String(cause)}`);
      }
    }).finally(() => {
      if (generationRef.current !== generation) return;
      phaseRef.current = 'closed';
      if (mountedRef.current) setPending(false);
    });
  }, []);

  const show = useCallback((): Promise<boolean> => {
    if (!mountedRef.current || !enabledRef.current || phaseRef.current === 'closing') return Promise.resolve(false);
    if (phaseRef.current === 'entering') return enterRef.current!;
    if (phaseRef.current === 'open') {
      const generation = generationRef.current;
      return Promise.resolve().then(() => mountedRef.current && enabledRef.current
        && generationRef.current === generation && phaseRef.current === 'open');
    }
    phaseRef.current = 'entering';
    const generation = ++generationRef.current;
    setPending(true);
    const operation = setMode(true);
    const entering = (async () => {
      try {
        const orientation = await operation;
        if (!mountedRef.current || !enabledRef.current || generationRef.current !== generation) {
          if (generationRef.current === generation) close();
          return false;
        }
        phaseRef.current = 'open';
        setPending(false);
        callbacksRef.current.on_orientation(orientation);
        setOpen(true);
        return true;
      } catch (cause) {
        const current = generationRef.current === generation;
        if (current) close();
        if (current && mountedRef.current && enabledRef.current) {
          callbacksRef.current.on_error(`Could not open AI in portrait: ${String(cause)}`);
        }
        return false;
      } finally {
        if (generationRef.current === generation) enterRef.current = null;
      }
    })();
    enterRef.current = entering;
    return entering;
  }, [close]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      close();
    };
  }, [close]);

  useEffect(() => { if (!enabled) close(); }, [enabled, close]);

  return { open, pending, show, close };
}
