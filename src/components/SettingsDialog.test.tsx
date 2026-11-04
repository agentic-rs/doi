// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from './SettingsDialog';

afterEach(cleanup);
it('directs connection setup to Apell without collecting credentials', () => {
  const on_close = vi.fn();
  render(<SettingsDialog settings={{ provider_kind: 'openai_compatible', base_url: 'connection', model_id: 'model', has_api_key: false, host_managed: true, mode: 'demo' }} on_close={on_close} on_saved={vi.fn()} />);
  expect(screen.getByText('model')).toBeTruthy();
  expect(screen.getByText(/Demo mode/)).toBeTruthy();
  expect(screen.getByText(/open Apell Settings/)).toBeTruthy();
  expect(screen.queryByLabelText(/API key/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
  expect(on_close).toHaveBeenCalledOnce();
});
