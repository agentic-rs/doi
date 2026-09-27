import { useEffect, useRef, useState } from 'react';
import { Check, KeyRound, LoaderCircle, Settings2, X } from 'lucide-react';
import type { AiSettings } from '../lib/types';
import { saveSettings } from '../lib/tauri';

interface SettingsDialogProps {
  settings: AiSettings;
  on_close: () => void;
  on_saved: (settings: AiSettings) => void;
}

export function SettingsDialog({ settings, on_close, on_saved }: SettingsDialogProps) {
  const [baseUrl, setBaseUrl] = useState(settings.base_url);
  const [modelId, setModelId] = useState(settings.model_id);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    firstInputRef.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) on_close();
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], textarea:not(:disabled)',
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, [on_close, saving]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSettings(
        {
          base_url: baseUrl.trim().replace(/\/+$/, ''),
          model_id: modelId.trim(),
          has_api_key: settings.has_api_key,
        },
        apiKey.trim() || (clearKey ? '' : null),
      );
      setApiKey('');
      on_saved(saved);
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !saving) on_close();
    }}>
      <div className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef}>
        <div className="dialog-heading">
          <span className="dialog-symbol"><Settings2 size={20} /></span>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={on_close} disabled={saving}><X size={18} /></button>
        </div>
        <h2 id="settings-title">Your reading assistant</h2>
        <p className="dialog-description">Connect an OpenAI-compatible provider to ask questions about a passage.</p>
        <form onSubmit={(event) => { void handleSubmit(event); }}>
          <label className="field-label" htmlFor="provider-url">API base URL</label>
          <input id="provider-url" ref={firstInputRef} type="url" className="text-field" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" required disabled={saving} />
          <p className="field-hint">Include <code>/v1</code> if your provider requires it. Requests use <code>/chat/completions</code>.</p>
          <label className="field-label" htmlFor="provider-model">Model</label>
          <input id="provider-model" className="text-field" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="Your provider’s model ID" required disabled={saving} autoComplete="off" />
          <label className="field-label key-label" htmlFor="provider-key">API key <span className="credential-status">{settings.has_api_key ? <><Check size={12} /> Key saved</> : 'Optional for local providers'}</span></label>
          <input id="provider-key" type="password" className="text-field" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={settings.has_api_key ? 'Leave blank to keep your saved key' : 'Enter your API key'} disabled={saving} autoComplete="off" spellCheck={false} />
          <p className="field-hint"><KeyRound size={13} /> Stored in your system credential store.</p>
          {settings.has_api_key && <label className="checkbox-label"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} disabled={saving || Boolean(apiKey.trim())} /> Remove the saved API key</label>}
          <div className="privacy-note">Only the passage you select, nearby text, and paper metadata are sent when you ask a question.</div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button button-subtle" onClick={on_close} disabled={saving}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={saving || !baseUrl.trim() || !modelId.trim()}>{saving && <LoaderCircle size={16} className="spin" />}{saving ? 'Saving…' : 'Save settings'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
