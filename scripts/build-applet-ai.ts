import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const manifest_path = 'crates/doi-ai/Cargo.toml';
execFileSync('cargo', [
  'build', '--locked', '--offline', '--release', '--target', 'wasm32-unknown-unknown',
  '--manifest-path', manifest_path,
], { stdio: 'inherit', env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${homedir()}=/build`, `--remap-path-prefix=${process.cwd()}=/doi`].join('\x1f') } });
execFileSync('wasm-bindgen', [
  'crates/doi-ai/target/wasm32-unknown-unknown/release/doi_ai.wasm',
  '--target', 'web', '--out-dir', 'applet/generated', '--out-name', 'doi_ai',
], { stdio: 'inherit' });
