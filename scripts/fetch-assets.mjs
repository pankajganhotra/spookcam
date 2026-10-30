// Downloads the ML models and face-mesh topology SpookCam needs.
// Run once: `npm run fetch-assets` (also runs automatically on `npm install`).
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  {
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    out: 'public/models/face_landmarker.task',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    out: 'public/models/selfie_segmenter.tflite',
  },
  {
    url: 'https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj',
    out: 'scripts/data/canonical_face_model.obj',
  },
  {
    url: 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg',
    out: 'test/fixtures/portrait.jpg',
  },
];

const force = process.argv.includes('--force');

for (const { url, out } of ASSETS) {
  const dest = resolve(root, out);
  if (!force) {
    try {
      await access(dest);
      console.log(`✓ ${out} (cached)`);
      continue;
    } catch {}
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`↓ ${out} (${(buf.length / 1024).toFixed(0)} KB)`);
}
