import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { zipSync } from 'fflate';
import { glob } from 'tinyglobby';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plugin lives at site/scripts/, so repo root is two levels up.
const repoRoot = path.resolve(__dirname, '..', '..');
const publicDir = path.resolve(__dirname, '..', 'public');

const INCLUDE_PATTERNS = [
  'site/src/**/*.{ts,tsx,css,mdx,md,json}',
  'site/astro.config.mjs',
  'site/package.json',
  'site/tsconfig.json',
  'CLAUDE.md',
  '*.md',
  // WHY: docs/** previously globbed without an extension filter, which
  // pulled binary screenshots (e.g. PNG) into the OPFS sourcecode mirror.
  // Binary content blows up ReadLines output and amplifies regex DoS surface
  // in the search worker. Restrict to text-only docs (no SVGs in repo).
  'docs/**/*.{md,mdx,txt,html}',
];

const EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.astro/**',
  '**/models/**',
  '**/.env*',
  'site/public/sourcecode.*',
];

const MAX_ZIP_BYTES = 5 * 1024 * 1024;
// WHY: per-file cap protects the OPFS mirror from huge JSON fixtures or
// stray text blobs. ReadLines / search worker assume reasonable file sizes;
// a multi-megabyte file would blow past LLM context windows and stall regex.
const MAX_FILE_BYTES = 256 * 1024;

let promise = null;

function tryGitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (!sha) return null;

    let dirty = false;
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (status.length > 0) dirty = true;
    } catch {
      // ignore — keep sha clean
    }

    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

function fallbackSha(sortedPaths, input) {
  const hash = crypto.createHash('sha256');
  for (const p of sortedPaths) {
    const buf = input[p];
    hash.update(p);
    hash.update('\0');
    hash.update(String(buf.length));
    hash.update('\0');
    hash.update(buf);
    hash.update('\0');
  }
  return `${hash.digest('hex').slice(0, 12)}-nogit`;
}

async function writeArtifacts() {
  const files = await glob(INCLUDE_PATTERNS, {
    cwd: repoRoot,
    ignore: EXCLUDE_PATTERNS,
    onlyFiles: true,
    dot: false,
  });

  const candidatePaths = [...new Set(files)].sort();
  const input = {};
  const sortedPaths = [];
  for (const rel of candidatePaths) {
    const abs = path.join(repoRoot, rel);
    // WHY: stat first so we can skip oversized files without buffering them.
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) {
      console.warn(
        `[sourcecode] skipping ${rel}: ${st.size} bytes exceeds ${MAX_FILE_BYTES} byte cap`,
      );
      continue;
    }
    input[rel] = fs.readFileSync(abs);
    sortedPaths.push(rel);
  }

  const zipped = zipSync(input, { level: 6 });

  if (zipped.byteLength > MAX_ZIP_BYTES) {
    const summary = sortedPaths.slice(0, 20).join(', ');
    throw new Error(
      `[sourcecode] zip too large: ${zipped.byteLength} bytes (> ${MAX_ZIP_BYTES}). ` +
        `${sortedPaths.length} files included. First 20: ${summary}`,
    );
  }

  const sha = tryGitSha() ?? fallbackSha(sortedPaths, input);

  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'sourcecode.zip'), zipped);
  fs.writeFileSync(path.join(publicDir, 'sourcecode.sha'), sha);

  const kb = (zipped.byteLength / 1024).toFixed(1);
  console.log(
    `[sourcecode] wrote sourcecode.zip (${sortedPaths.length} files, ${kb} KB) sha=${sha}`,
  );
}

function writeOnce() {
  promise ??= writeArtifacts();
  return promise;
}

export default function sourcecodePlugin() {
  return {
    name: 'haw-sourcecode',
    buildStart() {
      return writeOnce();
    },
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        writeOnce().catch((err) => {
          console.error('[sourcecode] failed:', err);
        });
      });
    },
  };
}
