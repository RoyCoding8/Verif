// Verity Desktop — smoke runner.
//
// Thin cross-platform launcher for the Electron smoke check:
// runs `electron desktop/main.mjs --smoke` and forwards its exit code.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

// Under plain Node the electron package exports the path to the binary.
const electronPath = require('electron');
if (typeof electronPath !== 'string') {
  console.error('smoke must run under node, not electron');
  process.exit(1);
}

// Never inherit ELECTRON_RUN_AS_NODE: the check needs the real Electron
// runtime, not the binary re-executed as plain Node.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [join(here, 'main.mjs'), '--smoke'], {
  stdio: 'inherit',
  env,
});

child.on('error', (error) => {
  console.error('failed to launch electron: ' + error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
