import '../ui/theme.css';
import './studio.css';
import { LocalDetectors, type AssetName } from '../engine/detectors';
import { SpookEngine, type FrameProcessor } from '../engine/engine';
import { ASSET_PATHS, type RuntimeMessage } from '../shared/protocol';
import { normalizeSettings, STORAGE_KEY, type EngineCommand } from '../shared/settings';
import { wrapVideoTrack } from '../shared/track';
import { mountControls } from '../ui/controls';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>('preview');
const empty = $('empty');
const cameraSelect = $<HTMLSelectElement>('camera');
const mirror = $<HTMLInputElement>('mirror');
const photoBtn = $<HTMLButtonElement>('photo');
const recordBtn = $<HTMLButtonElement>('record');

const load = async (name: AssetName) => {
  const res = await fetch(chrome.runtime.getURL(ASSET_PATHS[name]));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.arrayBuffer();
};

const engine = new SpookEngine(new LocalDetectors(load), normalizeSettings((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) engine.setSettings(normalizeSettings(changes[STORAGE_KEY].newValue));
});
// Snap detection hears the room through an unprocessed microphone capture.
engine.setAudioProvider(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  return s.getAudioTracks()[0] ?? null;
});

// Commands from the popup / keyboard shortcut — only act while this tab is the one in view.
chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (msg.type === 'command' && document.visibilityState === 'visible') engine.command(msg.cmd);
  if (msg.type === 'get-status' && document.visibilityState === 'visible') {
    const s = engine.status();
    if (s.cameras > 0) sendResponse(s);
  }
  return false;
});

const sendCommand = (cmd: EngineCommand) => engine.command(cmd);
const { master } = await mountControls({
  root: $('controls'),
  sendCommand,
  getStatus: async () => {
    const s = engine.status();
    return s.cameras > 0 ? s : null;
  },
  idleHint: 'Turn on the camera to preview',
});
$('master').append(master);

// ── Welcome ──
if (new URLSearchParams(location.search).has('welcome')) $('welcome').hidden = false;
$('dismiss').addEventListener('click', () => {
  $('welcome').hidden = true;
  history.replaceState(null, '', location.pathname);
});

// ── Camera ──
let raw: MediaStream | undefined;
let processed: MediaStream | undefined;

const syncMirror = () => (video.dataset.mirror = String(mirror.checked));
mirror.addEventListener('change', syncMirror);
syncMirror();

async function listCameras(selected?: string) {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  cameraSelect.replaceChildren(...cams.map((c, i) => new Option(c.label || `Camera ${i + 1}`, c.deviceId, false, c.deviceId === selected)));
}

async function startCamera(deviceId?: string) {
  stopCamera();
  try {
    raw = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    $('camError').textContent =
      (err as DOMException).name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it from the camera icon in the address bar, then try again.'
        : `Couldn't open the camera: ${(err as Error).message}`;
    return;
  }
  const track = raw.getVideoTracks()[0];
  let proc: FrameProcessor | null = null;
  processed = new MediaStream([wrapVideoTrack(track, () => (proc ??= engine.createPipeline()))]);
  video.srcObject = processed;
  await video.play();
  empty.hidden = true;
  photoBtn.disabled = recordBtn.disabled = false;
  await listCameras(track.getSettings().deviceId);
}

function stopCamera() {
  processed?.getTracks().forEach((t) => t.stop());
  raw?.getTracks().forEach((t) => t.stop());
  processed = raw = undefined;
}

$('start').addEventListener('click', () => startCamera());
cameraSelect.addEventListener('change', () => startCamera(cameraSelect.value));
window.addEventListener('pagehide', stopCamera);

// Reopen automatically when permission was granted before.
const perm = await navigator.permissions.query({ name: 'camera' as PermissionName }).catch(() => null);
if (perm?.state === 'granted') void startCamera();

// ── Capture ──
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

photoBtn.addEventListener('click', () => {
  const c = document.createElement('canvas');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  const ctx = c.getContext('2d')!;
  if (mirror.checked) {
    ctx.translate(c.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0);
  c.toBlob((b) => b && download(b, `spookcam-${stamp()}.png`), 'image/png');
});

let recorder: MediaRecorder | undefined;
recordBtn.addEventListener('click', () => {
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  if (!processed) return;
  const chunks: Blob[] = [];
  const type = ['video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(processed, { mimeType: type, videoBitsPerSecond: 6_000_000 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    download(new Blob(chunks, { type: 'video/webm' }), `spookcam-${stamp()}.webm`);
    recordBtn.textContent = 'Record clip';
    $('recBadge').hidden = true;
  };
  recorder.start(250);
  recordBtn.textContent = 'Stop recording';
  $('recBadge').hidden = false;
});
