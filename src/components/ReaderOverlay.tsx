import type { RefObject } from 'react';
import { ArrowLeft, ArrowRight, Info, Library, LoaderCircle, PanelRightClose, PanelRightOpen, Settings2, Smartphone, RectangleHorizontal, X } from 'lucide-react';
import type { Paper, ReaderOrientation } from '../lib/types';
import './reader-overlay.css';

interface ReaderOverlayProps {
  paper: Paper;
  can_go_back: boolean;
  can_go_forward: boolean;
  busy: boolean;
  inspector_open: boolean;
  supports_orientation: boolean;
  orientation: ReaderOrientation;
  orientation_pending: boolean;
  library_button_ref: RefObject<HTMLButtonElement | null>;
  on_back: () => void;
  on_forward: () => void;
  on_library: () => void;
  on_info: () => void;
  on_inspector: () => void;
  on_settings: () => void;
  on_direction: () => void;
  on_hide: () => void;
}

export function ReaderOverlay(props: ReaderOverlayProps) {
  const next_direction = props.orientation === 'portrait' ? 'landscape' : 'portrait';
  return <header className="reader-overlay" aria-label="Reading controls">
    <div className="reader-overlay-navigation">
      <button ref={props.library_button_ref} className="icon-button" type="button" aria-label="Open paper library" onClick={props.on_library}><Library size={20} /></button>
      <button className="icon-button" type="button" aria-label="Go back to previous reading location" disabled={!props.can_go_back || props.busy} onClick={props.on_back}><ArrowLeft size={20} /></button>
      <button className="icon-button" type="button" aria-label="Go forward to next reading location" disabled={!props.can_go_forward || props.busy} onClick={props.on_forward}><ArrowRight size={20} /></button>
      <button className="reader-overlay-title" type="button" onClick={props.on_info} aria-label="Show paper abstract and metadata"><span>{props.paper.title}</span><small>arXiv:{props.paper.arxiv_id}v{props.paper.arxiv_version}</small></button>
      <button className="icon-button" type="button" aria-label="Hide reading controls" onClick={props.on_hide}><X size={20} /></button>
    </div>
    <div className="reader-overlay-actions">
      <button type="button" aria-label="Show paper information" onClick={props.on_info}><Info size={17} /><span>Info</span></button>
      <button type="button" aria-controls="paper-inspector" aria-expanded={props.inspector_open} aria-label={props.inspector_open ? 'Close references and notes panel' : 'Open references and notes panel'} onClick={props.on_inspector}>{props.inspector_open ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}<span>Refs & notes</span></button>
      {props.supports_orientation && <button type="button" aria-label={`Switch viewer to ${next_direction}`} disabled={props.orientation_pending} onClick={props.on_direction}>{props.orientation_pending ? <LoaderCircle className="spin" size={17} /> : next_direction === 'landscape' ? <RectangleHorizontal size={17} /> : <Smartphone size={17} />}<span>{next_direction === 'landscape' ? 'Landscape' : 'Portrait'}</span></button>}
      <button type="button" aria-label="AI provider settings" onClick={props.on_settings}><Settings2 size={17} /></button>
    </div>
  </header>;
}
