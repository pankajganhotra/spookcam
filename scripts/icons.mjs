// Renders public/icons/icon.svg to the PNG sizes the manifest needs.
import puppeteer from 'puppeteer';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../public/icons');
const svg = await readFile(resolve(dir, 'icon.svg'), 'utf8');
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 128]) {
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: resolve(dir, `icon${size}.png`), omitBackground: true });
  console.log(`icon${size}.png`);
}
await browser.close();
