# Third-party notices

SpookCam's own code is MIT-licensed (see `LICENSE`). It builds on the following, which keep their
own licenses:

## MediaPipe (Apache License 2.0)

- `@mediapipe/tasks-vision` — npm dependency; its WebAssembly runtime and loader are copied into
  `dist/` at build time.
- Face Landmarker, Hand Landmarker and Selfie Segmenter models — downloaded by
  `npm run fetch-assets` from Google's model storage; not committed to this repository.
- `src/engine/facemesh-data.ts` — triangle topology and UV coordinates generated from MediaPipe's
  `canonical_face_model.obj`.

Copyright Google LLC. Licensed under the Apache License, Version 2.0:
https://www.apache.org/licenses/LICENSE-2.0

## Test fixtures

`npm run fetch-assets` also downloads test photos (a portrait and hand-gesture images) from
MediaPipe's public test-asset bucket into `test/fixtures/`. They are used only by the local test
suite and are not part of this repository or the extension.
