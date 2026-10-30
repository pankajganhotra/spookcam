// Synthetic microphone audio for snap-detection tests (10 s, 48 kHz mono):
// room tone, mumbled speech (1–4 s), a 440 Hz tone (4.5–5.5 s), quiet keyboard clicks (5.8–6.6 s)
// and exactly ONE finger snap at 7 s.
export const SAMPLE_RATE = 48000;
export const SNAP_TIMES = [7];

export function micSignal(seconds = 10) {
  const sr = SAMPLE_RATE, n = sr * seconds;
  const out = new Float32Array(n);
  let lp = 0, prev = 0, seed = 7;
  const white = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = (i / sr) % 10;
    let v = white() * 0.002;
    if (t > 1 && t < 4) {
      lp += (white() - lp) * 0.1; // ~800 Hz low-pass: voice-like band
      v += lp * 0.9 * Math.max(0, Math.sin(Math.PI * 4 * t)) ** 2;
    }
    if (t > 4.5 && t < 5.5) v += 0.3 * Math.sin(2 * Math.PI * 440 * t) * Math.min(1, (t - 4.5) * 50, (5.5 - t) * 50);
    // First-difference of white noise = a high-passed click.
    const w = white();
    const click = w - prev;
    prev = w;
    const key = (t - 5.8) % 0.13;
    if (t > 5.8 && t < 6.6 && key < 0.004) v += click * 0.04 * Math.exp(-key / 0.001); // typing
    for (const s of SNAP_TIMES) {
      if (t >= s && t < s + 0.04) v += click * 0.45 * Math.exp(-(t - s) / 0.006); // snap: loud, fast decay
    }
    out[i] = Math.max(-1, Math.min(1, v));
  }
  return out;
}

export function toWav(samples) {
  const n = samples.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + n * 2, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(n * 2, 40);
  const pcm = Int16Array.from(samples, (v) => v * 32767);
  return Buffer.concat([header, Buffer.from(pcm.buffer)]);
}
