// Shared engine resolution and immutable identity helpers.
// The arena never writes to the engine tree.  Use XB_ENGINE_ROOT to point at
// another checkout when comparing engine revisions.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ARENA_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_ENGINE_ROOT = resolve(ARENA_ROOT, '..', 'noname_xingbei');

export function resolveEngineRoot({ mustExist = true } = {}) {
  const configured = process.env.XB_ENGINE_ROOT;
  const root = resolve(configured ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured)) : DEFAULT_ENGINE_ROOT);
  if (mustExist) {
    if (!root || !root.trim()) throw new Error('XB_ENGINE_ROOT resolved to an empty path');
  }
  return root;
}

export function requiredEngineFiles(root = resolveEngineRoot()) {
  return [
    'index.html',
    'noname.js',
    'mode/xingBei.js',
    'card/xingBei.js',
    'character/shiZhouNian.js',
  ].map(file => ({ file, path: join(root, ...file.split('/')) }));
}

export async function inspectEngine(root = resolveEngineRoot()) {
  const files = [];
  for (const item of requiredEngineFiles(root)) {
    const info = await stat(item.path).catch(() => null);
    files.push({ file: item.file, path: item.path, exists: !!info, bytes: info?.size ?? null });
  }
  return { root, files, ready: files.every(item => item.exists) };
}

export async function engineFingerprint(root = resolveEngineRoot()) {
  const hash = createHash('sha256');
  const included = [];
  for (const item of requiredEngineFiles(root)) {
    const data = await readFile(item.path).catch(() => null);
    if (!data) continue;
    hash.update(item.file);
    hash.update('\0');
    hash.update(data);
    included.push(item.file);
  }
  return `sha256:${hash.digest('hex')}`;
}

export function isWithinRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export const arenaRoot = ARENA_ROOT;
