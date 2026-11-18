use tauri::{Url, plugin::Builder as PluginBuilder};
use tauri_plugin_opener::OpenerExt;

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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(nav_guard)
        .run(tauri::generate_context!())
        .expect("error while running E2EE Chat");
}
