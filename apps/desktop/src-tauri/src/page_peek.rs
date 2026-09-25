//! The link peek's "Page" mode: a live web page embedded in the main window,
//! inside the peek pane beside the outline.
//!
//! The app's CSP forbids framing remote origins, so the page is a native child
//! webview (`Window::add_child`, Tauri's `unstable` multi-webview API) laid over
//! the pane's content rectangle. The frontend owns the geometry and reports it
//! in logical pixels relative to the window's content area, which is the same
//! space `getBoundingClientRect` measures in the main webview.
//!
//! The page is untrusted remote content. Plugin commands are denied to it by the
//! capability ACL (every capability is local-only), and app commands are denied
//! by the trusted-webview guard in `lib.rs`. Its state reaches the app only
//! through the `page-peek:state` event emitted from here.

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Url,
    WebviewBuilder, WebviewUrl,
};

/// Label of the embedded page webview. Never trusted with app commands.
pub const PAGE_PEEK_LABEL: &str = "link-peek-page";
const MAIN_LABEL: &str = "main";
const STATE_EVENT: &str = "page-peek:state";

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PeekBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl PeekBounds {
    fn rect(self) -> Rect {
        Rect {
            position: LogicalPosition::new(self.x, self.y).into(),
            size: LogicalSize::new(self.width.max(1.0), self.height.max(1.0)).into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    url: String,
    loading: bool,
    title: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeekAction {
    Back,
    Forward,
    Reload,
}

/// Only ordinary web pages may be peeked; no `file:`, `javascript:` or app URLs.
fn web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|error| format!("invalid URL: {error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!("cannot peek a {scheme}: URL")),
    }
}

fn emit_state(app: &AppHandle, state: PageState) {
    let _ = app.emit_to(EventTarget::webview_window(MAIN_LABEL), STATE_EVENT, state);
}

fn page_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(PAGE_PEEK_LABEL)
        .ok_or_else(|| "the page peek is not open".to_string())
}

/// Show `url` in the embedded page, creating the webview on first use.
#[tauri::command]
pub fn page_peek_open(app: AppHandle, url: String, bounds: PeekBounds) -> Result<(), String> {
    let url = web_url(&url)?;
    if let Some(webview) = app.get_webview(PAGE_PEEK_LABEL) {
        webview.set_bounds(bounds.rect()).map_err(|error| error.to_string())?;
        if webview.url().ok().as_ref() != Some(&url) {
            webview.navigate(url).map_err(|error| error.to_string())?;
        }
        return webview.show().map_err(|error| error.to_string());
    }

    let window = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "the main window is missing".to_string())?;
    let loads = app.clone();
    let titles = app.clone();
    let popups = app.clone();
    let builder = WebviewBuilder::new(PAGE_PEEK_LABEL, WebviewUrl::External(url))
        .on_page_load(move |_webview, payload| {
            emit_state(
                &loads,
                PageState {
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                    title: None,
                },
            );
        })
        .on_document_title_changed(move |webview, title| {
            if let Ok(url) = webview.url() {
                emit_state(
                    &titles,
                    PageState {
                        url: url.to_string(),
                        loading: false,
                        title: Some(title),
                    },
                );
            }
        })
        // `target="_blank"` and `window.open` stay inside the peek rather than
        // spawning windows the app does not manage.
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                if let Some(webview) = popups.get_webview(PAGE_PEEK_LABEL) {
                    let _ = webview.navigate(url);
                }
            }
            NewWindowResponse::Deny
        });
    let rect = bounds.rect();
    window
        .add_child(builder, rect.position, rect.size)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Keep the page over the pane as the layout moves.
#[tauri::command]
pub fn page_peek_set_bounds(app: AppHandle, bounds: PeekBounds) -> Result<(), String> {
    page_webview(&app)?
        .set_bounds(bounds.rect())
        .map_err(|error| error.to_string())
}

/// Hide the page without losing it, e.g. while the pane shows the reader view.
#[tauri::command]
pub fn page_peek_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(webview) = app.get_webview(PAGE_PEEK_LABEL) else {
        return Ok(());
    };
    if visible { webview.show() } else { webview.hide() }.map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_peek_navigate(app: AppHandle, action: PeekAction) -> Result<(), String> {
    let webview = page_webview(&app)?;
    match action {
        PeekAction::Back => webview.eval("history.back()"),
        PeekAction::Forward => webview.eval("history.forward()"),
        PeekAction::Reload => webview.reload(),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn page_peek_close(app: AppHandle) -> Result<(), String> {
    match app.get_webview(PAGE_PEEK_LABEL) {
        Some(webview) => webview.close().map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::web_url;

    #[test]
    fn only_web_urls_can_be_peeked() {
        assert!(web_url("https://example.com/a?b=c").is_ok());
        assert!(web_url("http://example.com").is_ok());
        assert!(web_url("file:///etc/passwd").is_err());
        assert!(web_url("javascript:alert(1)").is_err());
        assert!(web_url("tauri://localhost").is_err());
        assert!(web_url("not a url").is_err());
    }
}
