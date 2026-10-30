// Renders every scare sound offline in Chrome and checks it is audible and not clipping.
// Usage: node test/sfx-test.mjs
import * as esbuild from 'esbuild';
import puppeteer from 'puppeteer';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { outputFiles } = await esbuild.build({
  entryPoints: [resolve(root, 'src/engine/sfx.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'SFX',
  write: false,
});
const KINDS = ['jumpscare', 'jaw', 'eyes', 'melt', 'twitch', 'echo', 'figure', 'flash', 'vanish', 'return'];

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({ headless: true, pipe: true });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: outputFiles[0].text });
  for (const kind of KINDS) {
    const r = await page.evaluate((k) => SFX.measure(k), kind);
    check(r.rms > 0.004 && r.peak > 0.05 && r.peak <= 1.2, `${kind}: peak ${r.peak.toFixed(2)}, rms ${r.rms.toFixed(3)} over ${r.seconds}s`);
  }
} finally {
  await browser.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall sound checks passed');
process.exit(failures ? 1 : 0);
