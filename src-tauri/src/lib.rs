mod document;
mod menu;

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Response;
use tauri::{Emitter, Manager, RunEvent, State};

use document::{DocumentInfo, Library};

/// A file the OS asked us to open (command line, or a double-click in Finder)
/// that the UI has not picked up yet.
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

/// Decoding a page is CPU-bound and can take hundreds of milliseconds, so every
/// command hops onto the blocking pool rather than stalling the IPC runtime.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "The viewer stopped responding while reading the document.".to_string())?
}

#[tauri::command]
async fn open_document(path: String, library: State<'_, Library>) -> Result<DocumentInfo, String> {
    let library = library.inner().clone();
    blocking(move || library.open(&PathBuf::from(path))).await
}

/// Returns raw PNG bytes; Tauri hands them to the frontend as an `ArrayBuffer`
/// without a base64 round-trip.
#[tauri::command]
async fn render_page(
    index: usize,
    width: u32,
    height: u32,
    library: State<'_, Library>,
) -> Result<Response, String> {
    let library = library.inner().clone();
    let png = blocking(move || library.render(index, width, height)).await?;
    Ok(Response::new(png))
}

/// Claimed once by the UI at startup; later requests arrive as `open-file` events.
#[tauri::command]
fn take_pending_open(pending: State<'_, PendingOpen>) -> Option<String> {
    pending.0.lock().ok()?.take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .menu(menu::build)
        .on_menu_event(|app, event| {
            // The menu owns the app's shortcuts; the webview just reacts.
            let _ = app.emit("menu", event.id().0.clone());
        })
        .manage(Library::default())
        .manage(PendingOpen::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            render_page,
            take_pending_open
        ])
        .setup(|app| {
            if let Some(path) = std::env::args_os().nth(1) {
                remember(app.handle(), path.to_string_lossy().into_owned());
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Deja");

    app.run(|handle, event| {
        // macOS delivers double-clicked documents as an event, not as argv.
        if let RunEvent::Opened { urls } = event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                remember(handle, path.to_string_lossy().into_owned());
                let _ = handle.emit("open-file", ());
            }
        }
    });
}

fn remember(handle: &tauri::AppHandle, path: String) {
    if let Ok(mut slot) = handle.state::<PendingOpen>().0.lock() {
        *slot = Some(path);
    }
}
