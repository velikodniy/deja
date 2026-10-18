import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { openDocument, takePendingOpen, type DocumentInfo } from "./api";
import { PageView, type ZoomAnchor } from "./pageview";
import { clamp, formatScale, MAX_SCALE, MIN_SCALE, resolveScale, step, type Zoom } from "./zoom";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  app: el("app"),
  stage: el("stage"),
  doc: el("doc"),
  loading: el("loading"),
  toast: el("toast"),
  docName: el("doc-name"),
  pageInput: el<HTMLInputElement>("page-input"),
  pageCount: el("page-count"),
  zoomLevel: el<HTMLButtonElement>("zoom-level"),
  prev: el<HTMLButtonElement>("prev"),
  next: el<HTMLButtonElement>("next"),
  fitWidth: el<HTMLButtonElement>("fit-width"),
  fitPage: el<HTMLButtonElement>("fit-page"),
};

let info: DocumentInfo | null = null;
let zoom: Zoom = { kind: "fit-width" };
let scale = 1;

const view = new PageView(ui.stage, ui.doc, {
  onCurrentChange: syncPager,
  onBusyChange: setBusy,
  onError: reportError,
});

// ── Document loading ────────────────────────────────────────────────────────

// Keep backend selection and UI updates in the same order, including after a
// failed open. The backend holds one document, so response filtering is not enough.
let loadQueue = Promise.resolve();

function load(path: string): Promise<void> {
  loadQueue = loadQueue.then(async () => {
    try {
      const opened = await openDocument(path);
      info = opened;
      ui.app.dataset.state = "ready";
      ui.docName.textContent = opened.name;
      ui.pageCount.textContent = String(opened.pages.length);
      void getCurrentWindow().setTitle(`${opened.name} — Deja`);

      view.setDocument(opened);
      applyZoom();
      syncPager(0);
      dismissError();
      ui.stage.focus();
    } catch (error) {
      reportError(error);
    }
  });
  return loadQueue;
}

async function pickFile() {
  const path = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "DjVu Document", extensions: ["djvu", "djv"] }],
  });
  if (typeof path === "string") await load(path);
}

// ── Zoom ────────────────────────────────────────────────────────────────────

function applyZoom(anchor?: ZoomAnchor) {
  if (!info) return;
  scale = resolveScale(info.pages, zoom, {
    width: ui.stage.clientWidth,
    height: ui.stage.clientHeight,
  });
  view.setScale(scale, anchor);
  syncZoom();
}

function setZoom(next: Zoom, anchor?: ZoomAnchor) {
  zoom = next;
  applyZoom(anchor);
}

const zoomBy = (dir: 1 | -1) => setZoom({ kind: "scale", value: step(scale, dir) });

// ── Commands, shared by the menu, the toolbar and the keyboard ──────────────

const commands: Record<string, () => void> = {
  open: () => void pickFile(),
  "zoom-in": () => zoomBy(1),
  "zoom-out": () => zoomBy(-1),
  "zoom-actual": () => setZoom({ kind: "scale", value: 1 }),
  "fit-width": () => setZoom({ kind: "fit-width" }),
  "fit-page": () => setZoom({ kind: "fit-page" }),
  "next-page": () => view.scrollToPage(view.currentPage + 1),
  "previous-page": () => view.scrollToPage(view.currentPage - 1),
  "first-page": () => view.scrollToPage(0),
  "last-page": () => view.scrollToPage(view.pageCount - 1),
  "goto-page": () => ui.pageInput.focus(),
};

const run = (id: string) => commands[id]?.();

// ── UI sync ─────────────────────────────────────────────────────────────────

function syncPager(current: number) {
  if (!info) return;
  if (document.activeElement !== ui.pageInput) {
    ui.pageInput.value = String(current + 1);
  }
  ui.pageInput.size = String(info.pages.length).length;
  ui.prev.disabled = current <= 0;
  ui.next.disabled = current >= info.pages.length - 1;
}

function syncZoom() {
  ui.zoomLevel.textContent = formatScale(scale);
  ui.fitWidth.setAttribute("aria-pressed", String(zoom.kind === "fit-width"));
  ui.fitPage.setAttribute("aria-pressed", String(zoom.kind === "fit-page"));
}

/** Shows the sweep bar only if the work outlasts a glance. */
let busyTimer: number | undefined;

function setBusy(busy: boolean) {
  window.clearTimeout(busyTimer);
  if (!busy) {
    delete ui.loading.dataset.busy;
    return;
  }
  busyTimer = window.setTimeout(() => {
    ui.loading.dataset.busy = "true";
  }, 180);
}

let toastTimer: number | undefined;

function reportError(error: unknown) {
  const message = typeof error === "string" ? error : ((error as Error)?.message ?? String(error));
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(dismissError, 6000);
}

function dismissError() {
  window.clearTimeout(toastTimer);
  ui.toast.hidden = true;
}

// ── Events ──────────────────────────────────────────────────────────────────

el("open").addEventListener("click", () => run("open"));
el("open-empty").addEventListener("click", () => run("open"));
ui.prev.addEventListener("click", () => run("previous-page"));
ui.next.addEventListener("click", () => run("next-page"));
el("zoom-in").addEventListener("click", () => run("zoom-in"));
el("zoom-out").addEventListener("click", () => run("zoom-out"));
ui.zoomLevel.addEventListener("click", () => run("zoom-actual"));
ui.fitWidth.addEventListener("click", () => run("fit-width"));
ui.fitPage.addEventListener("click", () => run("fit-page"));

// The native menu owns every ⌘-shortcut; here we only react to what it emits.
void listen<string>("menu", (event) => run(event.payload));

ui.pageInput.addEventListener("focus", () => ui.pageInput.select());
ui.pageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const wanted = Number.parseInt(ui.pageInput.value, 10);
    if (Number.isFinite(wanted)) view.scrollToPage(wanted - 1);
    ui.pageInput.blur();
    ui.stage.focus();
  } else if (event.key === "Escape") {
    ui.pageInput.blur();
    ui.stage.focus();
  }
  event.stopPropagation();
});
ui.pageInput.addEventListener("blur", () => syncPager(view.currentPage));

// Re-fit on resize, but only once the drag settles.
let resizeTimer: number | undefined;
window.addEventListener("resize", () => {
  if (!info || zoom.kind === "scale") return;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(applyZoom, 120);
});

// WebKit reports native trackpad pinches as cumulative gesture scales.
type PinchEvent = Event & { scale: number; clientX: number; clientY: number };
let gestureScale: number | null = null;

ui.stage.addEventListener("gesturestart", (event) => {
  event.preventDefault();
  if (info) gestureScale = (event as PinchEvent).scale;
}, { passive: false });

ui.stage.addEventListener("gesturechange", (event) => {
  if (gestureScale === null) return;
  event.preventDefault();
  const pinch = event as PinchEvent;
  const value = clamp(scale * pinch.scale / gestureScale, MIN_SCALE, MAX_SCALE);
  gestureScale = pinch.scale;
  setZoom({ kind: "scale", value }, { x: pinch.clientX, y: pinch.clientY });
}, { passive: false });

ui.stage.addEventListener("gestureend", (event) => {
  if (gestureScale === null) return;
  event.preventDefault();
  gestureScale = null;
}, { passive: false });

// Ctrl/⌘ + wheel is the conventional zoom gesture; plain wheel keeps scrolling.
ui.stage.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (!info || gestureScale !== null) return;
    setZoom(
      { kind: "scale", value: clamp(scale * Math.exp(-event.deltaY / 320), MIN_SCALE, MAX_SCALE) },
      { x: event.clientX, y: event.clientY },
    );
  },
  { passive: false },
);

// Arrows, space and Page Up/Down are left to the browser so they scroll the
// document the way they do everywhere else.
document.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!info) return;

  if (event.key === "Home") {
    event.preventDefault();
    run("first-page");
  } else if (event.key === "End") {
    event.preventDefault();
    run("last-page");
  }
});

// Clicking the page area hands keyboard scrolling back to it.
ui.stage.addEventListener("pointerdown", () => ui.stage.focus());

// ── Drag & drop, and files handed over by the OS ────────────────────────────

const isDjvu = (path: string) => /\.djvu?$/i.test(path);

void getCurrentWebview().onDragDropEvent(({ payload }) => {
  if (payload.type === "over") {
    ui.app.dataset.dropping = "true";
  } else if (payload.type === "drop") {
    delete ui.app.dataset.dropping;
    const path = payload.paths.find(isDjvu);
    if (path) void load(path);
    else if (payload.paths.length) reportError("That is not a DjVu file.");
  } else {
    delete ui.app.dataset.dropping;
  }
});

async function claimPendingOpen() {
  const path = await takePendingOpen();
  if (path) await load(path);
}

void listen("open-file", () => void claimPendingOpen())
  .then(() => claimPendingOpen())
  .catch(reportError);

if (navigator.userAgent.includes("Mac OS X")) ui.app.dataset.platform = "macos";

syncZoom();
