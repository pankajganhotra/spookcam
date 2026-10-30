// Hand-tracking check: real gesture photos as the fake camera, magic + claws on.
// Usage: npm run build && node test/hands-e2e.mjs   → test/out/hands-*.jpg
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES = [
  { image: 'pointing_up.jpg', expect: 'point' },
  { image: 'fist.jpg', expect: 'fist' },
];

const server = createServer(async (_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(await readFile(resolve(root, 'test/page.html')));
}).listen(0);

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (const { image, expect } of CASES) {
  const src = resolve(root, 'test/fixtures', image);
  try {
    await access(src);
  } catch {
    console.log(`– ${image} missing (run npm run fetch-assets), skipped`);
    continue;
  }
  const y4m = resolve(root, `test/fixtures/${image.replace('.jpg', '')}.y4m`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-loop', '1', '-i', src, '-vf', 'scale=640:480:force_original_aspect_ratio=increase,crop=640:480,format=yuv420p', '-t', '3', '-r', '30', y4m]);
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    protocolTimeout: 120000,
    enableExtensions: [resolve(root, 'dist')],
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--enable-unsafe-swiftshader'],
  });
  try {
    const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
    const page = await browser.newPage();
    await page.goto(`http://localhost:${server.address().port}/`);
    await page.evaluate(() => window.ready);
    await sw.evaluate(() => chrome.storage.local.set({ 'spookcam.settings': { magic: true, claws: true } }));
    let st;
    for (let i = 0; i < 120; i++) {
      st = await sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: 'http://localhost/*' });
        return chrome.tabs.sendMessage(t.id, { type: 'get-status' });
      }).catch(() => null);
      if (st?.gestures?.includes(expect)) break;
      await wait(250);
    }
    check(!!st?.hands, `${image}: hand tracked (${st?.hands ?? 0})`);
    check(!!st?.gestures?.includes(expect), `${image}: recognised as “${expect}” (got ${JSON.stringify(st?.gestures)})`);
    await wait(800);
    const data = await page.evaluate(() => window.grab());
    await writeFile(resolve(root, `test/out/hands-${expect}.jpg`), Buffer.from(data.split(',')[1], 'base64'));

    // Over the Void backdrop the hand must stay visible (segmentation alone tends to drop it).
    await sw.evaluate(() => chrome.storage.local.get('spookcam.settings').then(({ ['spookcam.settings']: s }) => chrome.storage.local.set({ 'spookcam.settings': { ...s, backdrop: 'void' } })));
    await wait(3000);
    const handLuma = await page.evaluate(() => {
      const v = document.getElementById('v');
      const c = document.createElement('canvas');
      c.width = 64; c.height = 48;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 64, 48);
      const px = ctx.getImageData(24, 18, 16, 12).data; // centre of frame, where the hand is
      let sum = 0;
      for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
      return sum / (px.length / 4);
    });
    check(handLuma > 60, `${image}: hand stays visible over the Void backdrop (brightness ${handLuma.toFixed(0)})`);
    const vdata = await page.evaluate(() => window.grab());
    await writeFile(resolve(root, `test/out/hands-${expect}-void.jpg`), Buffer.from(vdata.split(',')[1], 'base64'));
    if (expect === 'point') {
      await page.evaluate(() => (window.__spookcamForce = { gesture: 'palm' }));
      await wait(1500);
      const pdata = await page.evaluate(() => window.grab());
      await writeFile(resolve(root, 'test/out/hands-palm-fingers.jpg'), Buffer.from(pdata.split(',')[1], 'base64'));
      await page.evaluate(() => (window.__spookcamForce = {}));
    }
  } finally {
    await browser.close();
  }
}
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall hand checks passed');
process.exit(failures ? 1 : 0);
