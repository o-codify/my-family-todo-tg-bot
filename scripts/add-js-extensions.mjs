#!/usr/bin/env node
// Post-build pass: tsc with `module: ESNext` + `moduleResolution: Bundler`
// emits relative imports verbatim (no extensions). Plain Node ESM refuses
// to resolve those at runtime — `Cannot find module '/.../api-client'`.
//
// Walk the compiled `dist/` tree and rewrite every relative `import`/
// `export from` / dynamic `import()` to point at a real file: append
// `.js` when the target is a file, `/index.js` when it's a directory.
//
// We don't touch:
//   * bare-package imports (`grammy`, `@family-todo/shared`, …)
//   * imports that already carry an extension (`.js`, `.cjs`, `.json`, …)
//
// Usage: node scripts/add-js-extensions.mjs <dist-dir>

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: add-js-extensions <dir>');
  process.exit(1);
}

// Capture both `from '…'` and dynamic `import('…')` specifiers. The
// non-greedy match prevents the closing quote of the *next* string from
// being consumed when several imports share one line.
const IMPORT_RE = /(from\s+['"]|import\s*\(\s*['"])(\.\.?\/[^'"]+?)(['"])/g;
const HAS_EXT = /\.(json|js|mjs|cjs|node)$/;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith('.js')) await fix(full);
  }
}

async function fix(file) {
  const src = await readFile(file, 'utf8');
  const baseDir = dirname(file);
  let changed = false;
  const next = src.replace(IMPORT_RE, (full, pre, spec, post) => {
    if (HAS_EXT.test(spec)) return full;
    const abs = resolve(baseDir, spec);
    if (existsSync(`${abs}.js`)) {
      changed = true;
      return `${pre}${spec}.js${post}`;
    }
    if (existsSync(join(abs, 'index.js'))) {
      changed = true;
      return `${pre}${spec}/index.js${post}`;
    }
    return full;
  });
  if (changed) await writeFile(file, next);
}

await walk(root);
