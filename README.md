# Deja

A simple DjVu viewer for macOS. Open documents, scroll through pages, and zoom.

## Download

Download a disk image (`.dmg`) or zipped app from
[GitHub Releases](https://github.com/velikodniy/deja/releases).
Both include a universal macOS app for Apple Silicon and Intel.
Open the disk image and drag Deja into Applications, or unzip the app and move it there.

Release builds are currently unsigned and not notarized, so macOS Gatekeeper may
block opening them. Only override the warning in System Settings → Privacy & Security
if you trust the downloaded build.

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

### Releases

The `Release macOS` workflow tests the Rust backend, builds the frontend and
universal macOS app, and publishes `.dmg` and `.app.zip` assets to a GitHub Release
when a `v*` tag is pushed. No Windows or Linux binaries are built.

Before tagging, update the version in `package.json`, `package-lock.json`,
`src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`
to match the release. Commit those changes, then push a tag, for example:

```sh
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

The workflow can also be run manually from GitHub Actions to verify a build
without publishing a release, even when targeting an existing tag. Download those
binaries from the run's `macos-universal` artifact.

Signing and notarization are not configured; the workflow does not require Apple
developer credentials.

## License

[MIT](LICENSE) © 2026 Vadim Velicodnii.
