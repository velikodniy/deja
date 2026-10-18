//! The native application menu.
//!
//! Every custom item emits its id to the frontend as an `menu` event; the
//! accelerators listed here are the app's canonical shortcuts, so the webview
//! deliberately leaves these key combinations alone.

use tauri::menu::{AboutMetadataBuilder, Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, label: &str, accel: &str| {
        MenuItemBuilder::with_id(id, label)
            .accelerator(accel)
            .build(app)
    };

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("open", "Open…", "CmdOrCtrl+O")?)
        .separator()
        .close_window()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("zoom-in", "Zoom In", "CmdOrCtrl+Equal")?)
        .item(&item("zoom-out", "Zoom Out", "CmdOrCtrl+Minus")?)
        .item(&item("zoom-actual", "Actual Size", "CmdOrCtrl+0")?)
        .separator()
        .item(&item("fit-width", "Fit Width", "CmdOrCtrl+1")?)
        .item(&item("fit-page", "Fit Page", "CmdOrCtrl+2")?)
        .build()?;

    let go = SubmenuBuilder::new(app, "Go")
        .item(&item("next-page", "Next Page", "CmdOrCtrl+Right")?)
        .item(&item("previous-page", "Previous Page", "CmdOrCtrl+Left")?)
        .separator()
        .item(&item("first-page", "First Page", "CmdOrCtrl+Up")?)
        .item(&item("last-page", "Last Page", "CmdOrCtrl+Down")?)
        .separator()
        .item(&item("goto-page", "Go to Page…", "CmdOrCtrl+G")?)
        .build()?;

    let mut menu = tauri::menu::MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let about = AboutMetadataBuilder::new()
            .name(Some("Deja"))
            .version(Some(env!("CARGO_PKG_VERSION")))
            .comments(Some("A simple DjVu viewer"))
            .build();
        let app_menu = SubmenuBuilder::new(app, "Deja")
            .about(Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }

    menu = menu.item(&file).item(&view).item(&go);

    #[cfg(target_os = "macos")]
    {
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .separator()
            .fullscreen()
            .build()?;
        menu = menu.item(&window);
    }

    #[cfg(not(target_os = "macos"))]
    let _ = AboutMetadataBuilder::new();

    menu.build()
}
