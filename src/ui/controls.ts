import {
  BACKDROPS,
  FACE_FILTERS,
  normalizeSettings,
  PRESETS,
  STORAGE_KEY,
  TINTS,
  VANISH_STYLES,
  type EngineCommand,
  type EngineStatus,
  type Settings,
} from '../shared/settings';

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === false) continue;
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export interface ControlsOptions {
  root: HTMLElement;
  sendCommand(cmd: EngineCommand): void;
  /** Resolves to null when no camera is being processed for this view. */
  getStatus(): Promise<EngineStatus | null>;
  /** Text shown when no camera is live. */
  idleHint: string;
}

export async function mountControls(opts: ControlsOptions) {
  let settings = normalizeSettings((await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]);
  const renderers: Array<() => void> = [];
  let writeTimer: ReturnType<typeof setTimeout> | undefined;

  const update = (patch: Partial<Settings>, debounce = false) => {
    settings = normalizeSettings({ ...settings, ...patch });
    renderers.forEach((r) => r());
    clearTimeout(writeTimer);
    const write = () => chrome.storage.local.set({ [STORAGE_KEY]: settings });
    if (debounce) writeTimer = setTimeout(write, 50);
    else void write();
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    settings = normalizeSettings(changes[STORAGE_KEY].newValue);
    renderers.forEach((r) => r());
  });

  const tile = (glyph: string, name: string, pressed: () => boolean, onClick: () => void, title?: string) => {
    const b = h('button', { class: 'tile', type: 'button', title: title ?? name, onclick: onClick }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph), h('span', { class: 'name' }, name));
    renderers.push(() => b.setAttribute('aria-pressed', String(pressed())));
    return b;
  };

  const seg = <T extends string>(label: string, options: readonly { id: T; name: string }[], get: () => T, set: (v: T) => void) => {
    const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
    for (const o of options) {
      const b = h('button', { type: 'button', onclick: () => set(o.id) }, o.name);
      renderers.push(() => b.setAttribute('aria-pressed', String(get() === o.id)));
      wrap.append(b);
    }
    return wrap;
  };

  let sliderId = 0;
  const slider = (label: string, get: () => number, set: (v: number) => void, { min = 0, max = 1, step = 0.01, fmt = (v: number) => `${Math.round(v * 100)}` } = {}) => {
    const id = `sl${sliderId++}`;
    const input = h('input', { type: 'range', id, min, max, step, oninput: (e) => set(Number((e.target as HTMLInputElement).value)) });
    const out = h('output', { for: id });
    renderers.push(() => {
      if (document.activeElement !== input) input.value = String(get());
      out.textContent = fmt(get());
    });
    return h('div', { class: 'row' }, h('label', { for: id }, label), input, out);
  };

  const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
    const input = h('input', { type: 'checkbox', onchange: (e) => set((e.target as HTMLInputElement).checked) });
    renderers.push(() => (input.checked = get()));
    return h('label', { class: 'switch' }, input, h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', {}, label));
  };

  const section = (title: string, aside: Child, ...body: Child[]) =>
    h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, title), aside), ...body);

  // ── Snap ──
  const seal = h('button', { class: 'seal', type: 'button', onclick: () => opts.sendCommand('snap') });
  const statusDot = h('span', { class: 'dot' });
  const statusText = h('span', {}, 'Looking for a camera…');
  const meterFill = h('i');
  const meterLabel = h('span', { class: 'hint' });
  const listenHint = h('span', { class: 'hint' });
  const snapZone = h(
    'div',
    { class: 'snap-zone' },
    seal,
    h(
      'div',
      { class: 'snap-side' },
      seg('Vanish style', VANISH_STYLES.map((v) => ({ id: v.id, name: { dust: 'Dust', embers: 'Embers', cloak: 'Cloak' }[v.id] })), () => settings.vanishStyle, (vanishStyle) => update({ vanishStyle })),
      h('div', { class: 'stack' }, h('div', { class: 'meter', role: 'presentation' }, meterFill), meterLabel),
      h('div', { class: 'status' }, statusDot, statusText),
    ),
  );

  let lastStatus: EngineStatus | null = null;
  const renderStatus = () => {
    const s = lastStatus;
    const live = !!s && s.cameras > 0;
    statusDot.dataset.live = String(live && !s?.error);
    statusDot.dataset.error = String(!!s?.error);
    if (!settings.enabled) statusText.textContent = 'SpookCam is off';
    else if (s?.error) statusText.textContent = `Effects stopped: ${s.error}`;
    else if (live) {
      const magic = (s!.gestures ?? []).map((g) => ({ fist: '✊ candle', palm: '🖐️ fireball', point: '☝️ fingertip flame' })[g as 'fist']).filter(Boolean);
      statusText.textContent = `${s!.loading ? 'Summoning models… ' : ''}${s!.fps} fps · ${s!.faces} ${s!.faces === 1 ? 'face' : 'faces'}${s!.hands ? ` · ${s!.hands} ${s!.hands === 1 ? 'hand' : 'hands'}` : ''}${magic.length ? ` · ${magic.join(', ')}` : ''}`;
    }
    else statusText.textContent = opts.idleHint;
    const phase = s?.phase ?? 'present';
    seal.dataset.phase = phase;
    seal.disabled = !live || !settings.enabled;
    seal.replaceChildren(
      h('span', {}, phase === 'gone' ? 'Return' : phase === 'vanishing' ? 'Undo' : phase === 'returning' ? 'Snap' : 'Snap', h('small', {}, phase === 'gone' ? 'reassemble' : 'Alt⇧S')),
    );
    const cov = Math.round((s?.backgroundCoverage ?? 0) * 100);
    meterFill.style.width = `${cov}%`;
    const heard = s?.heardSnapAt && Date.now() - s.heardSnapAt < 2500;
    listenHint.textContent = !settings.snapSound
      ? 'Uses your microphone'
      : heard
        ? '🫰 Heard a snap!'
        : s?.listening === 'on'
          ? '👂 Listening'
          : s?.listening === 'blocked'
            ? 'Microphone is off or blocked'
            : live
              ? 'Starting microphone…'
              : 'Starts with your camera';
    meterLabel.textContent = !live ? 'Background not learned yet' : cov > 92 ? `Background learned — vanish will be clean` : `Background ${cov}% learned · step aside briefly to reveal more`;
  };
  renderers.push(renderStatus);

  const poll = async () => {
    lastStatus = await opts.getStatus().catch(() => null);
    renderStatus();
  };
  void poll();
  setInterval(poll, 700);

  // ── Master switch in header slot ──
  const master = toggle('On', () => settings.enabled, (enabled) => update({ enabled }));

  const presetRow = h('div', { class: 'presets' });
  for (const p of PRESETS) {
    presetRow.append(
      tile(p.emoji, p.name, () => Object.entries(p.patch).every(([k, v]) => settings[k as keyof Settings] === v), () => update({ hallucinate: 0, magic: false, claws: false, ...p.patch })),
    );
  }

  const faceGrid = (group: 'character' | 'paint') => {
    const grid = h('div', { class: 'tiles' });
    for (const f of FACE_FILTERS) if (f.group === group) grid.append(tile(f.emoji, f.name, () => settings.face === f.id, () => update({ face: f.id }), f.blurb));
    return grid;
  };

  const backdropGrid = h('div', { class: 'tiles' });
  for (const b of BACKDROPS) backdropGrid.append(tile(b.emoji, b.name, () => settings.backdrop === b.id, () => update({ backdrop: b.id })));

  opts.root.append(
    snapZone,
    section('Presets', null, presetRow),
    section('Characters', toggle('Everyone', () => settings.multiFace, (multiFace) => update({ multiFace })), faceGrid('character')),
    section(
      'Face paint',
      null,
      faceGrid('paint'),
      h('div', { style: 'margin-top:10px' }, slider('Strength', () => settings.faceIntensity, (faceIntensity) => update({ faceIntensity }, true))),
    ),
    section(
      'Behind you',
      h('button', { class: 'btn', type: 'button', title: 'Forget the learned background and start over (Alt⇧B)', onclick: () => opts.sendCommand('relearn-background') }, 'Re-learn room'),
      backdropGrid,
      h('div', { class: 'inline', style: 'margin-top:12px' }, toggle('Ghost body', () => settings.ghost, (ghost) => update({ ghost })), h('span', { class: 'hint' }, 'See-through, flickering you')),
    ),
    section(
      'Atmosphere',
      null,
      h(
        'div',
        { class: 'stack' },
        seg('Color grade', TINTS, () => settings.tint, (tint) => update({ tint })),
        slider('Fog', () => settings.fog, (fog) => update({ fog }, true)),
        slider('Vignette', () => settings.vignette, (vignette) => update({ vignette }, true)),
        slider('Film grain', () => settings.grain, (grain) => update({ grain }, true)),
        slider('Flicker', () => settings.flicker, (flicker) => update({ flicker }, true)),
        slider('VHS glitch', () => settings.glitch, (glitch) => update({ glitch }, true)),
      ),
    ),
    section(
      'Hallucinations',
      h('button', { class: 'btn', type: 'button', title: 'Trigger a jump scare now (Alt⇧H)', onclick: () => opts.sendCommand('scare') }, 'Scare now'),
      h(
        'div',
        { class: 'stack' },
        slider('How often', () => settings.hallucinate, (hallucinate) => update({ hallucinate }, true), { fmt: (v) => (v ? `${Math.round(v * 100)}` : 'off') }),
        h('p', { class: 'hint', style: 'margin:0' }, 'Your jaw stretches, eyes bulge, face melts, you twitch, a lagging double follows you, a figure appears behind you — or your own face lunges at the camera.'),
      ),
    ),
    section(
      'Magic',
      toggle('Gestures', () => settings.magic, (magic) => update({ magic })),
      h(
        'ul',
        { class: 'gestures' },
        h('li', {}, h('span', { 'aria-hidden': 'true' }, '😮'), 'Open your mouth wide to breathe fire'),
        h('li', {}, h('span', { 'aria-hidden': 'true' }, '😗'), 'Pucker up to blow smoke'),
        h('li', {}, h('span', { 'aria-hidden': 'true' }, '✊'), 'Make a fist to hold a lit candle'),
        h('li', {}, h('span', { 'aria-hidden': 'true' }, '🖐️'), 'Open your palm to summon a fireball'),
        h('li', {}, h('span', { 'aria-hidden': 'true' }, '☝️'), 'Point to light your fingertip'),
      ),
      h('div', { class: 'inline', style: 'margin-top:10px' }, toggle('Claws', () => settings.claws, (claws) => update({ claws })), h('span', { class: 'hint' }, 'Talons on every finger')),
    ),
    section(
      'Vanishing',
      null,
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'inline' }, toggle('Snap your fingers', () => settings.snapSound, (snapSound) => update({ snapSound })), listenHint),
        slider('Sensitivity', () => settings.snapSensitivity, (snapSensitivity) => update({ snapSensitivity }, true)),
        seg('Dust drifts', [{ id: 'left', name: 'Drift left' }, { id: 'up', name: 'Rise' }, { id: 'right', name: 'Drift right' }] as const, () => settings.wind, (wind) => update({ wind })),
        slider('Duration', () => settings.vanishDuration, (vanishDuration) => update({ vanishDuration }, true), { min: 0.8, max: 8, step: 0.1, fmt: (v) => `${v.toFixed(1)}s` }),
        slider('Come back', () => settings.autoReturn, (autoReturn) => update({ autoReturn }, true), { min: 0, max: 30, step: 1, fmt: (v) => (v ? `${v}s` : 'never') }),
      ),
    ),
  );

  renderers.forEach((r) => r());
  return { master };
}
