// Unit test for the finger-snap analyser on synthetic microphone audio.
// Usage: node test/snap-unit.mjs   (bundles the TS module on the fly with esbuild)
import * as esbuild from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { micSignal, SAMPLE_RATE, SNAP_TIMES } from './mic-signal.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { outputFiles } = await esbuild.build({
  entryPoints: [resolve(root, 'src/engine/snap-detector.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
});
const { SnapAnalyser, SNAP_BLOCK } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) failures++;
};

/** Runs `loops` × 10 s of audio through the analyser; returns detection times (s, within loop). */
function run(sensitivity, loops = 3, gain = 1) {
  const sig = micSignal(10);
  const a = new SnapAnalyser();
  const hits = [];
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i + SNAP_BLOCK <= sig.length; i += SNAP_BLOCK) {
      const block = sig.slice(i, i + SNAP_BLOCK).map((v) => v * gain);
      const t = l * 10 + i / SAMPLE_RATE;
      if (a.analyse(block, t * 1000, sensitivity)) hits.push(+(t % 10).toFixed(2));
    }
  }
  return hits;
}

for (const s of [0.2, 0.5, 0.8]) {
  const hits = run(s);
  const onSnap = hits.every((t) => SNAP_TIMES.some((st) => t >= st && t < st + 0.15));
  check(hits.length === 3 && onSnap, `sensitivity ${s}: ${hits.length}/3 snaps detected, all at the snap (${hits.join(', ')}); speech, tone and typing ignored`);
}
const quiet = run(0.5, 3, 0.3);
check(quiet.length <= 3 && quiet.every((t) => t >= 7 && t < 7.15), `quiet mic (−10 dB): ${quiet.length} detections, none false`);
const quietHigh = run(0.9, 3, 0.3);
check(quietHigh.length === 3, `quiet mic at high sensitivity still hears all snaps (${quietHigh.length}/3)`);

console.log(failures ? `\n${failures} check(s) failed` : '\nall snap checks passed');
process.exit(failures ? 1 : 0);
