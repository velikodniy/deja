# Deja

A simple DjVu viewer for macOS. Open documents, scroll through pages, and zoom.

## Using Deja

- **Open:** drag a `.djvu` file onto the window, click the folder button, or press `⌘O`.
- **Read:** scroll, or use the arrow keys, Space, and Page Up / Page Down.
- **Zoom:** pinch the trackpad or use `Ctrl`/`⌘`-scroll to zoom around the pointer.
  Toolbar buttons and `⌘=` / `⌘-` zoom around the centre of the document viewing area.
- **Fit:** choose Fit Width or Fit Page in the toolbar or View menu.
- **Jump to a page:** press `⌘G`. Use `Home` / `End` for the first or last page.

At 100% zoom (`⌘0`), pages appear at their original printed size.
Zoom anchoring stops at document edges; pages narrower than the viewing area stay centred.

## Development

### Prerequisites

- macOS with Xcode Command Line Tools (`xcode-select --install`).
- Node.js 22 LTS (22.12 or later) or 24 LTS, with npm.
- [Rust](https://rustup.rs/) 1.88 or later, with Cargo.

### Run locally

From the repository root:

```sh
npm ci
npm run tauri dev
```

This starts the Vite development server and opens the native app with hot reload
for frontend changes.

### Build the app

```sh
npm run tauri build
```

This builds the frontend and Rust backend in release mode, then creates
`src-tauri/target/release/bundle/macos/Deja.app`.

To check and build only the frontend, run `npm run build`.
