import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, KeyRound, LoaderCircle, RefreshCw, Settings2, X } from 'lucide-react';
import type { AiModel, AiProviderKind, AiSettings } from '../lib/types';
import { AI_PROVIDERS, normalizeAiBaseUrl } from '../lib/ai-providers';
import { listAiModels, saveSettings } from '../lib/tauri';
import { DialogBackdrop } from './DialogBackdrop';
import './settings-dialog.css';

interface SettingsDialogProps {
  settings: AiSettings;
  on_close: () => void;
  on_saved: (settings: AiSettings) => void;
}

export function SettingsDialog({ settings, on_close, on_saved }: SettingsDialogProps) {
  const [providerKind, setProviderKind] = useState(settings.provider_kind);
  const [baseUrl, setBaseUrl] = useState(settings.base_url);
  const [modelId, setModelId] = useState(settings.model_id);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelState, setModelState] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle');
  const [modelError, setModelError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const discoveryVersion = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLSelectElement>(null);
  const closeRef = useRef(on_close);
  const savingRef = useRef(saving);
  closeRef.current = on_close;
  savingRef.current = saving;

  const preset = AI_PROVIDERS.find((provider) => provider.provider_kind === providerKind)!;
  const normalizedUrl = normalizeAiBaseUrl(baseUrl);
  const hasSavedKey = settings.has_api_key && normalizedUrl === normalizeAiBaseUrl(settings.base_url);
  const hasKey = Boolean(apiKey.trim()) || (hasSavedKey && !clearKey);
  const canConnect = Boolean(normalizedUrl) && (!preset.requires_api_key || hasKey);
  const useManualModel = manualModel || models.length === 0;
  const missingModel = Boolean(modelId) && !models.some((model) => model.model_id === modelId);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    firstInputRef.current?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !savingRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], textarea:not(:disabled)',
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
      discoveryVersion.current += 1;
      document.removeEventListener('keydown', handleKey);
      previousFocus?.focus();
    };
  }, []);

  function invalidateModels() {
    discoveryVersion.current += 1;
    setModels([]);
    setModelState('idle');
    setModelError(null);
    setError(null);
  }

  function changeProvider(next: AiProviderKind) {
    const nextPreset = AI_PROVIDERS.find((provider) => provider.provider_kind === next)!;
    invalidateModels();
    setProviderKind(next);
    setBaseUrl(nextPreset.base_url);
    setModelId('');
    setApiKey('');
    setClearKey(false);
    setManualModel(false);
  }

  function changeBaseUrl(value: string) {
    invalidateModels();
    if (normalizeAiBaseUrl(value) !== normalizedUrl) {
      // A draft secret belongs only to the endpoint where it was entered.
      setApiKey('');
      setClearKey(false);
    }
    setBaseUrl(value);
  }

  function draftSettings(): AiSettings {
    return { provider_kind: providerKind, base_url: normalizedUrl, model_id: modelId.trim(), has_api_key: hasSavedKey };
  }

  function draftKey(): string | null {
    return apiKey.trim() || (clearKey ? '' : null);
  }

  async function loadModels() {
    const version = ++discoveryVersion.current;
    setModelState('loading');
    setModelError(null);
    try {
      const result = await listAiModels(draftSettings(), draftKey());
      if (version !== discoveryVersion.current) return;
      setModels(result);
      setModelState('loaded');
      setManualModel(false);
    } catch (cause) {
      if (version !== discoveryVersion.current) return;
      setModelState('error');
      setModelError(String(cause));
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!normalizedUrl || !modelId.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveSettings(draftSettings(), draftKey());
      setApiKey('');
      on_saved(saved);
    } catch (cause) {
      setError(String(cause));
      setSaving(false);
    }
  }

  return (
    <DialogBackdrop class_name="modal-backdrop" dismissible={!saving} on_dismiss={on_close}>
      <div className="settings-dialog ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" ref={dialogRef}>
        <div className="dialog-heading">
          <span className="dialog-symbol"><Settings2 size={20} /></span>
          <button type="button" className="icon-button" aria-label="Close settings" onClick={on_close} disabled={saving}><X size={18} /></button>
        </div>
        <h2 id="settings-title">Your reading assistant</h2>
        <p className="dialog-description">Bring your own API key. Tokn runs inside Papertrail and connects directly to your provider.</p>
        <form onSubmit={(event) => { void handleSubmit(event); }}>
          <label className="field-label" htmlFor="provider-kind">Provider</label>
          <select id="provider-kind" ref={firstInputRef} className="text-field" value={providerKind} onChange={(event) => changeProvider(event.target.value as AiProviderKind)} disabled={saving}>
            {AI_PROVIDERS.map((provider) => <option value={provider.provider_kind} key={provider.provider_kind}>{provider.label}</option>)}
          </select>
          <label className="field-label" htmlFor="provider-url">API base URL</label>
          <input id="provider-url" type="url" className="text-field" value={baseUrl} onChange={(event) => changeBaseUrl(event.target.value)} required disabled={saving} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <p className="field-hint">Use the provider’s HTTPS URL, or a local server on this device.</p>
          <label className="field-label key-label" htmlFor="provider-key">API key <span className="credential-status">{hasSavedKey && !clearKey ? <><Check size={12} /> Key saved</> : preset.requires_api_key ? 'Required by this provider' : 'Optional for local providers'}</span></label>
          <input id="provider-key" type="password" className="text-field" value={apiKey} onChange={(event) => {
            invalidateModels();
            setApiKey(event.target.value);
          }} placeholder={hasSavedKey && !clearKey ? 'Leave blank to keep your saved key' : 'Enter your API key'} disabled={saving} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          <p className="field-hint"><KeyRound size={13} /> Saved in your system credential store when you save settings.</p>
          {hasSavedKey && <label className="checkbox-label"><input type="checkbox" checked={clearKey} onChange={(event) => {
            invalidateModels();
            setClearKey(event.target.checked);
          }} disabled={saving || Boolean(apiKey.trim())} /> Remove the saved API key</label>}
          <div className="model-field-heading">
            <label className="field-label" htmlFor="provider-model">Model</label>
            <button type="button" className="button button-subtle" onClick={() => { void loadModels(); }} disabled={saving || modelState === 'loading' || !canConnect}>
              {modelState === 'loading' ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
              {modelState === 'loading' ? 'Loading…' : 'Load models'}
            </button>
          </div>
          {useManualModel ? <input id="provider-model" className="text-field" value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="Enter a model ID" required disabled={saving} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} /> : <select id="provider-model" className="text-field" value={modelId} onChange={(event) => setModelId(event.target.value)} required disabled={saving}>
            <option value="" disabled>Choose a model</option>
            {missingModel && <option value={modelId}>{modelId} (current)</option>}
            {models.map((model) => <option value={model.model_id} key={model.model_id}>{model.display_name === model.model_id ? model.model_id : `${model.display_name} · ${model.model_id}`}</option>)}
          </select>}
          {models.length > 0 && <button type="button" className="text-button model-entry-toggle" onClick={() => setManualModel(!useManualModel)} disabled={saving}>{useManualModel ? 'Choose from loaded models' : 'Enter a model ID manually'}</button>}
          <div className="model-status" aria-live="polite" aria-atomic="true">
            {modelState === 'loading' && <p className="field-hint">Connecting to {preset.label}…</p>}
            {modelState === 'loaded' && <p className="field-hint">{models.length ? `${models.length} models loaded. Choose one or enter a model ID.` : 'The provider returned no models. You can enter a model ID manually.'}</p>}
            {modelState === 'idle' && <p className="field-hint">{!canConnect && preset.requires_api_key ? 'Enter an API key to load models, or enter a model ID manually.' : 'Load available models, or enter a model ID manually.'}</p>}
          </div>
          {modelError && <p className="inline-error" role="alert">{modelError} You can still enter a model ID manually.</p>}
          <div className="privacy-note">Only the passage you select, nearby text, and paper metadata are sent when you ask a question.</div>
          {error && <p className="inline-error" role="alert">{error}</p>}
          <div className="dialog-actions">
            <button type="button" className="button button-subtle" onClick={on_close} disabled={saving}>Cancel</button>
            <button type="submit" className="button button-primary" disabled={saving || !normalizedUrl || !modelId.trim()}>{saving && <LoaderCircle size={16} className="spin" />}{saving ? 'Saving…' : 'Save settings'}</button>
          </div>
        </form>
      </div>
    </DialogBackdrop>
  );
}
