import { renderPage, type DocumentInfo } from "./api";
import { GAP, pageBox, renderSize } from "./zoom";

/**
 * How far outside the viewport a page is still worth having ready. This is the
 * read-ahead: pages just past the edge decode while the reader is still looking
 * at the current one. Sized to reach into the neighbouring page at the zoom
 * levels people actually read at, without holding half the book in memory when
 * zoomed far out.
 */
const OVERSCAN = "1200px 0px";

/** Concurrent renders. The backend serialises decoding anyway; this just keeps
 * the queue from running far ahead of where the reader actually is. */
const MAX_IN_FLIGHT = 3;

export interface PageViewHooks {
  onCurrentChange(index: number): void;
  onBusyChange(busy: boolean): void;
  onError(message: string): void;
}

/** Zoom origin in viewport (client) coordinates. */
export interface ZoomAnchor {
  x: number;
  y: number;
}

/**
 * The scrolling page list.
 *
 * Every page gets a correctly-sized box up front, so the scrollbar is honest
 * from the moment a document opens, but only the pages near the viewport hold
 * an image. A thousand-page book therefore costs a thousand empty divs rather
 * than a thousand decoded scans.
 */
export class PageView {
  private info: DocumentInfo | null = null;
  private sheets: HTMLElement[] = [];
  private scale = Number.NaN;
  private current = 0;
  // Scroll offsets may be rounded to whole CSS pixels. Carry the remainder
  // forward so hundreds of tiny gesture updates do not accumulate anchor drift.
  private zoomScroll = { left: 0, top: 0, remainderX: 0, remainderY: 0 };

  private readonly visible = new Set<number>();
  private readonly rendered = new Map<number, { url: string; generation: number }>();
  private readonly inFlight = new Set<number>();
  private queue: number[] = [];

  /** Bumped whenever existing images stop being valid, so late replies are dropped. */
  private generation = 0;
  private observer: IntersectionObserver;
  private scrollFrame = 0;
  /** Pages are only watched once they have a real size — see `setScale`. */
  private watching = false;

  constructor(
    private readonly stage: HTMLElement,
    private readonly docEl: HTMLElement,
    private readonly hooks: PageViewHooks,
  ) {
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) this.visible.add(index);
          else this.visible.delete(index);
        }
        this.reconcile();
        this.updateCurrent();
      },
      { root: this.stage, rootMargin: OVERSCAN },
    );

    this.stage.addEventListener(
      "scroll",
      () => {
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
          this.scrollFrame = 0;
          this.updateCurrent();
        });
      },
      { passive: true },
    );
  }

  get pageCount() {
    return this.info?.pages.length ?? 0;
  }

  get currentPage() {
    return this.current;
  }

  /** Replace the document. Caller follows with `setScale`. */
  setDocument(info: DocumentInfo) {
    this.generation += 1;
    for (const index of [...this.rendered.keys()]) this.release(index);
    this.observer.disconnect();
    this.visible.clear();
    this.queue = [];
    this.current = 0;
    this.info = info;
    // Forces the next setScale to count as a change and lay everything out.
    this.scale = Number.NaN;
    this.zoomScroll = { left: 0, top: 0, remainderX: 0, remainderY: 0 };

    this.sheets = info.pages.map((_, index) => {
      const sheet = document.createElement("figure");
      sheet.className = "sheet";
      sheet.dataset.page = String(index);
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      sheet.append(img);
      return sheet;
    });

    this.docEl.replaceChildren(...this.sheets);
    this.watching = false;
    this.stage.scrollTop = 0;
  }

  /** Resize pages around a client point, defaulting to the viewing area's centre. */
  setScale(scale: number, point?: ZoomAnchor) {
    const changed = scale !== this.scale;
    this.scale = scale;
    if (!this.info) return;

    const stage = this.stage.getBoundingClientRect();
    point ??= {
      x: stage.left + this.stage.clientLeft + this.stage.clientWidth / 2,
      y: stage.top + this.stage.clientTop + this.stage.clientHeight / 2,
    };

    // Find the page under the anchor, independently of the current-page indicator.
    // In a gap, use the following page's edge; gap/padding pixels do not scale.
    let lo = 0;
    let hi = this.sheets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sheets[mid]!.getBoundingClientRect().bottom < point.y) lo = mid + 1;
      else hi = mid;
    }
    const anchor = this.sheets[lo];
    const before = anchor?.getBoundingClientRect();
    const anchored = before && before.width > 0 && before.height > 0;
    const remainderX =
      this.stage.scrollLeft === this.zoomScroll.left ? this.zoomScroll.remainderX : 0;
    const remainderY =
      this.stage.scrollTop === this.zoomScroll.top ? this.zoomScroll.remainderY : 0;
    const left = (before?.left ?? 0) - remainderX;
    const top = (before?.top ?? 0) - remainderY;
    const x = anchored ? Math.min(Math.max((point.x - left) / before.width, 0), 1) : 0;
    const y = anchored ? Math.min(Math.max((point.y - top) / before.height, 0), 1) : 0;

    this.info.pages.forEach((page, index) => {
      const sheet = this.sheets[index];
      if (!sheet) return;
      const box = pageBox(page, scale);
      sheet.style.width = `${box.width}px`;
      sheet.style.height = `${box.height}px`;
    });

    if (anchor && anchored) {
      const after = anchor.getBoundingClientRect();
      // The browser clamps these offsets at the document edges. Measure after
      // layout so centring and fixed page gaps are included in the correction.
      const targetLeft = this.stage.scrollLeft + after.left + x * after.width - (left + x * before.width);
      const targetTop = this.stage.scrollTop + after.top + y * after.height - (top + y * before.height);
      this.stage.scrollLeft = targetLeft;
      this.stage.scrollTop = targetTop;
      this.zoomScroll.left = this.stage.scrollLeft;
      this.zoomScroll.top = this.stage.scrollTop;
      // A clamped anchor must not create "zoom debt" when direction reverses.
      this.zoomScroll.remainderX =
        targetLeft >= 0 && targetLeft <= this.stage.scrollWidth - this.stage.clientWidth
          ? targetLeft - this.stage.scrollLeft : 0;
      this.zoomScroll.remainderY =
        targetTop >= 0 && targetTop <= this.stage.scrollHeight - this.stage.clientHeight
          ? targetTop - this.stage.scrollTop : 0;
    }

    if (!this.watching) {
      // First layout: start watching now that every page has a real box, so the
      // observer reports the handful of pages actually on screen rather than
      // the whole document stacked at zero height.
      this.watching = true;
      for (const sheet of this.sheets) this.observer.observe(sheet);
      return;
    }

    if (changed) {
      // Existing images stay on screen, stretched, until their replacement
      // arrives — re-rendering should never flash the page white.
      this.generation += 1;
      this.reconcile();
    }
  }

  scrollToPage(index: number) {
    const target = Math.min(Math.max(index, 0), this.pageCount - 1);
    if (!this.sheets[target]) return;
    this.stage.scrollTo({ top: this.topOf(target) - GAP });
    // Reflect the jump immediately rather than waiting for the scroll handler.
    this.setCurrent(target);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private reconcile() {
    for (const index of [...this.rendered.keys()]) {
      if (!this.visible.has(index)) this.release(index);
    }

    this.queue = [...this.visible]
      .filter((index) => this.needsRender(index) && !this.inFlight.has(index))
      .sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current));

    this.pump();
  }

  private pump() {
    while (this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const index = this.queue.shift()!;
      if (!this.visible.has(index) || !this.needsRender(index) || this.inFlight.has(index)) {
        continue;
      }
      void this.render(index);
    }
  }

  private needsRender(index: number) {
    const entry = this.rendered.get(index);
    return !entry || entry.generation !== this.generation;
  }

  private async render(index: number) {
    const page = this.info?.pages[index];
    if (!page) return;

    const token = this.generation;
    this.inFlight.add(index);
    this.hooks.onBusyChange(true);

    try {
      const box = pageBox(page, this.scale);
      const size = renderSize(page, box.width, window.devicePixelRatio || 1);
      const blob = await renderPage(index, size.width, size.height);
      if (token !== this.generation || !this.visible.has(index)) return;

      const url = URL.createObjectURL(blob);
      const previous = this.rendered.get(index);
      this.rendered.set(index, { url, generation: token });

      const img = this.sheets[index]?.firstElementChild as HTMLImageElement | undefined;
      if (img) img.src = url;
      if (previous) URL.revokeObjectURL(previous.url);
    } catch (error) {
      if (token === this.generation) {
        this.hooks.onError(typeof error === "string" ? error : String(error));
      }
    } finally {
      this.inFlight.delete(index);
      this.hooks.onBusyChange(this.inFlight.size > 0);
      // Invalidated requests were excluded from the replacement queue while
      // in flight. Requeue them now, without automatically retrying failures
      // from the current generation.
      if (token !== this.generation) this.reconcile();
      else this.pump();
    }
  }

  /** Drop a page's image once it is well clear of the viewport. */
  private release(index: number) {
    const entry = this.rendered.get(index);
    if (!entry) return;
    this.rendered.delete(index);
    URL.revokeObjectURL(entry.url);
    (this.sheets[index]?.firstElementChild as HTMLImageElement | undefined)?.removeAttribute("src");
  }

  // ── Position ──────────────────────────────────────────────────────────────

  /** A sheet's offset within the scrollable content. */
  private topOf(index: number) {
    const sheet = this.sheets[index];
    if (!sheet) return 0;
    return (
      sheet.getBoundingClientRect().top -
      this.stage.getBoundingClientRect().top +
      this.stage.scrollTop
    );
  }

  /** The current page is whichever fills most of the viewport. */
  private updateCurrent() {
    const stage = this.stage.getBoundingClientRect();
    let best = this.current;
    let bestOverlap = -Infinity;

    for (const index of this.visible) {
      const rect = this.sheets[index]?.getBoundingClientRect();
      if (!rect) continue;
      const overlap = Math.min(rect.bottom, stage.bottom) - Math.max(rect.top, stage.top);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = index;
      }
    }

    this.setCurrent(best);
  }

  private setCurrent(index: number) {
    if (index === this.current) return;
    this.current = index;
    this.hooks.onCurrentChange(index);
  }
}
