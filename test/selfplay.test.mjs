import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('selfplay validates and applies explicit lineups instead of silently ignoring them', async () => {
  const source = await readFile(join(root, 'bridge', 'selfplay.mjs'), 'utf8');
  assert.match(source, /TEAM_A\.length !== EXPECTED_PLAYERS\[MODE\] \/ 2/);
  assert.match(source, /LINEUP_BOOTSTRAP/);
  assert.match(source, /__xbLineupError/);
  assert.match(source, /explicit lineup was not fully applied/);
  assert.match(source, /__xbLineupAssigned/);
  assert.match(source, /engine player-count mismatch/);
  assert.match(source, /game\.promises\?\.saveConfig/);
});

test('selfplay keeps timeout results separate from game losses', async () => {
  const source = await readFile(join(root, 'bridge', 'selfplay.mjs'), 'utf8');
  assert.match(source, /status: timedOut \? 'timeout' : 'error'/);
  assert.match(source, /MATCH_TIMEOUT_MS/);
  assert.match(source, /if \(fail > 0\) process\.exitCode = 1/);
});
