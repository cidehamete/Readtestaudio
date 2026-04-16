// Creates minimal stubs for gitignored vendor files so Turbopack can resolve them during build.
// The real files are served at runtime from /vendor/* (downloaded separately).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const stubs = [
  {
    path: 'public/vendor/pdfjs/pdf.min.mjs',
    content: '// stub for SSR build — real file served at /vendor/pdfjs/pdf.min.mjs\n',
  },
  {
    path: 'public/vendor/simplecc/simplecc_wasm.js',
    content:
      '// stub for SSR build — real WASM loaded at runtime\n' +
      'export default async function init(_input) {}\n' +
      'export function simplecc(text, _variant) { return text; }\n',
  },
];

for (const stub of stubs) {
  const fullPath = path.join(root, stub.path);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, stub.content);
    console.log(`Created stub: ${stub.path}`);
  } else {
    console.log(`Exists (skipped): ${stub.path}`);
  }
}
