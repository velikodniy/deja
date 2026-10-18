//! Dev helper: writes a multi-page sample DjVu so the viewer can be exercised
//! without hunting down a real scan. Not part of the app.

use djvu_rs::djvu_encode::{encode_djvm_layered_shared, EncodeQuality};
use djvu_rs::Pixmap;

/// 5x7 bitmap digits, one byte per row, bit 4 = leftmost column.
const DIGITS: [[u8; 7]; 10] = [
    [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E], // 0
    [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E], // 1
    [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F], // 2
    [0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E], // 3
    [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02], // 4
    [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E], // 5
    [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E], // 6
    [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08], // 7
    [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E], // 8
    [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C], // 9
];

fn fill(pm: &mut Pixmap, x0: u32, y0: u32, w: u32, h: u32, v: u8) {
    for y in y0..(y0 + h).min(pm.height) {
        for x in x0..(x0 + w).min(pm.width) {
            pm.set_rgb(x, y, v, v, v);
        }
    }
}

fn digit(pm: &mut Pixmap, d: usize, x0: u32, y0: u32, scale: u32) {
    for (row, bits) in DIGITS[d].iter().enumerate() {
        for col in 0..5u32 {
            if bits & (1 << (4 - col)) != 0 {
                fill(pm, x0 + col * scale, y0 + row as u32 * scale, scale, scale, 0x20);
            }
        }
    }
}

fn main() {
    let (w, h, dpi) = (1700u32, 2200u32, 200u16);
    let pages: Vec<Pixmap> = (1..=12)
        .map(|n: u32| {
            let mut pm = Pixmap::white(w, h);

            // Big page number, centred near the top.
            let text: Vec<usize> = n.to_string().bytes().map(|b| (b - b'0') as usize).collect();
            let scale = 22;
            let span = text.len() as u32 * 6 * scale;
            let mut x = (w - span) / 2;
            for d in text {
                digit(&mut pm, d, x, 240, scale);
                x += 6 * scale;
            }

            // Text-like ruled lines so zooming shows fine detail.
            for i in 0..26u32 {
                let y = 600 + i * 58;
                let width = if i % 7 == 6 { 640 } else { 1180 };
                fill(&mut pm, 260, y, width, 14, 0x28);
                fill(&mut pm, 260, y + 24, width * 3 / 4, 10, 0x55);
            }

            // A grey figure block, to exercise the background layer.
            fill(&mut pm, 260, 1660, 1180, 340, 0xC8);
            for i in 0..12u32 {
                fill(&mut pm, 300 + i * 96, 1700, 48, 260 - i * 12, 0x78);
            }
            pm
        })
        .collect();

    let bytes = encode_djvm_layered_shared(&pages, EncodeQuality::Quality, dpi, None, 2)
        .expect("encode failed");
    let out = std::env::args().nth(1).expect("usage: make_sample <out.djvu>");
    std::fs::write(&out, &bytes).expect("write failed");
    println!("wrote {out} ({} pages, {} KB)", pages.len(), bytes.len() / 1024);
}
