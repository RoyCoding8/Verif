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
    const menuTag = html.match(/<md-menu[^>]*id="identity-menu"[^>]*>/)?.[0] ?? '';
    assert.ok(menuTag.includes('anchor="identity-btn"'),
      'the identity menu anchors declaratively to the identity button');
    assert.ok(!/\bopen\b/.test(menuTag), 'the identity menu ships closed');
    assert.ok(html.includes('<md-menu-item id="menu-settings"'),
      'the Settings entry is a Material menu item');
    for (const anchor of ['id="settings-nav-general"', 'id="settings-nav-appearance"', 'id="settings-nav-providers"', 'id="settings-section-general"', 'id="settings-section-appearance"', 'id="settings-section-providers"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    // Providers: three wire protocols, key entry, list, save/cancel, and the
    // approved spending ceiling on General.
    for (const anchor of ['id="provider-list"', 'id="provider-add"', 'id="provider-form"', 'id="provider-label"', 'id="provider-protocol"', 'id="provider-base-url"', 'id="provider-model"', 'id="provider-api-key"', 'id="provider-apply"', 'id="provider-cancel-form"', 'id="provider-save-changes"', 'id="provider-revert"', 'id="provider-error"', 'id="provider-dirty"', 'id="key-indicator"', 'id="cred-status"']) {
      assert.ok(html.includes(anchor), `index.html contains ${anchor}`);
    }
    // The Providers form is real Material Web controls: five fields, the
    // protocol dropdown, and typed form actions.
    for (const [id, label] of [['provider-label', 'Name'], ['provider-base-url', 'Base URL'], ['provider-model', 'Model'], ['provider-api-key', 'API key']]) {
      const tag = html.match(new RegExp(`<md-outlined-text-field[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      assert.ok(tag.includes(`label="${label}"`), `${id} is a Material outlined text field labeled "${label}"`);
    }
    const keyTag = html.match(/<md-outlined-text-field[^>]*id="provider-api-key"[^>]*>/)?.[0] ?? '';
    assert.ok(keyTag.includes('type="password"') && keyTag.includes('autocomplete="new-password"'),
      'the API key is a transient password field, never a saved or auto-filled one');
    const protocolTag = html.match(/<md-outlined-select[^>]*id="provider-protocol"[^>]*>/)?.[0] ?? '';
    assert.ok(protocolTag.includes('label="Protocol"'), 'the protocol chooser is a Material outlined select labeled "Protocol"');
    for (const protocol of ['openai-completions', 'openai-responses', 'anthropic-messages']) {
      assert.match(html, new RegExp(`<md-select-option[^>]*value="${protocol}"`), `protocol chooser offers ${protocol}`);
    }
    for (const [id, tag] of [['provider-apply', 'md-filled-button'], ['provider-save-changes', 'md-filled-button'], ['provider-cancel-form', 'md-text-button'], ['provider-revert', 'md-text-button'], ['provider-add', 'md-text-button']]) {
      const button = html.match(new RegExp(`<${tag}[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      assert.ok(button.includes('type="button"'), `${id} is a ${tag} that never submits the form`);
    }
    const formHtml = html.match(/<form[^>]*id="provider-form"[\s\S]*?<\/form>/)?.[0] ?? '';
    assert.ok(!/<input|<select/.test(formHtml), 'the provider form ships no hand-rolled input or select');
    assert.ok(html.includes('<md-dialog'), 'the settings dialog is a Material dialog');
    // Theme choices are native radios in a radiogroup so arrow keys move the
    // selection and the checked radio carries the selected state.
    assert.ok(html.includes('role="radiogroup"') && html.includes('type="radio" name="appearance"'),
      'theme choices are native radios in a radiogroup');
    // The General ceiling is a real Material numeric text field; no
    // hand-rolled outlined-field imitation survives its slice.
    const ceilingTag = html.match(/<md-outlined-text-field[^>]*id="ceiling-input"[^>]*>/)?.[0] ?? '';
    assert.ok(ceilingTag.includes('type="number"') && ceilingTag.includes('label="Approved spending ceiling'),
      'the spending ceiling is a Material numeric text field with its label');
    assert.ok(!/<input[^>]*id="ceiling-input"/.test(html), 'the ceiling ships no hand-rolled input');
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
    assert.match(html, /<md-select-option value="fixture" headline="Demo" selected>/,
      'the mode chooser opens on Demo while keeping the fixture payload value');
    assert.ok(html.includes('<md-outlined-text-field id="goal" type="textarea" rows="1"'),
      'the composer goal is a Material textarea field, one row tall');
    for (const [id, label] of [['task', 'Task'], ['mode', 'Mode']]) {
      const tag = html.match(new RegExp(`<md-outlined-select[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
      assert.ok(tag.includes(`label="${label}"`), `${id} is a Material outlined select labeled "${label}"`);
    }
    assert.ok(html.includes('<md-linear-progress id="run-progress" indeterminate hidden>'),
      'live runs show an indeterminate Material progress bar');
    assert.ok(html.includes('href="style.css"'), 'index.html links style.css')
    assert.equal(html.split('src="/material.js"').length - 1, 1,
      'index.html references the local Material bundle exactly once');
    assert.ok(/<script src="app\.js" defer><\/script>/.test(html), 'app.js stays classic and deferred');
    assert.ok(html.indexOf('src="/material.js"') < html.indexOf('src="app.js"'),
      'the Material module registers its elements before app.js runs');
  });
});

test('the MD3 palette is emitted by the generated bundle, never hand-authored, offline', async () => {
  await withServer(async base => {
    const css = await (await fetch(base + '/style.css')).text();
    const html = await (await fetch(base + '/')).text();
    const material = await (await fetch(base + '/material.js')).text();
    // Provenance gate: the MD3 color roles come from the official Material Color
    // Utilities palette generated into the bundle at build time. style.css must
    // hand-author no --md-sys-color-* role, so a copied table can never shadow
    // (or contradict) the emitted colors the renderer actually uses.
    assert.ok(!/^\s*--md-sys-color-[a-z-]+\s*:/m.test(css),
      'style.css defines no hand-authored --md-sys-color-* role that could shadow the generated palette');
    // Emitted (live) roles: the served bundle carries the generated light and
    // dark schemes its adopted stylesheet provides to the app.
    for (const role of ['primary', 'on-primary', 'surface', 'on-surface', 'surface-container', 'outline-variant']) {
      assert.ok(material.includes(`--md-sys-color-${role}:`), `the generated bundle emits --md-sys-color-${role}`);
    }
    assert.ok(material.includes('[data-theme'), 'the generated palette defines a dark scheme alongside light');
    // App semantic extensions (success/warning) have no MD3 core slot and stay
    // hand-defined in both schemes.
    for (const token of ['--md-ext-success', '--md-ext-warning', '--md-ext-success-container']) {
      assert.ok(css.includes(token + ':'), `style.css defines ${token}`);
    }
    const darkStart = css.indexOf('[data-theme="dark"]');
    assert.ok(darkStart !== -1 && css.slice(darkStart).includes('--md-ext-warning:'),
      'the dark scheme redefines the semantic extensions');
    // State layers are color overlays; the self-hosted Roboto leads the stack so
    // it actually renders; the hand-rolled outlined-field imitation stays gone.
    assert.ok(css.includes('color-mix'), 'state layers are applied as color overlays');
    assert.ok(css.includes('--sans: "Roboto", system-ui'), 'Roboto is ahead of system-ui in the base font');
    assert.ok(!css.includes('.md-field'), 'no hand-rolled outlined-field imitation CSS remains');
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
