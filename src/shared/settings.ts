export const FACE_FILTERS = [
  { id: 'none', name: 'None', emoji: '🚫', blurb: 'No face paint' },
  { id: 'skull', name: 'Skull', emoji: '💀', blurb: 'Bone-white skull with hollow sockets' },
  { id: 'zombie', name: 'Zombie', emoji: '🧟', blurb: 'Rotting skin, veins and milky eyes' },
  { id: 'demon', name: 'Demon', emoji: '😈', blurb: 'Molten cracks, horns, burning eyes' },
  { id: 'vampire', name: 'Vampire', emoji: '🧛', blurb: 'Deathly pale, red eyes, fangs, blood' },
  { id: 'possessed', name: 'Possessed', emoji: '👁️', blurb: 'Black eyes, crawling veins, black tears' },
  { id: 'wraith', name: 'Wraith', emoji: '👻', blurb: 'Stretched white mask, screaming void' },
  { id: 'pumpkin', name: 'Jack-o’-lantern', emoji: '🎃', blurb: 'Carved pumpkin with candle glow' },
] as const;
export type FaceFilterId = (typeof FACE_FILTERS)[number]['id'];

export const BACKDROPS = [
  { id: 'none', name: 'Real room', emoji: '🏠' },
  { id: 'graveyard', name: 'Graveyard', emoji: '🪦' },
  { id: 'bloodmoon', name: 'Blood moon', emoji: '🌕' },
  { id: 'void', name: 'The Void', emoji: '🕳️' },
] as const;
export type BackdropId = (typeof BACKDROPS)[number]['id'];

export const TINTS = [
  { id: 'none', name: 'Natural' },
  { id: 'blood', name: 'Blood' },
  { id: 'sickly', name: 'Sickly' },
  { id: 'noir', name: 'Noir' },
  { id: 'nightvision', name: 'Night vision' },
] as const;
export type TintId = (typeof TINTS)[number]['id'];

export const VANISH_STYLES = [
  { id: 'dust', name: 'Thanos dust', emoji: '🫰' },
  { id: 'embers', name: 'Burn to embers', emoji: '🔥' },
  { id: 'cloak', name: 'Invisibility cloak', emoji: '🫥' },
] as const;
export type VanishStyle = (typeof VANISH_STYLES)[number]['id'];

export type WindDirection = 'right' | 'left' | 'up';

export interface Settings {
  /** Master switch. When off, cameras are passed through untouched. */
  enabled: boolean;
  face: FaceFilterId;
  /** 0..1 strength of the face paint. */
  faceIntensity: number;
  /** Paint every face in view (up to 3) instead of only the closest. */
  multiFace: boolean;
  backdrop: BackdropId;
  /** Translucent, flickering body over the learned background. */
  ghost: boolean;
  tint: TintId;
  vignette: number;
  grain: number;
  flicker: number;
  glitch: number;
  fog: number;
  vanishStyle: VanishStyle;
  wind: WindDirection;
  /** Seconds for the disintegration front to sweep the whole body. */
  vanishDuration: number;
  /** Seconds after vanishing before automatically reappearing (0 = never). */
  autoReturn: number;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  face: 'none',
  faceIntensity: 0.9,
  multiFace: true,
  backdrop: 'none',
  ghost: false,
  tint: 'none',
  vignette: 0,
  grain: 0,
  flicker: 0,
  glitch: 0,
  fog: 0,
  vanishStyle: 'dust',
  wind: 'right',
  vanishDuration: 3.2,
  autoReturn: 0,
};

export interface Preset {
  id: string;
  name: string;
  emoji: string;
  patch: Partial<Settings>;
}

const CLEAN_ATMOS: Partial<Settings> = { tint: 'none', vignette: 0, grain: 0, flicker: 0, glitch: 0, fog: 0 };

export const PRESETS: Preset[] = [
  { id: 'off', name: 'Clean', emoji: '✨', patch: { face: 'none', backdrop: 'none', ghost: false, ...CLEAN_ATMOS } },
  {
    id: 'haunted',
    name: 'Haunted',
    emoji: '🏚️',
    patch: { face: 'skull', backdrop: 'none', ghost: false, tint: 'noir', vignette: 0.75, grain: 0.45, flicker: 0.5, glitch: 0, fog: 0.5 },
  },
  {
    id: 'outbreak',
    name: 'Outbreak',
    emoji: '☣️',
    patch: { face: 'zombie', backdrop: 'none', ghost: false, tint: 'sickly', vignette: 0.6, grain: 0.35, flicker: 0.2, glitch: 0.1, fog: 0.2 },
  },
  {
    id: 'hellfire',
    name: 'Hellfire',
    emoji: '🔥',
    patch: { face: 'demon', backdrop: 'bloodmoon', ghost: false, tint: 'blood', vignette: 0.55, grain: 0.25, flicker: 0, glitch: 0, fog: 0.35 },
  },
  {
    id: 'nosferatu',
    name: 'Nosferatu',
    emoji: '🦇',
    patch: { face: 'vampire', backdrop: 'graveyard', ghost: false, tint: 'none', vignette: 0.6, grain: 0.3, flicker: 0, glitch: 0, fog: 0.45 },
  },
  {
    id: 'exorcism',
    name: 'Exorcism',
    emoji: '✝️',
    patch: { face: 'possessed', backdrop: 'void', ghost: false, tint: 'noir', vignette: 0.8, grain: 0.5, flicker: 0.6, glitch: 0.45, fog: 0.3 },
  },
  {
    id: 'apparition',
    name: 'Apparition',
    emoji: '👻',
    patch: { face: 'wraith', backdrop: 'none', ghost: true, tint: 'noir', vignette: 0.7, grain: 0.4, flicker: 0.35, glitch: 0.15, fog: 0.4 },
  },
  {
    id: 'pumpkin',
    name: 'Pumpkin',
    emoji: '🎃',
    patch: { face: 'pumpkin', backdrop: 'graveyard', ghost: false, tint: 'none', vignette: 0.5, grain: 0.15, flicker: 0, glitch: 0, fog: 0.3 },
  },
];

export const STORAGE_KEY = 'spookcam.settings';

export function normalizeSettings(raw: unknown): Settings {
  const s = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}) };
  const clamp01 = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
  s.faceIntensity = clamp01(s.faceIntensity);
  for (const k of ['vignette', 'grain', 'flicker', 'glitch', 'fog'] as const) s[k] = clamp01(s[k]);
  s.vanishDuration = Math.min(8, Math.max(0.8, Number(s.vanishDuration) || DEFAULT_SETTINGS.vanishDuration));
  s.autoReturn = Math.min(60, Math.max(0, Number(s.autoReturn) || 0));
  if (!FACE_FILTERS.some((f) => f.id === s.face)) s.face = 'none';
  if (!BACKDROPS.some((b) => b.id === s.backdrop)) s.backdrop = 'none';
  if (!TINTS.some((t) => t.id === s.tint)) s.tint = 'none';
  if (!VANISH_STYLES.some((v) => v.id === s.vanishStyle)) s.vanishStyle = 'dust';
  if (!['right', 'left', 'up'].includes(s.wind)) s.wind = 'right';
  return s;
}

/** One-shot actions sent to every live camera pipeline. */
export type EngineCommand = 'snap' | 'vanish' | 'reappear' | 'relearn-background';

export type VanishPhase = 'present' | 'vanishing' | 'gone' | 'returning';

export interface EngineStatus {
  cameras: number;
  fps: number;
  /** Fraction (0..1) of the frame where the background has been seen. */
  backgroundCoverage: number;
  phase: VanishPhase;
  faces: number;
  error?: string;
  loading?: boolean;
}
