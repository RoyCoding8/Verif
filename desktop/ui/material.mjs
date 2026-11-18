// Deterministic selective Material Web bundle.
//
// Emits an ignored ESM asset at desktop/public/material.js that registers the
// official @material/web custom elements this migration adopts and applies the
// official typescale styles. The file is the single copy served to browsers and
// packed into the offline Electron build; nothing is vendored, and building
// requires only dev dependencies already installed by npm ci.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const esbuild = require('esbuild');

const OUT = join(here, '..', 'public', 'material.js');

// Explicit, stable-module imports only: no all.js, no labs, no CDN.
const imports = [
  '@material/web/button/filled-button.js',
  '@material/web/button/outlined-button.js',
  '@material/web/button/text-button.js',
  '@material/web/button/filled-tonal-button.js',
  '@material/web/iconbutton/icon-button.js',
  '@material/web/fab/fab.js',
  '@material/web/textfield/outlined-text-field.js',
  '@material/web/select/outlined-select.js',
  '@material/web/select/select-option.js',
  '@material/web/dialog/dialog.js',
  '@material/web/menu/menu.js',
  '@material/web/menu/menu-item.js',
  '@material/web/list/list.js',
  '@material/web/list/list-item.js',
  '@material/web/tabs/tabs.js',
  '@material/web/tabs/primary-tab.js',
  '@material/web/tabs/secondary-tab.js',
  '@material/web/radio/radio.js',
  '@material/web/divider/divider.js',
  '@material/web/progress/circular-progress.js',
  '@material/web/progress/linear-progress.js',
  '@material/web/ripple/ripple.js',
  '@material/web/focus/md-focus-ring.js',
];

// The typescale module only exports the stylesheet; official usage adopts it
// on the document.
const entry = imports.map((id) => `import ${JSON.stringify(id)};`).join('\n')
  + `\nimport { styles as typeScaleStyles } from ${JSON.stringify('@material/web/typography/md-typescale-styles.js')};`
  + `\ndocument.adoptedStyleSheets = [...document.adoptedStyleSheets, typeScaleStyles.styleSheet];\n`;

const result = await esbuild.build({
  stdin: { contents: entry, resolveDir: here, sourcefile: 'material-entry.mjs', loader: 'js' },
  outfile: OUT,
  format: 'esm',
  target: 'es2022',
  bundle: true,
  minify: true,
  legalComments: 'inline',
  logLevel: 'silent',
});

const bytes = (await stat(OUT)).size;
console.log(`material.js ${bytes} bytes, ${imports.length} modules, ${result.errors.length} errors`);
