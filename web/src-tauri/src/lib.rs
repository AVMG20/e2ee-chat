use tauri::{
    AppHandle, Manager, Url, WebviewWindowBuilder, WindowEvent,
    webview::DownloadEvent,
    plugin::Builder as PluginBuilder,
};
#[cfg(not(target_os = "macos"))]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

/// Window size, position and maximized state are remembered between starts (not visibility:
/// the window is often hidden in the tray when the app quits).
const WINDOW_STATE: StateFlags =
    StateFlags::SIZE.union(StateFlags::POSITION).union(StateFlags::MAXIMIZED);

/// True for the app's own pages (bundled UI, or the Vite dev server in debug builds).
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || (cfg!(debug_assertions) && url.host_str() == Some("localhost"))
        }
        _ => false,
    }
}

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Windows/Linux: a tray icon to bring the window back and to quit (closing the window keeps the
/// app running). macOS has none: the Dock icon brings the window back and Cmd+Q quits.
#[cfg(not(target_os = "macos"))]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open E2EE Chat", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("E2EE Chat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "quit" => {
                let _ = app.save_window_state(WINDOW_STATE);
                app.exit(0)
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The whole app (UI + end-to-end encryption) runs in the webview; the
    // desktop shell just ships the UI locally so it never comes from the server.
    //
    // The webview may never navigate away from that UI. Links in messages are
    // handed to the system browser instead (http/https/mailto only).
    let nav_guard = PluginBuilder::<tauri::Wry>::new("nav-guard")
        .on_navigation(|webview, url| {
            if is_app_url(url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
            }
            false
        })
        .build();

    let app = tauri::Builder::default()
        // Starting the app again shows the running one (it may be hidden in the tray).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::new().with_state_flags(WINDOW_STATE).build())
        .plugin(nav_guard)
        .setup(|app| {
            // The window is built here (not from the config) so downloads get a handler: without
            // one, macOS cancels every download (files, images, backups). They go to Downloads.
            if let Some(config) = app.config().app.windows.first() {
                WebviewWindowBuilder::from_config(app.handle(), config)?
                    .on_download(|webview, event| {
                        if let DownloadEvent::Finished { path: Some(path), success: true, .. } = event {
                            let _ = webview.opener().reveal_item_in_dir(&path);
                        }
                        true
                    })
                    .build()?;
            }
            #[cfg(not(target_os = "macos"))]
            build_tray(app)?;
            Ok(())
        })
        // Closing the window keeps the app (and its connection/notifications) alive: in the tray, or
        // on macOS in the Dock.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.app_handle().save_window_state(WINDOW_STATE);
                    // Many Linux desktops (e.g. GNOME) have no tray, so a hidden window couldn't be
                    // brought back there: minimize instead.
                    #[cfg(target_os = "linux")]
                    let _ = window.minimize();
                    #[cfg(not(target_os = "linux"))]
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building E2EE Chat");

    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        match _event {
            // Clicking the Dock icon brings the hidden window back.
            tauri::RunEvent::Reopen { .. } => show_main(_app),
            // Cmd+Q / Quit from the Dock: remember the window first (it may be hidden).
            tauri::RunEvent::ExitRequested { .. } => {
                let _ = _app.save_window_state(WINDOW_STATE);
            }
            _ => {}
        }
    });
}
