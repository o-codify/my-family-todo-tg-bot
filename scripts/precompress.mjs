#!/usr/bin/env node
// Post-build pass for the Mini App bundle.
//
// The Mini App used to sit behind nginx, which gzipped responses on the
// fly. Now the API process serves it with @hono/node-server's serveStatic,
// which does not compress — it only *picks up* a pre-built `.br` / `.gz`
// sibling when `precompressed: true` is set.
//
// So we write those siblings here, at build time: better ratios than
// on-the-fly compression (we can afford max level) and zero per-request
// CPU. Only compressible, non-trivial files are worth the extra inodes.
//
// Usage: node scripts/precompress.mjs <dist-dir>

import { constants, brotliCompress, gzip } from 'node:zlib';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const root = process.argv[2];
if (!root) {
  console.error('usage: precompress <dir>');
  process.exit(1);
}

// Binary formats (png/jpg/woff2/…) are already compressed — re-compressing
// them costs inodes and gains nothing.
const COMPRESSIBLE = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.mjs',
  '.svg',
  '.txt',
  '.webmanifest',
  '.xml',
]);

// Below ~1 KB the HTTP framing dominates and compression can even grow the
// payload. Same threshold nginx's `gzip_min_length` used.
const MIN_BYTES = 1024;

let files = 0;
let rawBytes = 0;
let brBytes = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
    } else if (COMPRESSIBLE.has(extname(entry.name))) {
      await compress(full);
    }
  }
}

async function compress(file) {
  const { size } = await stat(file);
  if (size < MIN_BYTES) return;

  const buf = await readFile(file);
  const [br, gzipped] = await Promise.all([
    brotli(buf, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_SIZE_HINT]: size,
      },
    }),
    gz(buf, { level: 9 }),
  ]);

  // Skip anything that didn't actually shrink.
  if (br.length < size) await writeFile(`${file}.br`, br);
  if (gzipped.length < size) await writeFile(`${file}.gz`, gzipped);

  files += 1;
  rawBytes += size;
  brBytes += Math.min(br.length, size);
}

await walk(root);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `precompress: ${files} file(s), ${kb(rawBytes)} → ${kb(brBytes)} brotli ` +
    `(${rawBytes ? Math.round((1 - brBytes / rawBytes) * 100) : 0}% smaller)`,
);
