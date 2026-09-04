// Read-only environment and engine preflight.  It deliberately does not run
// git or mutate the engine checkout.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectEngine, resolveEngineRoot, engineFingerprint } from './engine.mjs';
import { startServer } from './server.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const arenaRoot = join(here, '..');
const runtime = join(arenaRoot, 'runtime');
const port = Number(process.env.XB_DOCTOR_PORT || 0);
const root = resolveEngineRoot();
const report = {
  schema_version: 'doctor.v1',
  checked_at: new Date().toISOString(),
  cwd: process.cwd(),
  engine_root: root,
  engine_root_source: process.env.XB_ENGINE_ROOT ? 'XB_ENGINE_ROOT' : 'default',
  node: process.version,
  checks: {},
};

const inspection = await inspectEngine(root);
report.checks.required_files = inspection;
report.engine_fingerprint = inspection.ready ? await engineFingerprint(root) : null;

let server = null;
try {
  server = await startServer({ root, port });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const response = await fetch(`http://127.0.0.1:${actualPort}/index.html`);
  report.checks.static_server = { ok: response.status === 200, status: response.status, port: actualPort };
  await response.arrayBuffer();
} catch (error) {
  report.checks.static_server = { ok: false, error: String(error) };
} finally {
  server?.close();
}

report.ok = !!report.checks.required_files.ready && !!report.checks.static_server?.ok;
await mkdir(runtime, { recursive: true });
await writeFile(join(runtime, 'doctor.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
