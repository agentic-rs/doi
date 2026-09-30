// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModel, AiSettings } from '../lib/types';
import { DEFAULT_AI_SETTINGS } from '../lib/ai-providers';
import { listAiModels, saveSettings } from '../lib/tauri';
import { SettingsDialog } from './SettingsDialog';

vi.mock('../lib/tauri', () => ({ listAiModels: vi.fn(), saveSettings: vi.fn() }));

const availableModels: AiModel[] = [
  { model_id: 'model-one', display_name: 'Model One' },
  { model_id: 'model-two', display_name: 'model-two' },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function openSettings(overrides: Partial<AiSettings> = {}) {
  const settings = { ...DEFAULT_AI_SETTINGS, ...overrides };
  const on_close = vi.fn();
  const on_saved = vi.fn();
  const view = render(<SettingsDialog settings={settings} on_close={on_close} on_saved={on_saved} />);
  return { ...view, settings, on_close, on_saved };
}

function enterKey(value = 'draft-secret') {
  fireEvent.change(screen.getByLabelText(/^API key/), { target: { value } });
}

function enterModel(value: string) {
  fireEvent.change(screen.getByLabelText('Model'), { target: { value } });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listAiModels).mockResolvedValue(availableModels);
  vi.mocked(saveSettings).mockImplementation(async (settings, api_key) => ({
    ...settings, has_api_key: Boolean(api_key) || (settings.has_api_key && api_key !== ''),
  }));
});

afterEach(cleanup);

describe('embedded Tokn settings', () => {
  it('discovers with a draft key before saving and preserves a model absent from the list', async () => {
    const pending = deferred<AiModel[]>();
    vi.mocked(listAiModels).mockReturnValue(pending.promise);
    const { settings } = openSettings({ model_id: 'my-custom-model' });
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
    enterKey();
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(listAiModels).toHaveBeenCalledWith(settings, 'draft-secret');
    expect(saveSettings).not.toHaveBeenCalled();
    expect(screen.getByText('Connecting to OpenAI…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => pending.resolve(availableModels));
    const picker = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
    expect(picker.value).toBe('my-custom-model');
    expect(screen.getByRole('option', { name: 'my-custom-model (current)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enter a model ID manually' }));
    expect((screen.getByRole('textbox', { name: 'Model' }) as HTMLInputElement).value).toBe('my-custom-model');
  });

  it('saves the chosen provider, model, and draft key only when Save is pressed', async () => {
    const { on_saved } = openSettings();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepseek' } });
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe('https://api.deepseek.com');
    enterKey();
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByRole('combobox', { name: 'Model' });
    enterModel('model-two');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await act(async () => {});
    expect(saveSettings).toHaveBeenCalledWith({ provider_kind: 'deepseek', base_url: 'https://api.deepseek.com', model_id: 'model-two', has_api_key: false }, 'draft-secret');
    expect(on_saved).toHaveBeenCalledWith({ provider_kind: 'deepseek', base_url: 'https://api.deepseek.com', model_id: 'model-two', has_api_key: true });
  });

  it('scopes saved-key status to the canonical endpoint and clears draft secrets on URL changes', () => {
    openSettings({ has_api_key: true, base_url: 'https://API.OPENAI.COM:443/v1/' });
    expect(screen.getByText('Key saved')).toBeTruthy();
    enterKey();
    fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://api.openai.com/v1' } });
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe('draft-secret');
    fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://other.example/v1' } });
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Key saved')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect((screen.getByRole('button', { name: 'Load models' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://api.openai.com/v1' } });
    expect(screen.getByText('Key saved')).toBeTruthy();
  });

  it.each(['provider', 'url', 'key', 'remove-key'] as const)('discards discovery results after a %s edit', async (edit) => {
    const pending = deferred<AiModel[]>();
    vi.mocked(listAiModels).mockReturnValue(pending.promise);
    openSettings({ has_api_key: true });
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    if (edit === 'provider') fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepseek' } });
    if (edit === 'url') fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: 'https://other.example/v1' } });
    if (edit === 'key') enterKey();
    if (edit === 'remove-key') fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => pending.resolve(availableModels));
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    expect(screen.queryByText(/models loaded/)).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Model' })).toBeTruthy();
  });

  it('does not carry a typed key to a different provider or show a stale connection error', async () => {
    const pending = deferred<AiModel[]>();
    vi.mocked(listAiModels).mockReturnValue(pending.promise);
    openSettings({ model_id: 'old-model' });
    enterKey();
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'zai' } });
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe('https://api.z.ai/api/paas/v4');
    await act(async () => pending.reject(new Error('Old endpoint is offline')));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('supports keyless local discovery and explicit saved-key removal', async () => {
    openSettings({ provider_kind: 'openai_compatible', base_url: 'http://127.0.0.1:8080/v1', has_api_key: true, model_id: 'local-model' });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByRole('combobox', { name: 'Model' });
    expect(vi.mocked(listAiModels).mock.calls[0][1]).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await act(async () => {});
    expect(vi.mocked(saveSettings).mock.calls[0][1]).toBe('');
  });

  it('offers manual entry when discovery fails or returns an empty list', async () => {
    vi.mocked(listAiModels).mockRejectedValueOnce('This endpoint does not list models.').mockResolvedValueOnce([]);
    openSettings({ provider_kind: 'openai_compatible', base_url: 'http://127.0.0.1:8080/v1' });
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect((await screen.findByRole('alert')).textContent).toContain('You can still enter a model ID manually.');
    expect(vi.mocked(listAiModels).mock.calls[0][1]).toBeNull();
    enterModel('manual-model');
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    await screen.findByText(/provider returned no models/);
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('manual-model');
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await act(async () => {});
    expect(vi.mocked(saveSettings).mock.calls[0][0].model_id).toBe('manual-model');
  });

  it('keeps focus during request state changes and restores it on close', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const pending = deferred<AiModel[]>();
    vi.mocked(listAiModels).mockReturnValue(pending.promise);
    const { unmount } = openSettings({ has_api_key: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Provider'));
    const key = screen.getByLabelText(/^API key/);
    key.focus();
    fireEvent.click(screen.getByRole('button', { name: 'Load models' }));
    expect(document.activeElement).toBe(key);
    await act(async () => pending.resolve(availableModels));
    expect(document.activeElement).toBe(key);
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('keeps unsaved values after a save error and disables dismissal during saving', async () => {
    const pending = deferred<AiSettings>();
    vi.mocked(saveSettings).mockReturnValue(pending.promise);
    const { on_close, container } = openSettings({ model_id: 'model-one' });
    enterKey();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.pointerDown(container.firstElementChild!);
    fireEvent.pointerUp(container.firstElementChild!);
    fireEvent.click(container.firstElementChild!);
    expect(on_close).not.toHaveBeenCalled();
    await act(async () => pending.reject('Could not save the key.'));
    expect(screen.getByRole('alert').textContent).toBe('Could not save the key.');
    expect((screen.getByLabelText(/^API key/) as HTMLInputElement).value).toBe('draft-secret');
    expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('model-one');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(on_close).toHaveBeenCalledOnce();
  });

  it('keeps the backdrop through press and release, then consumes the dismissal click', () => {
    const { container, on_close } = openSettings();
    const backdrop = container.firstElementChild!;
    fireEvent.pointerDown(backdrop);
    fireEvent.mouseDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.mouseUp(backdrop);
    expect(on_close).not.toHaveBeenCalled();
    expect(fireEvent.click(backdrop)).toBe(false);
    expect(on_close).toHaveBeenCalledOnce();
    expect(saveSettings).not.toHaveBeenCalled();
  });
});
