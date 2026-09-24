// Scroll timeline, shared by the WebGL scene and the HTML overlays.
// Progress `p` runs 0 -> 1 over the full page scroll.

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Normalised position of `p` inside [a, b]. */
export const range = (p: number, a: number, b: number) => clamp01((p - a) / (b - a));

export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Section boundaries; index matches `teaSections` in content/tea.ts. */
export const TEA_STOPS = [0, 0.12, 0.27, 0.42, 0.57, 0.72, 0.87, 1] as const;

export const TEA_SCROLL_PAGES = 9;

/** Centre of section `i`, where its copy is fully shown. */
export const teaCenter = (i: number) =>
  i === 0 ? 0 : i === TEA_STOPS.length - 2 ? 1 : (TEA_STOPS[i] + TEA_STOPS[i + 1]) / 2;

/** Visibility 0..1 of section `i`'s copy, plus a signed offset for slide motion. */
export function teaCopyState(p: number, i: number) {
  const a = TEA_STOPS[i];
  const b = TEA_STOPS[i + 1];
  const w = (b - a) * 0.34;
  const first = i === 0;
  const last = i === TEA_STOPS.length - 2;
  const fadeIn = first ? 1 : smoothstep(a + w * 0.2, a + w, p);
  const fadeOut = last ? 1 : 1 - smoothstep(b - w, b - w * 0.2, p);
  const vis = Math.min(fadeIn, fadeOut);
  // -1 before, 0 centred, +1 after: drives a small vertical drift.
  const offset = p < (a + b) / 2 ? -(1 - fadeIn) : 1 - fadeOut;
  return { vis, offset };
}

/** Brewing phases, all derived from progress. */
export const phases = (p: number) => ({
  pouch: range(p, 0.1, 0.25), // pouch drops in and tips
  pouchOut: range(p, 0.38, 0.46), // pouch leaves
  fall: range(p, 0.24, 0.44), // leaves fall into the pot
  stir: range(p, 0.4, 0.62), // swirl
  brew: smoothstep(0.44, 0.7, p), // clear -> amber
  pour: range(p, 0.72, 0.86), // pot lifts, tilts and pours
  cup: smoothstep(0.7, 0.8, p), // cup slides in
  calm: smoothstep(0.86, 0.98, p),
});

/** How strongly tea is pouring from the spout, 0..1. */
export const pourFlow = (p: number) => smoothstep(0.5, 0.62, range(p, 0.72, 0.86));
