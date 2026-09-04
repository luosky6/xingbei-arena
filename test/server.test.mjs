import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../bridge/server.mjs';

test('static server exposes arena modules through a read-only prefix', async () => {
  const server = await startServer({ port: 0 });
  try {
    const port = server.address().port;
    const moduleResponse = await fetch(`http://127.0.0.1:${port}/__arena/ai-overlay/valueFn.js`);
    assert.equal(moduleResponse.status, 200);
    assert.match(await moduleResponse.text(), /stateValue/);
    const themeResponse = await fetch(`http://127.0.0.1:${port}/__arena/ui-overlay/modern-theme.css`);
    assert.equal(themeResponse.status, 200);
    assert.match(await themeResponse.text(), /xb-modern/);

    const traversalResponse = await fetch(`http://127.0.0.1:${port}/__arena/..%2fnoname.js`);
    assert.ok([400, 403].includes(traversalResponse.status));
  } finally {
    server.close();
  }
});
