//! The link peek's "Page" mode: a live web page embedded in the main window,
//! inside the peek pane beside the outline.
//!
//! The app's CSP forbids framing remote origins, so the page is a native child
//! webview (`Window::add_child`, Tauri's `unstable` multi-webview API) laid over
//! the pane's content rectangle. The frontend owns the geometry and reports it
//! as `getBoundingClientRect` measures it: logical pixels in the main webview.
//! Child webviews are placed relative to the window's content view, which on
//! macOS runs up under the title bar while the main webview sits below it, so
//! the main webview's own origin is added before placing the page.
//!
//! The page is untrusted remote content. Plugin commands are denied to it by the
//! capability ACL (every capability is local-only), and app commands are denied
//! by the trusted-webview guard in `lib.rs`. Its state reaches the app only
//! through the `page-peek:state` event emitted from here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, Url,
    WebviewBuilder, WebviewUrl,
};
use tokio::sync::oneshot;

/// Label of the embedded page webview. Never trusted with app commands.
pub const PAGE_PEEK_LABEL: &str = "link-peek-page";
const MAIN_LABEL: &str = "main";
const STATE_EVENT: &str = "page-peek:state";

/// A rectangle as the main webview's DOM measures it, plus that webview's
/// viewport size, which anchors it to the window.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
}

impl PeekBounds {
    /// These bounds in the parent view's space, where child webviews live.
    ///
    /// The DOM viewport and the parent view do not share a top edge on macOS:
    /// the content view runs up under the title bar, and depending on the
    /// window setup the main webview either starts below it or insets its page
    /// beneath it. They do share the bottom-right corner, so the DOM rectangle
    /// is placed from there: the offset is wherever the main webview's frame
    /// ends, minus the viewport the page actually got.
    fn rect(self, app: &AppHandle) -> Rect {
        let offset = app
            .get_webview(MAIN_LABEL)
            .and_then(|main| {
                let scale = main.window().scale_factor().ok()?;
                let frame = main.bounds().ok()?;
                let origin = frame.position.to_logical::<f64>(scale);
                let size = frame.size.to_logical::<f64>(scale);
                Some(LogicalPosition::new(
                    (origin.x + size.width - self.viewport_width).max(0.0),
                    (origin.y + size.height - self.viewport_height).max(0.0),
                ))
            })
            .unwrap_or(LogicalPosition::new(0.0, 0.0));
        Rect {
            position: LogicalPosition::new(offset.x + self.x, offset.y + self.y).into(),
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

/// Whether the page is on screen. WebKit does not repaint a loading page it
/// is stretched over, so while it is hidden it waits at full window size and is
/// only ever shrunk onto the pane.
static PAGE_VISIBLE: AtomicBool = AtomicBool::new(false);

/// The page's current address, tracked here rather than read back from the
/// webview: wry's `url()` unwraps WebKit's `URL`, which is nil until a first
/// navigation commits, and a nil there aborts the whole app.
static CURRENT_URL: Mutex<Option<Url>> = Mutex::new(None);

fn current_url() -> Option<Url> {
    CURRENT_URL.lock().ok().and_then(|current| current.clone())
}

fn remember_url(url: Option<Url>) {
    if let Ok(mut current) = CURRENT_URL.lock() {
        *current = url;
    }
}

fn navigate_to(webview: &tauri::Webview, url: Url) -> Result<(), String> {
    let web = url.scheme() != "about";
    webview.navigate(url.clone()).map_err(|error| error.to_string())?;
    remember_url(web.then_some(url));
    Ok(())
}

fn page_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(PAGE_PEEK_LABEL)
        .ok_or_else(|| "the page peek is not ready".to_string())
}

fn blank() -> Url {
    Url::parse("about:blank").expect("about:blank is a valid URL")
}

fn set_visible(webview: &tauri::Webview, visible: bool) -> Result<(), String> {
    if visible { webview.show() } else { webview.hide() }.map_err(|error| error.to_string())?;
    PAGE_VISIBLE.store(visible, Ordering::SeqCst);
    Ok(())
}

/// The embedded page, created hidden on first use.
fn ensure_webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    if let Some(webview) = app.get_webview(PAGE_PEEK_LABEL) {
        return Ok(webview);
    }
    let window = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "the main window is missing".to_string())?;
    let loads = app.clone();
    let titles = app.clone();
    let popups = app.clone();
    let builder = WebviewBuilder::new(PAGE_PEEK_LABEL, WebviewUrl::External(blank()))
        // WebKit leaves area it has not painted yet black; most pages are white.
        .background_color(Color(255, 255, 255, 255))
        .on_page_load(move |_webview, payload| {
            // The idle page is not something the user navigated to.
            if payload.url().scheme() == "about" {
                return;
            }
            // Follows navigation inside the page, redirects included.
            remember_url(Some(payload.url().clone()));
            emit_state(
                &loads,
                PageState {
                    url: payload.url().to_string(),
                    loading: matches!(payload.event(), PageLoadEvent::Started),
                    title: None,
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            if let Some(url) = current_url() {
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
                    let _ = navigate_to(&webview, url);
                }
            }
            NewWindowResponse::Deny
        });
    // Created as a speck and hidden straight away, so it never flashes over the
    // outline; `page_peek_load` sizes it before it loads anything.
    let webview = window
        .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
        .map_err(|error| error.to_string())?;
    set_visible(&webview, false)?;
    Ok(webview)
}

/// Warm the embedded page up at app start, so the first peek does not pay for
/// creating a webview and its web content process.
#[tauri::command]
pub fn page_peek_prepare(app: AppHandle) -> Result<(), String> {
    ensure_webview(&app).map(|_| ())
}

/// Start loading `url` without showing it, so the page loads while the pane
/// slides in. A hidden page waits at full window size; see `PAGE_VISIBLE`.
#[tauri::command]
pub fn page_peek_load(app: AppHandle, url: String) -> Result<(), String> {
    let url = web_url(&url)?;
    let webview = ensure_webview(&app)?;
    if !PAGE_VISIBLE.load(Ordering::SeqCst) {
        let window = webview.window();
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let size = window
            .inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale);
        webview
            .set_bounds(Rect {
                position: LogicalPosition::new(0.0, 0.0).into(),
                size: size.into(),
            })
            .map_err(|error| error.to_string())?;
    }
    if current_url().as_ref() != Some(&url) {
        navigate_to(&webview, url)?;
    }
    Ok(())
}

/// Lay the page over the pane and show it.
#[tauri::command]
pub fn page_peek_show(app: AppHandle, bounds: PeekBounds) -> Result<(), String> {
    let webview = page_webview(&app)?;
    webview.set_bounds(bounds.rect(&app)).map_err(|error| error.to_string())?;
    set_visible(&webview, true)
}

/// Keep the page over the pane as the layout moves.
#[tauri::command]
pub fn page_peek_set_bounds(app: AppHandle, bounds: PeekBounds) -> Result<(), String> {
    page_webview(&app)?
        .set_bounds(bounds.rect(&app))
        .map_err(|error| error.to_string())
}

/// Hide the page without losing it, e.g. while the pane shows the reader view.
#[tauri::command]
pub fn page_peek_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    match app.get_webview(PAGE_PEEK_LABEL) {
        Some(webview) => set_visible(&webview, visible),
        None => Ok(()),
    }
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

/// How long a snapshot may take before the page is hidden without one.
const SNAPSHOT_TIMEOUT: Duration = Duration::from_millis(400);

/// A JPEG of the page as it is on screen. The app shows it in the page's place
/// while a dialog is up: the page is a native view, so the dialog's HTML cannot
/// draw over it and the page has to be hidden.
#[tauri::command]
pub async fn page_peek_snapshot(app: AppHandle) -> Result<Response, String> {
    let webview = page_webview(&app)?;
    let (done, captured) = oneshot::channel();
    webview
        .with_webview(move |platform| snapshot::capture(platform, done))
        .map_err(|error| error.to_string())?;
    let bytes = tokio::time::timeout(SNAPSHOT_TIMEOUT, captured)
        .await
        .map_err(|_| "the page snapshot timed out".to_string())?
        .map_err(|_| "the page snapshot was dropped".to_string())??;
    Ok(Response::new(bytes))
}

#[cfg(target_os = "macos")]
mod snapshot {
    use std::cell::Cell;

    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    type Done = oneshot::Sender<Result<Vec<u8>, String>>;

    /// Runs on the main thread (`with_webview`), where WebKit also calls back.
    pub fn capture(platform: PlatformWebview, done: Done) {
        let done = Cell::new(Some(done));
        let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
            // SAFETY: WebKit passes either a valid image or nil.
            let result = unsafe { image.as_ref() }
                .ok_or_else(|| "WebKit returned no snapshot".to_string())
                .and_then(jpeg);
            if let Some(done) = done.take() {
                let _ = done.send(result);
            }
        });
        // SAFETY: on macOS wry's platform webview is its WKWebView, alive for
        // the duration of this main-thread callback; WebKit retains the block.
        unsafe {
            let view = &*platform.inner().cast::<WKWebView>();
            view.takeSnapshotWithConfiguration_completionHandler(None, &handler);
        }
    }

    fn jpeg(image: &NSImage) -> Result<Vec<u8>, String> {
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "the snapshot has no bitmap".to_string())?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "the snapshot bitmap is unreadable".to_string())?;
        // SAFETY: an empty property dictionary is valid for every file type.
        let data = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::JPEG, &NSDictionary::new())
        }
        .ok_or_else(|| "the snapshot could not be encoded".to_string())?;
        Ok(data.to_vec())
    }
}

#[cfg(not(target_os = "macos"))]
mod snapshot {
    use tauri::webview::PlatformWebview;
    use tokio::sync::oneshot;

    pub fn capture(_platform: PlatformWebview, done: oneshot::Sender<Result<Vec<u8>, String>>) {
        let _ = done.send(Err("page snapshots are only available on macOS".to_string()));
    }
}

/// Put the page away when the pane closes. The webview stays, hidden and
/// blank, ready for the next peek; blanking stops any audio or video.
#[tauri::command]
pub fn page_peek_close(app: AppHandle) -> Result<(), String> {
    let Some(webview) = app.get_webview(PAGE_PEEK_LABEL) else {
        return Ok(());
    };
    set_visible(&webview, false)?;
    navigate_to(&webview, blank())
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
