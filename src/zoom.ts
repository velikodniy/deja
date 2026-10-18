import type { PageSize } from "./api";

export type Zoom =
  | { kind: "fit-width" }
  | { kind: "fit-page" }
  | { kind: "scale"; value: number };

/** Zoom stops the −/+ commands walk through. */
const STOPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3, 4];

export const MIN_SCALE = STOPS[0]!;
export const MAX_SCALE = STOPS[STOPS.length - 1]!;

/** Breathing room around a page, matching `.doc` padding in the stylesheet. */
export const GAP = 20;

/**
 * At 100% a page is shown at its physical size: a 300-DPI scan maps its own
 * pixels down to CSS pixels at 96/300, so "100%" means "actual size" rather
 * than "one image pixel per CSS pixel".
 */
function actualSize(page: PageSize) {
  const perPixel = 96 / Math.max(page.dpi, 1);
  return { width: page.width * perPixel, height: page.height * perPixel };
}

/**
 * One scale for the whole document.
 *
 * The fit modes measure the *largest* page rather than the current one, so the
 * promise they make ("this fits") holds for every page and the layout never
 * shifts under the reader mid-scroll. In the usual case of uniformly sized
 * pages this is identical to fitting each page on its own.
 */
export function resolveScale(
  pages: PageSize[],
  zoom: Zoom,
  viewport: { width: number; height: number },
): number {
  if (zoom.kind === "scale") return clamp(zoom.value, MIN_SCALE, MAX_SCALE);

  let widest = 1;
  let tallest = 1;
  for (const page of pages) {
    const actual = actualSize(page);
    widest = Math.max(widest, actual.width);
    tallest = Math.max(tallest, actual.height);
  }

  const available = {
    width: Math.max(viewport.width - GAP * 2, 1),
    height: Math.max(viewport.height - GAP * 2, 1),
  };

  const scale =
    zoom.kind === "fit-width"
      ? available.width / widest
      : Math.min(available.width / widest, available.height / tallest);

  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/** A page's on-screen box at the document's current scale. */
export function pageBox(page: PageSize, scale: number) {
  const actual = actualSize(page);
  return {
    width: Math.round(actual.width * scale),
    height: Math.round(actual.height * scale),
  };
}

/**
 * The render size to ask the backend for, in device pixels.
 *
 * Capped at the page's own resolution: there is no detail above it, so deep
 * zoom costs no extra decoding or memory and is simply scaled up for display.
 */
export function renderSize(page: PageSize, cssWidth: number, dpr: number) {
  const width = Math.max(1, Math.min(Math.round(cssWidth * dpr), page.width));
  const height = Math.max(1, Math.round((width * page.height) / page.width));
  return { width, height };
}

/** Next stop above (dir 1) or below (dir -1) the current scale. */
export function step(scale: number, dir: 1 | -1): number {
  const epsilon = 1e-4;
  if (dir === 1) return STOPS.find((s) => s > scale + epsilon) ?? MAX_SCALE;
  return [...STOPS].reverse().find((s) => s < scale - epsilon) ?? MIN_SCALE;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const formatScale = (scale: number) => `${Math.round(scale * 100)}%`;
