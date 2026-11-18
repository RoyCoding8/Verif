// Deterministic selective Material Web bundle with generated MD3 color roles.
//
// Emits an ignored ESM asset at desktop/public/material.js that registers the
// official @material/web custom elements this migration adopts, applies the
// official typescale styles, and adopts the official generated color roles.
//
// Color roles are produced at build time by Google's official
// @material/material-color-utilities (pinned exact version in package.json,
// current dynamic color spec), Tonal Spot scheme — the Material Theme Builder
// default algorithm — with seed #0b57d0, light and dark. Only the generated
// CSS travels into the bundle: no runtime color utilities, no duplicated
// palette in app CSS. The file is the single copy served to browsers and
// packed into the offline Electron build; nothing is vendored, no CDN.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const esbuild = require('esbuild');

const OUT = join(here, '..', 'public', 'material.js');
const SEED = '#0b57d0';

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

// Step 1: generate the color roles. The generator imports the pinned
// utilities, resolves every official dynamic color role for both schemes, and
// exports the resulting CSS plus the per-role hex values. Bundled through
// esbuild because the published package uses extensionless internal imports
// that plain Node cannot load; the utilities themselves stay out of the
// browser bundle.
const generatorEntry = `
import { argbFromHex, hexFromArgb, Hct, MaterialDynamicColors, SchemeTonalSpot } from '@material/material-color-utilities';

const seed = argbFromHex(${JSON.stringify(SEED)});
const kebab = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

// Official color roles only: the scheme config entries on the module (colorSpec,
// palette key colors) carry no getArgb and are skipped automatically.
const roles = Object.entries(MaterialDynamicColors)
  .filter(([, color]) => typeof color.getArgb === 'function')
  .map(([name]) => name);

const values = (scheme) => Object.fromEntries(roles.map((name) =>
  [kebab(name), hexFromArgb(MaterialDynamicColors[name].getArgb(scheme))]));

const light = new SchemeTonalSpot(Hct.fromInt(seed), false, 0);
const dark = new SchemeTonalSpot(Hct.fromInt(seed), true, 0);

const block = (scheme) => Object.entries(values(scheme))
  .map(([role, hex]) => \`  --md-sys-color-\${role}: \${hex};\`).join('\\n');

const css = \`:root {
  color-scheme: light;
\${block(light)}
}

:root[data-theme="dark"] {
  color-scheme: dark;
\${block(dark)}
}
\`;

export default { css, light: values(light), dark: values(dark), roleCount: roles.length };
`;

const generatorBuild = await esbuild.build({
  stdin: { contents: generatorEntry, resolveDir: here, sourcefile: 'md3-color-generate.mjs', loader: 'js' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  logLevel: 'silent',
});
const generator = { exports: {} };
new Function('module', 'exports', 'require', generatorBuild.outputFiles[0].text)(generator, generator.exports, require);
const theme = generator.exports.default ?? generator.exports;

// WCAG 2.1 AA (normal text, 4.5:1) for the label pairs this renderer and the
// Material controls put on screen, in both themes. The ratio is computed from
// the emitted sRGB values, the same definition contrast tools apply.
const luminance = (hex) => {
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const labelPairs = [
  ['on-surface', 'surface', 'body text'],
  ['on-surface-variant', 'surface', 'hint and label text'],
  ['primary', 'surface', 'text button labels'],
  ['on-primary', 'primary', 'filled button labels'],
  ['on-primary-container', 'primary-container', 'container labels'],
];
for (const [schemeName, values] of [['light', theme.light], ['dark', theme.dark]]) {
  for (const [foreground, background, use] of labelPairs) {
    const ratio = contrast(luminance(values[foreground]), luminance(values[background]));
    if (!(ratio >= 4.5)) {
      console.error(`WCAG AA FAIL ${schemeName} ${use}: ${foreground} on ${background} = ${ratio.toFixed(2)}`);
      process.exit(1);
    }
  }
}

// Step 2: the served bundle. Component registrations first, then the generated
// theme adopted as a stylesheet, then the official typescale.
const entry = imports.map((id) => `import ${JSON.stringify(id)};`).join('\n')
  + `\nimport { styles as typeScaleStyles } from ${JSON.stringify('@material/web/typography/md-typescale-styles.js')};`
  + `\nconst themeCss = ${JSON.stringify(theme.css)};`
  + `\nconst themeSheet = new CSSStyleSheet();`
  + `\nthemeSheet.replaceSync(themeCss);`
  + `\ndocument.adoptedStyleSheets = [...document.adoptedStyleSheets, themeSheet, typeScaleStyles.styleSheet];\n`;

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
console.log(`theme: tonal-spot seed ${SEED}, ${theme.roleCount} roles, light+dark, WCAG AA ok`);
