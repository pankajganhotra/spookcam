// "Whole call" scare sounds: the jump scare must come out of the page's outgoing mic track.
// The fake mic is silent, so any signal on that track is SpookCam's sound effect.
// Usage: npm run build && node test/call-sound-e2e.mjs
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { toWav } from './mic-signal.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = createServer(async (_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(await readFile(resolve(root, 'test/page.html')));
}).listen(0);

// A silent microphone, so anything heard on the outgoing track is ours.
const silence = resolve(root, 'test/fixtures/silence.wav');
await writeFile(silence, toWav(new Float32Array(48000 * 2)));

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  headless: true,
  pipe: true,
  protocolTimeout: 120000,
  enableExtensions: [resolve(root, 'dist')],
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${resolve(root, 'test/fixtures/camera.y4m')}`, `--use-file-for-fake-audio-capture=${silence}`, '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
try {
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker')).worker();
  // Let first-install setup (which writes default settings) finish before overriding them.
  await new Promise((r) => setTimeout(r, 1500));
  await sw.evaluate(() => chrome.storage.local.set({ 'spookcam.settings': { sounds: 'call', soundVolume: 1, face: 'possessed' } }));
  if (process.env.DEBUG) console.log('stored', JSON.stringify(await sw.evaluate(() => chrome.storage.local.get('spookcam.settings'))));
  const page = await browser.newPage();
  if (process.env.DEBUG) page.on('console', (m) => m.text().includes('SpookCam') && console.log('[page]', m.text()));
  await page.goto(`http://localhost:${server.address().port}/?audio=1`);
  await page.evaluate(() => window.ready);
  await new Promise((r) => setTimeout(r, 4000));
  const mix = await page.evaluate(async () => {
    const tr = window.stream.getAudioTracks()[0];
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    ctx.createMediaStreamSource(new MediaStream([tr])).connect(an);
    const buf = new Float32Array(2048);
    const peakFor = async (ms) => {
      let max = 0;
      for (const t0 = performance.now(); performance.now() - t0 < ms; ) {
        an.getFloatTimeDomainData(buf);
        for (const v of buf) max = Math.max(max, Math.abs(v));
        await new Promise((r) => setTimeout(r, 15));
      }
      return max;
    };
    const before = await peakFor(800);
    window.__spookcamForce = { hallucination: 'jumpscare' };
    const during = await peakFor(2500);
    return { before, during, label: tr.label, wrapped: !!Object.getOwnPropertyDescriptor(tr, 'label'), consumed: !window.__spookcamForce.hallucination, ctxState: ctx.state };
  });
  if (process.env.DEBUG) console.log(JSON.stringify(mix));
  check(mix.before < 0.02, `outgoing mic is clean before the scare (peak ${mix.before.toFixed(3)})`);
  check(mix.during > 0.1, `jump-scare sound is mixed into the outgoing mic (peak ${mix.during.toFixed(2)})`);
  check(!!mix.label, `mixed mic keeps the real microphone label ("${mix.label}")`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall call-sound checks passed');
process.exit(failures ? 1 : 0);
