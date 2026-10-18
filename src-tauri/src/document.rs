//! The one open document, plus the render path that turns a page into PNG bytes.
//!
//! Two memory facts drive the shape of this module:
//!
//! * A `DjVuPage` memoises its decoded layers (background pixmap, mask,
//!   foreground) for as long as the document lives — the crate measures this at
//!   roughly 11 MB per rendered page. Left alone, reading a 1000-page book would
//!   retain gigabytes, so every render is followed by an LRU sweep back down to
//!   [`RENDER_CACHE_BUDGET`]. That is also why this module drives `DjVuDocument`
//!   directly instead of the high-level `djvu_rs::Document` wrapper, which does
//!   not expose the eviction hook.
//! * Nothing is ever rendered above a page's own pixel dimensions. Past native
//!   resolution there is no further detail to recover, so deep zoom costs the
//!   viewer no extra memory — the image is simply scaled up for display.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use djvu_rs::djvu_document::DjVuDocument;
use djvu_rs::djvu_render::{render_pixmap_with_limits, RenderOptions};
use djvu_rs::{Pixmap, Rotation};
use serde::Serialize;

/// Ceiling for retained per-page decode caches. At the crate's measured ~11 MB
/// per page this keeps roughly twenty pages warm, so paging back and forth
/// around the current position is instant while memory stays flat.
const RENDER_CACHE_BUDGET: usize = 256 * 1024 * 1024;

/// Absolute safety net on a single render, in device pixels. The frontend
/// already caps requests at the page's native size; this only catches pages
/// whose native size is itself extreme.
const MAX_RENDER_PIXELS: u64 = 30_000_000;
const MAX_RENDER_DIMENSION: u32 = 12_000;

/// What the UI needs to describe a freshly opened file.
///
/// Every page's size ships with the open, so the viewer can lay out the whole
/// scroll height immediately instead of chasing metadata page by page. The
/// decoder parses page headers eagerly, so this is a field read per page.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub name: String,
    pub pages: Vec<PageSize>,
}

/// A page's native size, already corrected for the page's own rotation.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub width: u32,
    pub height: u32,
    /// Scan resolution, used to turn "100% zoom" into physical size.
    pub dpi: u16,
}

struct OpenDocument {
    doc: DjVuDocument,
}

/// The viewer's shared state: at most one document, open at a time.
#[derive(Clone)]
pub struct Library {
    open: Arc<Mutex<Option<OpenDocument>>>,
    /// Ceiling for retained decode caches; only tests vary it.
    budget: usize,
}

impl Default for Library {
    fn default() -> Self {
        Library::with_budget(RENDER_CACHE_BUDGET)
    }
}

impl Library {
    fn with_budget(budget: usize) -> Self {
        Library {
            open: Arc::new(Mutex::new(None)),
            budget,
        }
    }

    /// Parse `path` and make it the current document.
    pub fn open(&self, path: &Path) -> Result<DocumentInfo, String> {
        let bytes = std::fs::read(path).map_err(|e| format!("Could not read this file: {e}"))?;

        // `parse` handles bundled (self-contained) files; indirect documents
        // keep their pages in sibling files and need the directory resolver.
        let doc = DjVuDocument::parse(&bytes)
            .or_else(|first| {
                let dir = path.parent().unwrap_or_else(|| Path::new("."));
                DjVuDocument::parse_from_dir(&bytes, dir).map_err(|_| first)
            })
            .map_err(|e| format!("This does not look like a DjVu document: {e}"))?;

        // The pages own their chunk bytes now, so the file buffer can go.
        drop(bytes);

        let page_count = doc.page_count();
        if page_count == 0 {
            return Err("This document has no pages.".into());
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        let pages = (0..page_count)
            .map(|index| measure(&doc, index))
            .collect::<Result<Vec<_>, _>>()?;

        *self.lock()? = Some(OpenDocument { doc });

        Ok(DocumentInfo { name, pages })
    }

    /// Render one page at `width × height` device pixels and encode it as PNG.
    pub fn render(&self, index: usize, width: u32, height: u32) -> Result<Vec<u8>, String> {
        let pixmap = self.decode(index, width, height)?;
        encode_png(&pixmap)
    }

    fn decode(&self, index: usize, width: u32, height: u32) -> Result<Pixmap, String> {
        let (width, height) = clamp_render_size(width, height);

        let mut guard = self.lock()?;
        let open = guard.as_mut().ok_or("No document is open.")?;

        let page = open
            .doc
            .page(index)
            .map_err(|e| format!("Page {} could not be read: {e}", index + 1))?;

        // The decoder applies page rotation after rendering. Requests arrive
        // in display space, so quarter turns need pre-rotation dimensions.
        let (width, height) = match page.rotation() {
            Rotation::Cw90 | Rotation::Ccw90 => (height, width),
            _ => (width, height),
        };

        let mut opts = RenderOptions::fit_to_width(page, width);
        opts.height = height;
        let pixmap = render_pixmap_with_limits(page, &opts, page.resource_limits())
            .map_err(|e| format!("Page {} could not be rendered: {e}", index + 1))?;

        // Drop the least-recently-rendered pages' decode caches. The page just
        // rendered is the most recent, so it survives; naming it explicitly
        // makes that a guarantee rather than a consequence of the LRU order.
        open.doc.enforce_cache_budget(self.budget, &[index]);

        Ok(pixmap)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Option<OpenDocument>>, String> {
        self.open
            .lock()
            .map_err(|_| "The document state was left inconsistent by an earlier error.".into())
    }
}

/// A page's size in display space, i.e. after its own declared rotation.
fn measure(doc: &DjVuDocument, index: usize) -> Result<PageSize, String> {
    let page = doc
        .page(index)
        .map_err(|e| format!("Page {} could not be read: {e}", index + 1))?;

    let (w, h) = (page.width() as u32, page.height() as u32);
    let (width, height) = match page.rotation() {
        Rotation::Cw90 | Rotation::Ccw90 => (h, w),
        _ => (w, h),
    };
    Ok(PageSize {
        width: width.max(1),
        height: height.max(1),
        dpi: page.dpi().max(1),
    })
}

/// Shrink a requested render to the pixel budget, preserving aspect ratio.
fn clamp_render_size(width: u32, height: u32) -> (u32, u32) {
    let (w, h) = (width.max(1), height.max(1));
    let by_area = (MAX_RENDER_PIXELS as f64 / (w as f64 * h as f64)).sqrt();
    let by_side = MAX_RENDER_DIMENSION as f64 / w.max(h) as f64;
    let factor = by_area.min(by_side);

    if factor >= 1.0 {
        return (w, h);
    }
    (
        ((w as f64 * factor) as u32).max(1),
        ((h as f64 * factor) as u32).max(1),
    )
}

/// Encode an opaque RGBA pixmap as PNG.
///
/// Scans are overwhelmingly neutral, so drop to a single 8-bit grey channel
/// when no pixel carries colour — a quarter of the bytes to compress and to
/// push across the IPC boundary. Rows are converted and written one at a time
/// so a full second copy of a large page never exists. Alpha is always dropped:
/// rendered DjVu pages are opaque.
fn encode_png(pixmap: &Pixmap) -> Result<Vec<u8>, String> {
    let (width, height) = (pixmap.width, pixmap.height);
    let rgba = pixmap.data.as_slice();
    let grey = rgba
        .chunks_exact(4)
        .all(|px| px[0] == px[1] && px[1] == px[2]);
    let channels = if grey { 1 } else { 3 };

    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(if grey {
        png::ColorType::Grayscale
    } else {
        png::ColorType::Rgb
    });
    encoder.set_depth(png::BitDepth::Eight);
    // Scans are large; favour encode speed over the last few percent of size.
    encoder.set_compression(png::Compression::Fast);

    let mut writer = encoder.write_header().map_err(png_err)?;
    {
        let mut stream = writer.stream_writer().map_err(png_err)?;
        let row_pixels = width as usize;
        let mut row = vec![0u8; row_pixels * channels];

        for src in rgba.chunks_exact(row_pixels * 4) {
            if grey {
                for (dst, px) in row.iter_mut().zip(src.chunks_exact(4)) {
                    *dst = px[0];
                }
            } else {
                for (dst, px) in row.chunks_exact_mut(3).zip(src.chunks_exact(4)) {
                    dst.copy_from_slice(&px[..3]);
                }
            }
            std::io::Write::write_all(&mut stream, &row).map_err(|e| e.to_string())?;
        }
        stream.finish().map_err(png_err)?;
    }
    writer.finish().map_err(png_err)?;

    Ok(out)
}

fn png_err(e: png::EncodingError) -> String {
    format!("Could not encode the page: {e}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use djvu_rs::djvu_encode::{encode_djvm_layered_shared, EncodeQuality};

    const DPI: u16 = 200;
    const PAGE_W: u32 = 420;
    const PAGE_H: u32 = 560;

    /// Write a small multi-page document to a temp path and open it.
    fn sample(pages: usize) -> (Library, std::path::PathBuf) {
        sample_with_budget(pages, RENDER_CACHE_BUDGET)
    }

    fn sample_with_budget(pages: usize, budget: usize) -> (Library, std::path::PathBuf) {
        let pixmaps: Vec<Pixmap> = (0..pages)
            .map(|n| {
                let mut pm = Pixmap::white(PAGE_W, PAGE_H);
                // A band whose height identifies the page, so renders differ.
                for y in 40..(60 + n as u32 * 20) {
                    for x in 40..PAGE_W - 40 {
                        pm.set_rgb(x, y, 0x20, 0x20, 0x20);
                    }
                }
                pm
            })
            .collect();

        let bytes = encode_djvm_layered_shared(&pixmaps, EncodeQuality::Quality, DPI, None, 2)
            .expect("encode");
        let path = std::env::temp_dir().join(format!("deja-test-{pages}-{budget}.djvu"));
        std::fs::write(&path, bytes).expect("write");

        let library = Library::with_budget(budget);
        library.open(&path).expect("open");
        (library, path)
    }

    #[test]
    fn opens_and_reports_every_page_size() {
        let (library, path) = sample(4);
        let info = library.open(&path).expect("reopen");
        assert_eq!(info.pages.len(), 4);
        for size in &info.pages {
            assert_eq!((size.width, size.height), (PAGE_W, PAGE_H));
            assert_eq!(size.dpi, DPI);
        }
        assert!(library.render(9, 100, 100).is_err(), "page past the end must fail");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn renders_a_png() {
        let (library, path) = sample(3);
        let png = library.render(1, PAGE_W, PAGE_H).expect("render");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n", "expected a PNG signature");
        assert!(png.len() > 100);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn quarter_turn_renders_match_display_dimensions() {
        let (library, path) = sample(1);
        let mut bytes = std::fs::read(&path).expect("read sample");
        let info = bytes
            .windows(8)
            .position(|chunk| chunk == b"INFO\0\0\0\x0a")
            .expect("INFO chunk");

        for rotation in [5, 6] {
            bytes[info + 8 + 9] = rotation;
            std::fs::write(&path, &bytes).expect("write rotation");
            let opened = library.open(&path).expect("open rotated page");
            let page = opened.pages[0];
            assert_eq!((page.width, page.height), (PAGE_H, PAGE_W));

            let (width, height) = (page.width / 2, page.height / 2);
            let png = library.render(0, width, height).expect("render rotated page");
            let reader = png::Decoder::new(png.as_slice()).read_info().expect("read PNG");
            assert_eq!(
                (reader.info().width, reader.info().height),
                (width, height),
                "rotation flag {rotation} must preserve the requested display size"
            );
        }
        let _ = std::fs::remove_file(path);
    }

    /// Without eviction, every rendered page would keep its decoded layers for
    /// the life of the document. Render well past a deliberately tiny budget
    /// and check the retained total is actually pulled back down.
    #[test]
    fn render_cache_is_evicted_down_to_the_budget() {
        const PAGES: usize = 10;
        const BUDGET: usize = 64 * 1024;

        let (library, path) = sample_with_budget(PAGES, BUDGET);

        let mut unbounded = 0usize;
        for index in 0..PAGES {
            library.render(index, PAGE_W, PAGE_H).expect("render");
            let guard = library.lock().expect("lock");
            let open = guard.as_ref().expect("open");
            // The page just rendered is protected, so the budget can be
            // exceeded by at most that one page's own cache.
            let held = open.doc.render_cache_bytes();
            let current = open.doc.page(index).expect("page").render_cache_bytes();
            assert!(
                held <= BUDGET + current,
                "after page {index}: held {held} bytes against a {BUDGET} budget"
            );
            unbounded += current;
        }

        assert!(
            unbounded > BUDGET,
            "test is vacuous: {PAGES} pages only decode to {unbounded} bytes, under the budget"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn oversized_requests_are_clamped_in_aspect() {
        let (w, h) = clamp_render_size(200_000, 100_000);
        assert!((w as u64) * (h as u64) <= MAX_RENDER_PIXELS);
        assert!(w <= MAX_RENDER_DIMENSION && h <= MAX_RENDER_DIMENSION);
        // 2:1 going in, 2:1 coming out.
        assert!(((w as f64 / h as f64) - 2.0).abs() < 0.01);
    }

    #[test]
    fn modest_requests_pass_through_untouched() {
        assert_eq!(clamp_render_size(1700, 2200), (1700, 2200));
    }
}
