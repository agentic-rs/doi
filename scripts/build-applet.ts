import './build-applet-ai.ts';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const assets: Record<string, string> = {};
for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
  for (const name of await readdir(`node_modules/pdfjs-dist/${directory}`)) {
    if (!/\.(bcmap|pfb|ttf|wasm)$/.test(name)) continue;
    assets[`${directory}/${name}`] = (await readFile(`node_modules/pdfjs-dist/${directory}/${name}`)).toString('base64');
  }
}
await writeFile('applet/generated/pdf-assets.json', JSON.stringify(assets));
execFileSync('pnpm', ['exec', 'tsc', '--noEmit'], { stdio: 'inherit' });
const wasm = (await readFile('applet/generated/doi_ai_bg.wasm')).toString('base64');
const output = await build({
  entryPoints: ['applet/src/main.tsx'], bundle: true, write: false, outdir: 'artifacts/doi',
  format: 'iife', target: ['es2022', 'safari18'], minify: true,
  define: { __DOI_WASM__: JSON.stringify(wasm), 'process.env.NODE_ENV': '"production"', 'import.meta.url': '"apell:embedded"' },
});
const javascript = output.outputFiles.find((file) => file.path.endsWith('.js'))!.text;
const css = output.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
const html = `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>Paper Reader</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><div id="root"></div><script>${javascript.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
const package_metadata = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
const manifest = { schema_version: 1, api_version: 2, applet_id: 'doi', name: 'Paper Reader', version: package_metadata.version, permissions: ['sqlite', 'llm', 'http', 'fs', 'config', 'device'] };
const staging = 'artifacts/package';
await mkdir(staging, { recursive: true });
await writeFile(staging + '/manifest.json', JSON.stringify(manifest));
await writeFile(staging + '/index.html', html);
await copyFile('assets/icon.png', staging + '/icon.png');
const packer = process.env.APELL_BIN ?? 'apell';
execFileSync(packer, ['pack', staging, '--output', 'artifacts/doi.apel'], { stdio: 'inherit' });
const bundle = await readFile('artifacts/doi.apel');
await writeFile('artifacts/doi.sha256', createHash('sha256').update(bundle).digest('hex') + '  doi.apel\n');
console.log('Paper Reader .apel package built.');
