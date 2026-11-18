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
    for (const anchor of ['id="settings-dialog"', 'id="theme-light"', 'id="theme-dark"', 'id="theme-system"', 'id="file-view"', 'id="file-close"', 'id="route-label"', 'id="nav-toggle"', 'id="inspector-toggle"', 'id="ctx-details"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    // Bottom-left local identity opens an upward menu whose Settings item
    // reaches the categorized settings dialog; the top bar has no gear.
    assert.ok(!html.includes('id="settings-btn"'), 'settings entry is the identity menu, not a top-bar gear');
    for (const anchor of ['id="identity-btn"', 'aria-haspopup="menu"', 'aria-expanded="false"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    assert.match(html, /id="identity-menu"[^>]*hidden/, 'the identity menu ships closed');
    for (const anchor of ['id="settings-nav-general"', 'id="settings-nav-appearance"', 'id="settings-nav-providers"', 'id="settings-section-general"', 'id="settings-section-appearance"', 'id="settings-section-providers"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    // Providers: three wire protocols, key entry, list, save/cancel, and the
    // approved spending ceiling on General.
    for (const anchor of ['id="provider-list"', 'id="provider-add"', 'id="provider-form"', 'id="provider-label"', 'id="provider-protocol"', 'id="provider-base-url"', 'id="provider-model"', 'id="provider-api-key"', 'id="provider-apply"', 'id="provider-cancel-form"', 'id="provider-save-changes"', 'id="provider-revert"', 'id="provider-error"', 'id="provider-dirty"', 'id="key-indicator"', 'id="cred-status"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      assert.ok(html.includes(`value="${protocol}"`), `protocol chooser offers ${protocol}`);
    }
    assert.ok(html.includes('type="password"') && html.includes('autocomplete="new-password"'),
      'the API key is a transient password input, never a saved/auto-filled field');
    // Theme choices are native radios in a radiogroup so arrow keys move the
    // selection and the checked radio carries the selected state.
    assert.ok(html.includes('role="radiogroup"') && html.includes('type="radio" name="appearance"'),
      'theme choices are native radios in a radiogroup');
    // Settings text fields use the MD3 outlined field wrapper with floating
    // labels that keep their for= accessible names.
    assert.ok(html.includes('class="md-field"'), 'Settings fields use the MD3 outlined field wrapper');
    for (const fieldId of ['ceiling-input', 'provider-label', 'provider-protocol', 'provider-base-url', 'provider-model', 'provider-api-key']) {
      assert.match(html, new RegExp(`<label for="${fieldId}"`), `the outlined field label keeps for=${fieldId}`);
    }
    assert.ok(html.includes('id="ceiling-input"') && html.includes('id="general-save"'), 'General exposes the spending ceiling');
    // Startup recovery and composer status.
    for (const anchor of ['id="boot-notice"', 'id="boot-retry"', 'id="boot-text"', 'id="boot-detail"', 'id="provider-status"', 'id="provider-setup"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    assert.ok(html.includes('id="demo-controls"'), 'demo/testing controls are demoted into a labeled secondary section');
    // Three-pane shell: the file viewer lives inside the right inspector
    // rail so opening a file replaces inspector content instead of adding
    // a fourth column next to chat.
    const contextIndex = html.indexOf('id="context"');
    const fileIndex = html.indexOf('id="file-view"');
    const detailsIndex = html.indexOf('id="ctx-details"');
    const asideClose = html.indexOf('</aside>', contextIndex);
    assert.ok(contextIndex !== -1 && fileIndex > contextIndex && fileIndex < asideClose,
      'file-view is nested inside the inspector aside');
    assert.ok(detailsIndex > contextIndex && detailsIndex < fileIndex,
      'inspector details precede the file view inside the rail');
    assert.ok(!html.includes('id="ctx-title"'), 'inspector does not repeat the thread title');
    assert.ok(html.includes('<option value="fixture">Demo</option>'),
      'the task chooser reads Demo while keeping the fixture payload value');
    assert.ok(html.includes('rows="1"'), 'composer textarea is one row tall');
    assert.ok(html.includes('aria-label="Task"') && html.includes('aria-label="Mode"'),
      'composer selects keep accessible names without visible labels');
    assert.ok(html.includes('href="style.css"'), 'index.html links style.css')
    assert.ok(html.includes('src="app.js"'), 'index.html links app.js');
  });
});

test('the shipped theme is the MD3 token foundation, self-contained offline', async () => {
  await withServer(async base => {
    const css = await (await fetch(base + '/style.css')).text();
    const html = await (await fetch(base + '/')).text();
    // Official MD3 color-role token names from material-web tokens/_md-sys-color.scss.
    for (const role of ['--md-sys-color-primary', '--md-sys-color-on-primary', '--md-sys-color-primary-container',
      '--md-sys-color-secondary-container', '--md-sys-color-error', '--md-sys-color-error-container',
      '--md-sys-color-surface-container-lowest', '--md-sys-color-surface-container-low', '--md-sys-color-surface-container',
      '--md-sys-color-surface-container-high', '--md-sys-color-surface-container-highest', '--md-sys-color-on-surface',
      '--md-sys-color-on-surface-variant', '--md-sys-color-outline', '--md-sys-color-outline-variant']) {
      assert.ok(css.includes(role + ':'), `style.css defines ${role} in :root`);
      const darkStart = css.indexOf('[data-theme="dark"]');
      assert.ok(css.slice(darkStart).includes(role), `the dark scheme redefines ${role}`);
    }
    // Scrim and shadow are scheme-independent: defined once from the core set.
    for (const role of ['--md-sys-color-scrim', '--md-sys-color-shadow']) {
      assert.ok(css.includes(role + ':'), `style.css defines ${role} in :root`);
    }
    for (const token of ['--md-sys-shape-corner-full', '--md-sys-shape-corner-extra-large',
      '--md-sys-elevation-level1', '--md-sys-elevation-level3',
      '--md-sys-typescale-label-large', '--md-sys-typescale-headline-small', '--md-sys-state-hover']) {
      assert.ok(css.includes(token), `style.css defines ${token}`);
    }
    // State layers use the official hover/focus/pressed opacities.
    assert.ok(css.includes('color-mix'), 'state layers are applied as color overlays');
    // The self-hosted Roboto leads the stack so it actually renders.
    assert.ok(css.includes('--sans: "Roboto", system-ui'), 'Roboto is ahead of system-ui in the base font');
    // MD3 outlined field metrics: 56px container height.
    assert.ok(/\.md-field input, \.md-field select\s*{[^}]*height: 56px/.test(css),
      'MD3 outlined field containers are 56px tall');
    // Packaged runtime must work offline: no CDN or external asset anywhere.
    for (const source of [css, html]) {
      assert.ok(!/https:\/\/[^\s"')]*\.(css|js|woff2?)/.test(source), 'no external stylesheet/script/font URLs');
      assert.ok(!source.includes('cdn.'), 'no CDN references');
    }
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

test('the self-hosted Roboto font is served as font/woff2', async () => {
  await withServer(async base => {
    const response = await fetch(base + '/fonts/roboto-latin.woff2');
    assert.equal(response.status, 200, 'font asset served');
    assert.equal(response.headers.get('content-type'), 'font/woff2');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.slice(0, 4).toString(), 'wOF2', 'served bytes are a real woff2');
  });
});

test('app.js reads the contract endpoints', async () => {
  await withServer(async base => {
    const source = await (await fetch(base + '/app.js')).text();
    assert.ok(source.includes('/api/state'), 'app.js reads /api/state');
    assert.ok(source.includes('/api/threads'), 'app.js calls /api/threads');
    assert.ok(source.includes('/api/tasks'), 'app.js reads /api/tasks');
    assert.ok(source.includes('/api/events'), 'app.js subscribes to /api/events');
  });
});
