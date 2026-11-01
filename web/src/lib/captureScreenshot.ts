// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-tap screenshot of the current view for the feedback form (issue #2895,
 * epic #2909). Rasterizes a DOM node to a PNG `File` entirely client-side with
 * `modern-screenshot` (canvas + SVG `foreignObject`), so it needs neither a
 * secure context nor an OS screen picker — `getDisplayMedia` is unusable over
 * the plain-HTTP Tailscale deployment and on iOS Safari.
 *
 * The library is loaded with a dynamic `import()` so it stays out of the main
 * chunk (which once crossed the PWA precache limit, `web/vite.config.ts`) and off
 * every page that never opens the feedback form.
 *
 * The capture is bounded (R7): the long edge is capped, the canvas size is
 * capped, the library load and each rendering attempt have a deadline after
 * which the caller stops waiting, and a failed or oversize first attempt is
 * retried once at a smaller scale. A blank or empty image counts as a failed
 * render.
 * When the retry fails the function throws, unless the first attempt rendered
 * an over-budget image; the caller shows a non-fatal toast (R4). An over-budget
 * image is returned rather than thrown, so the attachment planner surfaces its
 * standard total-size rejection.
 *
 * Framework-agnostic (no React imports) — the feedback modal owns consent, the
 * preview, and the attachment list.
 */

/** Longest edge of a captured screenshot, in output pixels (R7). */
export const SCREENSHOT_MAX_EDGE_PX = 2560;

/** Upper bound on the capture scale, whatever the device pixel ratio (R7). */
export const SCREENSHOT_MAX_SCALE = 2;

/** Scale multiplier for the single retry after a failed or oversize attempt. */
export const SCREENSHOT_RETRY_SCALE_FACTOR = 0.5;

/**
 * Deadline for loading the library and for each rendering attempt (ms). After
 * it the caller stops waiting and retries or throws. The library cannot be
 * cancelled, so an abandoned render finishes in the background and its result
 * is discarded.
 */
export const SCREENSHOT_ATTEMPT_DEADLINE_MS = 20_000;

/**
 * Media/fetch `timeout` handed to `modern-screenshot` (ms). It must stay well
 * under the attempt deadline: before rendering, the library waits this long on
 * every `<img>` in the page, and a lazy image scrolled out of view never loads,
 * so a timeout at the deadline's length would fail every such capture. The
 * library also applies it to its final draw, where it yields a blank image;
 * {@link isBlankRender} catches that case instead.
 */
export const SCREENSHOT_MEDIA_TIMEOUT_MS = 8_000;

/** Full-width rows read when checking a render for blankness. */
export const BLANK_CHECK_ROWS = 48;

export interface CaptureScreenshotOptions {
  /**
   * Bytes still free in the attachment budget. A first capture larger than this
   * is retried once at a smaller scale.
   */
  maxBytes?: number;
}

/**
 * PURE. The capture scale for a node of `width` x `height` CSS pixels: the
 * device pixel ratio, capped at {@link SCREENSHOT_MAX_SCALE} and reduced further
 * so the long edge stays within {@link SCREENSHOT_MAX_EDGE_PX}.
 */
export function computeCaptureScale(
  width: number,
  height: number,
  devicePixelRatio: number
): number {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  const longEdge = Math.max(width, height);
  const edgeCap =
    Number.isFinite(longEdge) && longEdge > 0
      ? SCREENSHOT_MAX_EDGE_PX / longEdge
      : SCREENSHOT_MAX_SCALE;
  return Math.min(dpr, SCREENSHOT_MAX_SCALE, edgeCap);
}

function isTransparent(color: string): boolean {
  const normalized = color.replace(/\s+/g, "").toLowerCase();
  return (
    normalized === "" ||
    normalized === "transparent" ||
    normalized.startsWith("rgba(0,0,0,0)")
  );
}

/**
 * The page background lives on `html`/`body` (`web/src/index.css`), not on the
 * captured node, so an uncaptured background would come out transparent. Read
 * the resolved color rather than a token name — a canvas `fillStyle` cannot
 * resolve `var(...)`.
 */
export function resolveCaptureBackground(doc: Document): string | undefined {
  const view = doc.defaultView;
  if (!view) return undefined;
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue;
    const color = view.getComputedStyle(el).backgroundColor;
    if (color && !isTransparent(color)) return color;
  }
  return undefined;
}

/**
 * True when a rendered canvas holds no picture: it has no pixels, or every
 * pixel in {@link BLANK_CHECK_ROWS} evenly spaced full-width rows is the same
 * color. The library returns such a canvas instead of failing when its final
 * draw times out or decodes to nothing; any real view of the app has a header,
 * borders or text crossing some of those rows. Returns false when the canvas
 * cannot be read, which leaves the decision to the encoder.
 */
export function isBlankRender(canvas: HTMLCanvasElement): boolean {
  const { width, height } = canvas;
  if (width === 0 || height === 0) return true;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const rows = Math.min(BLANK_CHECK_ROWS, height);
  let first: Uint8ClampedArray | null = null;
  for (let r = 0; r < rows; r++) {
    const y = Math.floor(((r + 0.5) * height) / rows);
    const { data } = ctx.getImageData(0, y, width, 1);
    first ??= data.slice(0, 4);
    for (let i = 0; i < data.length; i += 4) {
      if (
        data[i] !== first[0] ||
        data[i + 1] !== first[1] ||
        data[i + 2] !== first[2] ||
        data[i + 3] !== first[3]
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Encode a canvas as PNG. Rejects instead of resolving an empty Blob, because
 * the server refuses an empty attachment (the library's own encoder falls back
 * to `toDataURL()`, which yields a 0-byte Blob on a canvas without memory).
 */
function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob && blob.size > 0) resolve(blob);
      else reject(new Error("Screenshot could not be encoded"));
    }, "image/png");
  });
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Screenshot timed out after ${ms} ms`)),
      ms
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Capture `target` as a PNG `File` named `feedback-screenshot-<ms>.png`.
 * Throws when the library fails to load, or when the retry fails and the first
 * attempt produced no image to fall back on.
 */
export async function captureViewportPng(
  target: HTMLElement,
  opts: CaptureScreenshotOptions = {}
): Promise<File> {
  // Under the deadline too: a stalled chunk download must end in the caller's
  // toast, not leave the form busy indefinitely.
  const { domToCanvas } = await withDeadline(
    import("modern-screenshot"),
    SCREENSHOT_ATTEMPT_DEADLINE_MS
  );
  const doc = target.ownerDocument;
  const rect = target.getBoundingClientRect();
  const width = rect.width || target.clientWidth;
  const height = rect.height || target.clientHeight;
  const dpr = doc.defaultView?.devicePixelRatio ?? 1;
  const backgroundColor = resolveCaptureBackground(doc);
  const firstScale = computeCaptureScale(width, height, dpr);

  const render = (scale: number): Promise<Blob> =>
    withDeadline(
      (async () => {
        const canvas = await domToCanvas(target, {
          scale,
          maximumCanvasSize: SCREENSHOT_MAX_EDGE_PX,
          timeout: SCREENSHOT_MEDIA_TIMEOUT_MS,
          backgroundColor,
          // Off by default in the library: without it a scrolled chat renders
          // from its top, not the part the user is looking at. The other
          // features (including Safari's image-decode fix) stay at their
          // default.
          features: { restoreScrollPosition: true },
        });
        if (isBlankRender(canvas)) {
          throw new Error("Screenshot rendered a blank image");
        }
        return canvasToPng(canvas);
      })(),
      SCREENSHOT_ATTEMPT_DEADLINE_MS
    );
  const toFile = (blob: Blob): File =>
    new File([blob], `feedback-screenshot-${Date.now()}.png`, {
      type: "image/png",
    });

  let first: Blob | null = null;
  try {
    first = await render(firstScale);
  } catch {
    // Fall through to the single smaller-scale retry below.
  }
  if (
    first !== null &&
    (opts.maxBytes === undefined || first.size <= opts.maxBytes)
  ) {
    return toFile(first);
  }
  try {
    return toFile(await render(firstScale * SCREENSHOT_RETRY_SCALE_FACTOR));
  } catch (error) {
    // An over-budget first image still beats an error: the planner rejects it
    // with the total-size message instead of "couldn't capture".
    if (first !== null) return toFile(first);
    throw error;
  }
}
