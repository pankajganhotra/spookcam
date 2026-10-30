# SpookCam — Halloween webcam FX for Chrome

A Chrome extension (Manifest V3) that turns your webcam into a horror show in **any** site that
uses the camera — Google Meet, Zoom (web), Teams, Discord, Whereby, or your own page.

- **Classic horror characters** that track your face in real time: Killer clown (red nose,
  needle teeth, frizzy hair), Camp slasher (hockey mask), Nightmare (burn scars), Frankenstein
  (stitches, flat-top, neck bolts), Werewolf (fur, mane, ears, fangs), Mummy, Witch (warts, cat
  eyes, hat), Haunted doll (cracked porcelain, glass eyes), Onryō (long black hair) and Vampire.
- **Face paints**: Skull, Zombie, Demon (with horns), Possessed, Wraith and Jack-o'-lantern.
- **Lit like your room**: every material is shaded by your camera's own lighting (relative to
  your average skin brightness) and keeps your real pores and wrinkles, so it holds up in dim rooms.
- **Thanos snap**: you disintegrate into drifting dust and the room behind you shows through.
  Snap again and the dust flies back together. Two more styles: *burn to embers* and an
  *invisibility cloak* with a refraction shimmer.
- **Snap your fingers** to vanish and come back: the extension listens to the call's own
  microphone for the sharp, bright, fast-decaying click of a finger snap (speech, tones and
  typing are ignored; sensitivity is adjustable). It never reopens a mic the call app stopped.
- **Hallucinations** that strike at random (or on <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>):
  your jaw stretches into a scream, eyes bulge into voids, your face melts, you twitch violently,
  a lagging double follows you, a shadow figure appears behind you, subliminal negative flashes.
- **Jump scare**: lights cut, then your own face lunges at the camera with hollow black eyes and a
  ripped-open screaming mouth, and snaps back as if nothing happened.
- **Scare sounds**, synthesised live (no audio files): an orchestral stinger + scream for the jump
  scare, moans, violin screeches, whispers, a drone when the figure appears, a dust whoosh when you
  vanish. Play them on your speakers only, or mix them into your outgoing microphone so the whole
  call hears them (if the browser blocks audio, the real mic is passed through untouched).
- **Gesture magic**: open your mouth wide to breathe fire, pucker to blow smoke, open your hand to
  set every fingertip alight, point to light one fingertip, make a fist to hold a fireball — flames
  light up your face. Plus **claws** on every finger. Tracked hands are kept in the person mask,
  so they never disappear into a replaced background.
- **Haunted backdrops**: graveyard, blood moon, or the void (with blinking eyes), plus a
  see-through **ghost body** mode.
- **Atmosphere**: blood / sickly / noir / old-film / night-vision grades, creeping fog, vignette, film grain,
  failing-bulb flicker, VHS glitch.
- **Presets** for one-click looks, a **preview studio** with photo and clip recording, and a
  keyboard shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> snaps from any tab.

## Install

### From a release (no build tools needed)

1. Download `spookcam-vX.Y.Z.zip` from the [latest release](https://github.com/pankajganhotra/spookcam/releases/latest)
   and unzip it into a folder you'll keep (Chrome loads the extension from there).
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. The studio opens — turn on the camera and try the effects. In a call that's already running,
   turn your camera off and on once so SpookCam can attach to it.

To update, unzip the new release over the same folder and click the reload icon on SpookCam in
`chrome://extensions` (or open `chrome-extension://<extension id>/reload.html`).

### From source

```bash
npm install          # also downloads the MediaPipe models (postinstall)
npm run build        # → dist/   (load this folder unpacked, as above)
npm run package      # → release/spookcam-v<version>.zip
```

Releases are built by GitHub Actions: push a tag matching the manifest version (e.g. `v1.0.0`)
and the zip is attached to the release automatically.

**Tip for a clean vanish:** step out of frame for a second (or sway side to side). SpookCam keeps
learning the room behind you; the popup's meter shows how much of it is known.

## How it works

```
page (MAIN world)                         extension
┌──────────────────────────────┐          ┌────────────────────────────┐
│ hook.js  (5 KB, every page)  │◄─────────│ bridge.js (isolated world) │◄── chrome.storage, popup,
│  patches getUserMedia        │ postMsg  │  settings, commands, assets│    hotkeys (service worker)
│  camera ─► MediaStreamTrack- │          └────────────────────────────┘
│  Processor ─► engine ─►      │          ┌────────────────────────────┐
│  MediaStreamTrackGenerator   │─────────►│ detector.html (iframe) —   │ only when the page's CSP
│                              │  bitmaps │  MediaPipe under ext. CSP  │ blocks WebAssembly
│ engine.js (injected on first │          └────────────────────────────┘
│  camera use): MediaPipe face │
│  landmarker + selfie         │
│  segmenter, WebGL2 renderer  │
└──────────────────────────────┘
```

- **Detection**: MediaPipe Tasks Vision (Face Landmarker, 478 points; Selfie Segmenter), GPU
  delegate, landmarks smoothed with a One-Euro filter.
- **Face paint** is drawn procedurally in UV space of MediaPipe's canonical face mesh
  (`src/engine/facemesh-data.ts`, generated by `scripts/gen-facemesh.mjs`), with a feathered
  skirt so the paint fades out at the hairline. Eyes and inner mouth get their own passes.
- **Vanishing** keeps a clean background plate: wherever nobody is standing, the camera image is
  accumulated into a texture; holes are filled pull-push style from its mip chain. The dissolve
  front is a noise field swept along the wind direction; the dust is a stateless GPU particle
  system (one particle per few pixels of the body) that shares the same timing function, so
  every speck leaves exactly where skin disappears — and runs backwards to reassemble.
- The processed track impersonates the real one (label, settings, constraints, clones), so call
  apps keep working normally. If anything fails, frames pass through untouched.

## Develop

```bash
npm run dev          # rebuild on change (reload the extension in chrome://extensions)
npm run typecheck
npm test             # snap-detector unit test + E2E with a fake camera → test/out/*.jpg
#   npm test runs, in order:
#   test/snap-unit.mjs       finger-snap analyser on synthetic speech / tone / typing / snaps
#   test/sfx-test.mjs        every scare sound rendered offline: audible, never clipping
#   test/e2e.mjs             camera hook, all looks, vanish styles, hallucinations, magic, strict CSP
#   test/hands-e2e.mjs       hand tracking + gestures on real photos, hands kept over the Void
#   test/call-sound-e2e.mjs  jump-scare sound arrives on the outgoing call microphone
```

The E2E test loads `dist/` with a synthetic camera made from `test/fixtures/portrait.jpg`, then
checks camera wrapping, clone handling, every face filter, backdrop, all three vanish styles
(vanish + reassemble), a strict-CSP page, and that the popup and studio render without errors.

## Privacy

All processing happens locally on your GPU. No video, images or analytics leave your machine;
the extension makes no network requests besides loading its own bundled files.

## Credits

Face, hand and segmentation models and the canonical face mesh: [MediaPipe](https://github.com/google-ai-edge/mediapipe) (Apache-2.0).
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

[MIT](LICENSE) © 2026 Pankaj Ganhotra
