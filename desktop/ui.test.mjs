// Machine check for the desktop renderer. Boots the real backend on a random
// port and asserts the shipped DOM anchors, static assets, and contract calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.VERITY_DESKTOP_DATA ??= mkdtempSync(join(tmpdir(), 'verity-ui-test-'));

const { startServer } = await import('./server.mjs');

function listen(server) {
  return new Promise(resolve => {
    if (server.listening) resolve();
    else server.once('listening', resolve);
  });
}

async function withServer(run) {
  const { server } = startServer(0);
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('index.html ships every DOM anchor the shell and composer contract require', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/');
    assert.equal(response.status, 200, 'GET / serves the renderer');
    const html = await response.text();
    for (const anchor of ['id="app"', 'id="thread-list"', 'id="goal"', 'id="send"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    for (const klass of ['sidebar', 'transcript', 'composer', 'context']) {
      assert.match(html, new RegExp(`class="[^"]*\\b${klass}\\b`), `index.html contains .${klass}`);
    }
    assert.ok(html.includes('href="style.css"'), 'index.html links style.css');
    assert.ok(html.includes('src="app.js"'), 'index.html links app.js');
  });
});

test('style.css and app.js are served with 200', async () => {
  await withServer(async base => {
    for (const asset of ['/style.css', '/app.js']) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200, `${asset} served`);
    }
  });
});

test('app.js calls the contract endpoints', async () => {
  await withServer(async base => {
    const source = await (await fetch(base + '/app.js')).text();
    assert.ok(source.includes('/api/state'), 'app.js reads /api/state');
    assert.ok(source.includes('/api/threads'), 'app.js calls /api/threads');
    assert.ok(source.includes('/api/tasks'), 'app.js reads /api/tasks');
    assert.ok(source.includes('/api/events'), 'app.js subscribes to /api/events');
    assert.match(source, /fetch\(\s*['"]\/api\/threads['"]\s*,\s*\{[^}]*method:\s*['"]POST['"]/, 'app.js posts to /api/threads');
  });
});
