//! Window-owned untrusted Page resources. Only main may address this registry.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::ipc::Response;
use tauri::webview::{Color, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder,
    WebviewUrl,
};
use tokio::sync::oneshot;

const MAIN_LABEL: &str = "main";
#[derive(Default)]
pub struct PageRegistry(Mutex<HashMap<String, Arc<PageResource>>>);
pub struct PageResource {
    pub id: String,
    pub pane_id: String,
    pub label: String,
    alive: AtomicBool,
    generation: AtomicU64,
    loading: AtomicBool,
    presentation: AtomicU64,
    url: Mutex<Option<Url>>,
}
impl PageRegistry {
    fn insert(&self, pane_id: String) -> Arc<PageResource> {
        let id = uuid::Uuid::new_v4().to_string();
        let resource = Arc::new(PageResource {
            label: format!("page-resource-{id}"),
            id: id.clone(),
            pane_id,
            alive: AtomicBool::new(true),
            generation: AtomicU64::new(0),
            loading: AtomicBool::new(false),
            presentation: AtomicU64::new(0),
            url: Mutex::new(None),
        });
        self.0.lock().unwrap().insert(id, resource.clone());
        resource
    }
    pub fn get(&self, id: &str) -> Result<Arc<PageResource>, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .filter(|r| r.alive.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| "Page resource is closed or unknown".into())
    }
    pub fn resources(&self) -> Vec<Arc<PageResource>> {
        self.0.lock().unwrap().values().cloned().collect()
    }
    pub fn clear(&self) {
        for r in self.0.lock().unwrap().drain().map(|(_, r)| r) {
            r.alive.store(false, Ordering::SeqCst);
        }
    }
    fn remove(&self, id: &str) -> Result<Arc<PageResource>, String> {
        let resource = self
            .0
            .lock()
            .unwrap()
            .remove(id)
            .ok_or("Page resource is closed or unknown")?;
        resource.alive.store(false, Ordering::SeqCst);
        Ok(resource)
    }
}
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeekBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub clip_x: f64,
    pub clip_y: f64,
    pub clip_width: f64,
    pub clip_height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}
impl PeekBounds {
    fn valid(self) -> bool {
        [
            self.x,
            self.y,
            self.width,
            self.height,
            self.clip_x,
            self.clip_y,
            self.clip_width,
            self.clip_height,
            self.viewport_width,
            self.viewport_height,
        ]
        .iter()
        .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
            && self.clip_width >= 0.0
            && self.clip_height >= 0.0
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageState {
    resource_id: String,
    pane_id: String,
    generation: u64,
    url: String,
    loading: bool,
    title: Option<String>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeekAction {
    Back,
    Forward,
    Reload,
}
fn web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Only HTTP(S) pages without credentials may be opened".into());
    }
    Ok(url)
}
#[cfg(target_os = "macos")]
fn external_gesture() -> bool {
    use objc2_app_kit::{NSApplication, NSEventModifierFlags};
    use objc2_foundation::MainThreadMarker;
    MainThreadMarker::new()
        .and_then(|mtm| NSApplication::sharedApplication(mtm).currentEvent())
        .is_some_and(|event| {
            event
                .modifierFlags()
                .intersects(NSEventModifierFlags::Command | NSEventModifierFlags::Control)
        })
}
#[cfg(not(target_os = "macos"))]
fn external_gesture() -> bool {
    false
}
fn emit(app: &AppHandle, r: &PageResource, url: &Url, loading: bool, title: Option<String>) {
    if r.alive.load(Ordering::SeqCst) {
        let _ = app.emit_to(
            EventTarget::webview_window(MAIN_LABEL),
            "page-peek:state",
            PageState {
                resource_id: r.id.clone(),
                pane_id: r.pane_id.clone(),
                generation: r.generation.load(Ordering::SeqCst),
                url: url.to_string(),
                loading,
                title,
            },
        );
    }
}
fn resource(app: &AppHandle, id: &str) -> Result<(Arc<PageResource>, tauri::Webview), String> {
    let r = app.state::<PageRegistry>().get(id)?;
    let view = app
        .get_webview(&r.label)
        .ok_or("Page viewer is unavailable")?;
    Ok((r, view))
}
#[tauri::command]
pub async fn page_peek_create(app: AppHandle, pane_id: String) -> Result<String, String> {
    if pane_id.is_empty() {
        return Err("Missing pane owner".into());
    }
    let window = app
        .get_window(MAIN_LABEL)
        .ok_or("Main window is unavailable")?;
    let r = app.state::<PageRegistry>().insert(pane_id);
    let nav = r.clone();
    let loads = r.clone();
    let titles = r.clone();
    let popup = r.clone();
    let nav_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();
    let builder = WebviewBuilder::new(
        &r.label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .background_color(Color(255, 255, 255, 255))
    .on_navigation(move |url| {
        if !nav.alive.load(Ordering::SeqCst) {
            return false;
        }
        if url.as_str() == "about:blank" && nav.generation.load(Ordering::SeqCst) == 0 {
            return true;
        }
        if url.scheme() == "mailto" || (web_url(url.as_str()).is_ok() && external_gesture()) {
            use tauri_plugin_opener::OpenerExt;
            let _ = nav_app.opener().open_url(url.as_str(), None::<&str>);
            return false;
        }
        if web_url(url.as_str()).is_err() {
            return false;
        }
        *nav.url.lock().unwrap() = Some(url.clone());
        nav.loading.store(true, Ordering::SeqCst);
        true
    })
    .on_page_load(move |_, payload| {
        if web_url(payload.url().as_str()).is_err() {
            return;
        }
        if loads.url.lock().unwrap().as_ref() != Some(payload.url()) {
            return;
        }
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        loads.loading.store(loading, Ordering::SeqCst);
        emit(&load_app, &loads, payload.url(), loading, None);
    })
    .on_document_title_changed(move |_, title| {
        if let Some(url) = titles.url.lock().unwrap().clone() {
            emit(&title_app, &titles, &url, false, Some(title));
        }
    })
    .on_new_window(move |url, _| {
        if popup.alive.load(Ordering::SeqCst)
            && (url.scheme() == "mailto" || (web_url(url.as_str()).is_ok() && external_gesture()))
        {
            use tauri_plugin_opener::OpenerExt;
            let _ = popup_app.opener().open_url(url.as_str(), None::<&str>);
            return NewWindowResponse::Deny;
        }
        if popup.alive.load(Ordering::SeqCst) && web_url(url.as_str()).is_ok() {
            if let Some(view) = popup_app.get_webview(&popup.label) {
                let _ = view.navigate(url);
            }
        }
        NewWindowResponse::Deny
    });
    let result = async {
        let view = window
            .add_child(
                builder,
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1.0, 1.0),
            )
            .map_err(|e| e.to_string())?;
        view.hide().map_err(|e| e.to_string())?;
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| {
            let _ = done.send(clipping::install(platform));
        })
        .map_err(|e| e.to_string())?;
        received.await.map_err(|e| e.to_string())??;
        Ok(r.id.clone())
    }
    .await;
    if result.is_err() {
        let _ = app.state::<PageRegistry>().remove(&r.id);
        if let Some(view) = app.get_webview(&r.label) {
            let _ = view.close();
        }
    }
    result
}
#[tauri::command]
pub fn page_peek_load(
    app: AppHandle,
    resource_id: String,
    generation: u64,
    url: String,
) -> Result<(), String> {
    let url = web_url(&url)?;
    let (r, view) = resource(&app, &resource_id)?;
    if generation <= r.generation.load(Ordering::SeqCst) {
        return Ok(());
    }
    r.generation.store(generation, Ordering::SeqCst);
    if r.url.lock().unwrap().as_ref() == Some(&url) {
        emit(&app, &r, &url, r.loading.load(Ordering::SeqCst), None);
        return Ok(());
    }
    r.loading.store(true, Ordering::SeqCst);
    *r.url.lock().unwrap() = Some(url.clone());
    view.navigate(url).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn page_peek_present(
    app: AppHandle,
    resource_id: String,
    sequence: u64,
    bounds: PeekBounds,
    visible: bool,
) -> Result<(), String> {
    if !bounds.valid() {
        return Err("Invalid Page geometry".into());
    }
    let (r, view) = resource(&app, &resource_id)?;
    if sequence <= r.presentation.fetch_max(sequence, Ordering::SeqCst) {
        return Ok(());
    }
    let main = app
        .get_webview(MAIN_LABEL)
        .ok_or("Main viewer is unavailable")?;
    let scale = main.window().scale_factor().map_err(|e| e.to_string())?;
    let frame = main.bounds().map_err(|e| e.to_string())?;
    let origin = frame.position.to_logical::<f64>(scale);
    let size = frame.size.to_logical::<f64>(scale);
    let offset = (
        (origin.x + size.width - bounds.viewport_width).max(0.0),
        (origin.y + size.height - bounds.viewport_height).max(0.0),
    );
    let (done, received) = oneshot::channel();
    view.with_webview(move |platform| {
        let result = if r.alive.load(Ordering::SeqCst)
            && r.presentation.load(Ordering::SeqCst) == sequence
        {
            clipping::present(platform, bounds, offset, visible)
        } else {
            Ok(())
        };
        let _ = done.send(result);
    })
    .map_err(|e| e.to_string())?;
    received.await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn page_peek_navigate(
    app: AppHandle,
    resource_id: String,
    action: PeekAction,
) -> Result<(), String> {
    let (_, view) = resource(&app, &resource_id)?;
    match action {
        PeekAction::Back => view.eval("history.back()"),
        PeekAction::Forward => view.eval("history.forward()"),
        PeekAction::Reload => view.reload(),
    }
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn page_peek_snapshot(app: AppHandle, resource_id: String) -> Result<Response, String> {
    let (r, view) = resource(&app, &resource_id)?;
    let generation = r.generation.load(Ordering::SeqCst);
    let (done, received) = oneshot::channel();
    view.with_webview(move |platform| snapshot::capture(platform, done))
        .map_err(|e| e.to_string())?;
    let bytes = tokio::time::timeout(Duration::from_millis(400), received)
        .await
        .map_err(|_| "Page snapshot timed out")?
        .map_err(|_| "Page snapshot dropped")??;
    if !r.alive.load(Ordering::SeqCst) || generation != r.generation.load(Ordering::SeqCst) {
        return Err("Page snapshot is obsolete".into());
    }
    Ok(Response::new(bytes))
}
#[tauri::command]
pub fn page_peek_close(app: AppHandle, resource_id: String) -> Result<(), String> {
    let r = app.state::<PageRegistry>().remove(&resource_id)?;
    if let Some(view) = app.get_webview(&r.label) {
        view.with_webview(clipping::remove)
            .map_err(|e| e.to_string())?;
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod clipping {
    use super::PeekBounds;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
    use objc2_web_kit::WKWebView;
    use tauri::webview::PlatformWebview;
    pub fn install(platform: PlatformWebview) -> Result<(), String> {
        unsafe {
            let web = &*platform.inner().cast::<WKWebView>();
            let parent = web.superview().ok_or("Page has no native parent")?;
            let clip = NSView::new(MainThreadMarker::new().ok_or("Not on main thread")?);
            clip.setFrame(web.frame());
            clip.setClipsToBounds(true);
            clip.setHidden(true);
            parent.addSubview(&clip);
            web.removeFromSuperview();
            clip.addSubview(web);
            web.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
            Ok(())
        }
    }
    pub fn present(
        platform: PlatformWebview,
        b: PeekBounds,
        offset: (f64, f64),
        visible: bool,
    ) -> Result<(), String> {
        unsafe {
            let web = &*platform.inner().cast::<WKWebView>();
            let clip = web.superview().ok_or("Missing Page clip")?;
            let parent = clip.superview().ok_or("Missing Page window")?;
            let left = b.clip_x.max(b.x).max(0.0);
            let top = b.clip_y.max(b.y).max(0.0);
            let right = (b.clip_x + b.clip_width)
                .min(b.x + b.width)
                .min(b.viewport_width);
            let bottom = (b.clip_y + b.clip_height)
                .min(b.y + b.height)
                .min(b.viewport_height);
            let w = (right - left).max(0.0);
            let h = (bottom - top).max(0.0);
            let y = if parent.isFlipped() {
                offset.1 + top
            } else {
                parent.bounds().size.height - offset.1 - top - h
            };
            clip.setFrame(NSRect::new(
                NSPoint::new(offset.0 + left, y),
                NSSize::new(w, h),
            ));
            let web_y = if clip.isFlipped() {
                b.y - top
            } else {
                h - (b.y - top) - b.height
            };
            web.setFrame(NSRect::new(
                NSPoint::new(b.x - left, web_y),
                NSSize::new(b.width, b.height),
            ));
            web.setHidden(!visible || w == 0.0 || h == 0.0);
            clip.setHidden(!visible || w == 0.0 || h == 0.0);
            Ok(())
        }
    }
    pub fn remove(platform: PlatformWebview) {
        unsafe {
            let web = &*platform.inner().cast::<WKWebView>();
            if let Some(clip) = web.superview() {
                clip.removeFromSuperview();
            }
        }
    }
}
#[cfg(not(target_os = "macos"))]
mod clipping {
    use super::PeekBounds;
    use tauri::webview::PlatformWebview;
    pub fn install(_: PlatformWebview) -> Result<(), String> {
        Err("Clipped native pages are unavailable on this platform".into())
    }
    pub fn present(
        _: PlatformWebview,
        _: PeekBounds,
        _: (f64, f64),
        _: bool,
    ) -> Result<(), String> {
        Err("Clipped native pages are unavailable".into())
    }
    pub fn remove(_: PlatformWebview) {}
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
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::JPEG,
                &NSDictionary::new(),
            )
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_isolates_resources_and_invalidates_closed_ids() {
        let registry = PageRegistry::default();
        let a = registry.insert("pane-a".into());
        let b = registry.insert("pane-b".into());
        assert_ne!(a.id, b.id);
        assert_ne!(a.label, b.label);
        assert!(registry.get("unknown").is_err());
        registry.remove(&a.id).unwrap();
        assert!(!a.alive.load(Ordering::SeqCst));
        assert!(registry.get(&a.id).is_err());
        assert_eq!(registry.get(&b.id).unwrap().pane_id, "pane-b");
        assert_eq!(registry.resources().len(), 1);
        let reopened = registry.insert("pane-a".into());
        assert_ne!(a.id, reopened.id);
    }
    #[test]
    fn only_safe_web_urls_are_allowed() {
        for url in ["https://example.com/a", "http://localhost:8000"] {
            assert!(web_url(url).is_ok());
        }
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "tauri://localhost",
            "https://user:secret@example.com",
            "about:blank",
            "not a url",
        ] {
            assert!(web_url(url).is_err());
        }
    }
}
