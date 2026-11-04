import init from '../generated/doi_ai';
import './pdf';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../src/App';
import '../../src/styles.css';
import { collectGarbage } from './backend';

declare const __DOI_WASM__: string;

async function main() {
  await init({ module_or_path: Uint8Array.from(atob(__DOI_WASM__), (char) => char.charCodeAt(0)) });
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
  if (window.parent !== window) void collectGarbage().catch(() => {});
}

void main().catch((error) => {
  document.getElementById('root')!.textContent = `Paper Reader could not start: ${String(error)}`;
});
