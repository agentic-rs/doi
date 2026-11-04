import { Settings2, X } from 'lucide-react';
import type { AiSettings } from '../lib/types';
import { DialogBackdrop } from './DialogBackdrop';
import './settings-dialog.css';

interface SettingsDialogProps {
  settings: AiSettings;
  on_close: () => void;
  on_saved: (settings: AiSettings) => void;
}

export function SettingsDialog({ settings, on_close }: SettingsDialogProps) {
  return <DialogBackdrop class_name="modal-backdrop" dismissible on_dismiss={on_close}>
    <div className="settings-dialog ai-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="host-settings-title">
      <div className="dialog-heading"><span className="dialog-symbol"><Settings2 size={20} /></span>
        <button type="button" autoFocus className="icon-button" aria-label="Close settings" onClick={on_close}><X size={18} /></button></div>
      <h2 id="host-settings-title">Your reading assistant</h2>
      <p>Model: <strong>{settings.model_id || 'Not configured'}</strong></p>
      {settings.mode === 'demo' && <p>Demo mode returns sample replies. Configure a model for real paper explanations.</p>}
      <p>Close Paper Reader and open Apell Settings to change your model connection. Your papers and notes stay saved.</p>
    </div>
  </DialogBackdrop>;
}
