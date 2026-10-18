import { invoke } from "@tauri-apps/api/core";

/** A page's native pixel size, plus the scan resolution behind it. */
export interface PageSize {
  width: number;
  height: number;
  dpi: number;
}

export interface DocumentInfo {
  name: string;
  /** Every page's size, so the viewer can lay out the full scroll immediately. */
  pages: PageSize[];
}

export const openDocument = (path: string) =>
  invoke<DocumentInfo>("open_document", { path });

/**
 * Normalise whatever shape the IPC hands back into something `Blob` accepts.
 *
 * The custom-protocol transport returns an `ArrayBuffer`, but if it is ever
 * unavailable Tauri falls back to `postMessage`, where macOS serialises a raw
 * response as a plain array of byte values. Passing that array to `Blob`
 * straight would stringify it into `"137,80,78,..."` — a file that is not a
 * PNG — so it is rebuilt into real bytes here instead.
 */
function toBytes(payload: ArrayBuffer | Uint8Array | number[]): BlobPart {
  return payload instanceof ArrayBuffer ? payload : new Uint8Array(payload);
}

/** Renders a page and hands back PNG bytes, already wrapped as a blob. */
export async function renderPage(
  index: number,
  width: number,
  height: number,
): Promise<Blob> {
  const payload = await invoke<ArrayBuffer | Uint8Array | number[]>("render_page", {
    index,
    width,
    height,
  });
  return new Blob([toBytes(payload)], { type: "image/png" });
}

/** A file the OS asked us to open; null once claimed. */
export const takePendingOpen = () => invoke<string | null>("take_pending_open");

