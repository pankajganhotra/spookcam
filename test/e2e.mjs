// End-to-end check: loads dist/ into Chrome for Testing with a fake camera (a portrait video),
// opens a plain getUserMedia page, cycles through effects and saves what the "call" receives.
// Usage: npm run build && npm test   → screenshots in test/out/
import puppeteer from 'puppeteer';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'test/out');
const y4m = resolve(root, 'test/fixtures/camera.y4m');
await mkdir(out, { recursive: true });

try {
  await access(y4m);
} catch {
  // Gentle sway so the tracker and temporal filters see real motion.
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-loop', '1', '-i', resolve(root, 'test/fixtures/portrait.jpg'),
    '-vf', "crop=760:570:x='30+28*sin(t*1.7)':y='12+8*sin(t*1.3)',scale=640:480,format=yuv420p",
    '-t', '6', '-r', '30', y4m,
  ]);
}

const server = createServer(async (req, res) => {
  res.setHeader('content-type', 'text/html');
  // A Meet-like strict policy: no 'wasm-unsafe-eval', no extension URLs.
  if (req.url === '/strict') res.setHeader('content-security-policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:");
  res.end(await readFile(resolve(root, 'test/page.html')));
}).listen(0);
const port = server.address().port;

const dist = resolve(root, 'dist');
const browser = await puppeteer.launch({
  headless: process.env.HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [dist],
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required',
    '--enable-unsafe-swiftshader',
  ],
});

const errors = [];
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  console.log('extension', extId);

  const page = await browser.newPage();
  page.on('console', (m) => {
    const text = m.text();
    if (/^(INFO|W\d{4}|I\d{4})[: ]/.test(text)) return; // MediaPipe's native logging
    if (m.type() === 'error' || text.includes('SpookCam')) {
      console.log(`  [page:${m.type()}] ${text}`);
      if (m.type() === 'error') errors.push(text);
    }
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${port}/`);
  const info = await page.evaluate(() => window.ready);
  check(info.ctor === 'MediaStreamTrackGenerator', `camera wrapped via ${info.ctor}`);
  check(!!info.label, `track label mirrored: "${info.label}"`);
  check(info.settings.width === 640, `getSettings mirrored: ${info.settings.width}x${info.settings.height}`);

  // Apps often clone the camera track and stop the original; the clone must keep streaming.
  const cloneOk = await page.evaluate(async () => {
    const clone = window.track.clone();
    window.track.stop();
    const v = document.getElementById('v');
    v.srcObject = new MediaStream([clone]);
    await v.play();
    window.track = clone;
    await new Promise((r) => setTimeout(r, 800));
    const c = document.createElement('canvas');
    c.width = 64; c.height = 48;
    const ctx = c.getContext('2d');
    ctx.drawImage(v, 0, 0, 64, 48);
    const px = ctx.getImageData(0, 0, 64, 48).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return { live: clone.readyState === 'live', label: clone.label, brightness: sum / (64 * 48 * 3) };
  });
  check(cloneOk.live && cloneOk.brightness > 20 && !!cloneOk.label, `clone survives stopping the original (brightness ${cloneOk.brightness.toFixed(0)})`);

  const setSettings = (patch) =>
    sw.evaluate(async (patch) => {
      const key = 'spookcam.settings';
      const cur = (await chrome.storage.local.get(key))[key] ?? {};
      await chrome.storage.local.set({ [key]: { ...cur, ...patch } });
    }, patch);
  const command = (cmd) =>
    sw.evaluate(async (cmd) => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url?.startsWith('http://localhost')) await chrome.tabs.sendMessage(t.id, { type: 'command', cmd });
    }, cmd);
  const status = () =>
    sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.url?.startsWith('http://localhost')) return chrome.tabs.sendMessage(t.id, { type: 'get-status' });
    });
  const shot = async (name) => {
    const data = await page.evaluate(() => window.grab());
    await writeFile(resolve(out, `${name}.jpg`), Buffer.from(data.split(',')[1], 'base64'));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred, label, timeout = 30000) => {
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < timeout) {
      s = await status().catch(() => null);
      if (s && pred(s)) return s;
      await wait(250);
    }
    check(false, `${label} (last status ${JSON.stringify(s)})`);
    return s;
  };

  await shot('00-original');
  await setSettings({ face: 'skull' });
  const st = await waitFor((s) => s.faces > 0 && !s.loading, 'face detected');
  if (st?.faces) check(true, `engine live: ${st.fps} fps, ${st.faces} face(s)`);
  await wait(800);

  const faces = ['skull', 'zombie', 'demon', 'vampire', 'possessed', 'wraith', 'pumpkin', 'clown', 'slasher', 'burned', 'monster', 'werewolf', 'mummy', 'witch', 'doll', 'onryo'];
  for (const face of faces) {
    await setSettings({ face });
    await wait(700);
    await shot(`face-${face}`);
  }
  const steady = await status();
  console.log(`  steady state: ${steady.fps} fps with face paint (headless/SwiftShader — real GPUs are much faster)`);
  await setSettings({ face: 'none' });
  for (const backdrop of ['graveyard', 'bloodmoon', 'void']) {
    await setSettings({ backdrop });
    await wait(700);
    await shot(`backdrop-${backdrop}`);
  }
  await setSettings({ backdrop: 'none', ghost: true });
  await wait(700);
  await shot('ghost');
  await setSettings({ ghost: false, tint: 'noir', vignette: 0.8, grain: 0.5, fog: 0.7, flicker: 0, glitch: 0.6 });
  await wait(700);
  await shot('atmosphere');
  await setSettings({ tint: 'none', vignette: 0, grain: 0, fog: 0, glitch: 0 });

  for (const style of ['dust', 'embers', 'cloak']) {
    await setSettings({ vanishStyle: style, vanishDuration: 3 });
    await wait(400);
    await command('snap');
    for (const t of [0.8, 1.8, 3.2]) {
      await wait(t * 1000 - (t === 0.8 ? 0 : t === 1.8 ? 800 : 1800));
      await shot(`snap-${style}-${t}s`);
    }
    const gone = await waitFor((s) => s.phase === 'gone', `${style}: reaches gone`, 8000);
    if (gone?.phase === 'gone') check(true, `${style}: vanished completely`);
    await shot(`snap-${style}-gone`);
    await command('snap');
    await wait(1800);
    await shot(`snap-${style}-returning`);
    const back = await waitFor((s) => s.phase === 'present', `${style}: reappears`, 8000);
    if (back?.phase === 'present') check(true, `${style}: reassembled`);
  }

  // Strict CSP page still gets effects.
  await setSettings({ face: 'none' });
  await page.close();
  const strict = await browser.newPage();
  if (process.env.DEBUG) strict.on('console', (m) => console.log(`  [strict:${m.type()}] ${m.text()}`));
  strict.on('pageerror', (e) => errors.push(`strict: ${e}`));
  strict.on('console', (m) => m.type() === 'error' && !/^(INFO|W\d{4}|I\d{4})[: ]/.test(m.text()) && errors.push(`strict: ${m.text()}`));
  await strict.goto(`http://localhost:${port}/strict`);
  await strict.evaluate(() => window.ready);
  await setSettings({ face: 'demon' });
  const sst = await waitFor((s) => s.faces > 0 && !s.loading, 'strict CSP page: face paint works', 30000);
  if (sst?.faces) check(!sst.error, `strict CSP page: face paint works (${sst.fps} fps)`);
  await wait(500);
  const data = await strict.evaluate(() => window.grab());
  await writeFile(resolve(out, 'strict-csp-demon.jpg'), Buffer.from(data.split(',')[1], 'base64'));
  await setSettings({ face: 'none' });

  // Popup + studio render without errors.
  const ui = await browser.newPage();
  ui.on('pageerror', (e) => errors.push(`ui: ${e}`));
  ui.on('console', (m) => m.type() === 'error' && errors.push(`ui: ${m.text()}`));
  await ui.setViewport({ width: 380, height: 900 });
  await ui.goto(`chrome-extension://${extId}/popup.html`);
  await wait(800);
  await ui.screenshot({ path: resolve(out, 'ui-popup.png'), fullPage: true });
  await ui.setViewport({ width: 1400, height: 900 });
  await ui.goto(`chrome-extension://${extId}/studio.html?welcome=1`);
  await wait(4000);
  await ui.screenshot({ path: resolve(out, 'ui-studio.png') });

  const relevant = errors.filter((e) => !/favicon|fonts\.g|Compiling or instantiating WebAssembly module violates/.test(e)); // the CSP probe is expected to trip on the strict page
  check(relevant.length === 0, `no page errors${relevant.length ? `: ${relevant.join(' | ')}` : ''}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
