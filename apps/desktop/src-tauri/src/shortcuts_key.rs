//! Application keyboard help and pane shortcuts from AppKit/WebKit focus.
//!
//! The `unstable` feature (needed for the link peek's second webview) makes the
//! main webview a child view, and wry then declines key equivalents in child
//! webviews (tauri-apps/tauri#9426) so the menu bar sees Command+key first. The
//! default Help menu claims Command+? for Help search, so the webview's keydown
//! handler never runs. A local event monitor sees the key before the menu bar
//! and hands it to the page instead.

use tauri::{AppHandle, Runtime};

pub const TOGGLE_EVENT: &str = "forage-toggle-keyboard-shortcuts";

static WORKSPACE_OWNER: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static WORKSPACE_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[tauri::command]
pub fn workspace_shortcuts_set_active(active: bool, pane_id: Option<String>) {
    *WORKSPACE_OWNER.lock().expect("workspace owner lock") = pane_id;
    WORKSPACE_ACTIVE.store(active, std::sync::atomic::Ordering::Relaxed);
}

/// App-selected target only; the trusted-webview guard protects this command.
#[tauri::command]
pub fn workspace_focus(
    app: tauri::AppHandle,
    page: bool,
    resource_id: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let resource = if page {
        Some(
            app.state::<crate::page_peek::PageRegistry>()
                .get(resource_id.as_deref().ok_or("Missing Page resource")?)?,
        )
    } else {
        None
    };
    let label = resource
        .as_ref()
        .map(|r| r.label.as_str())
        .unwrap_or("main");
    app.get_webview(&label)
        .ok_or_else(|| "Focus target is unavailable".to_string())?
        .set_focus()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSWindow};
    use std::ptr::NonNull;
    use tauri::Emitter;
    use tauri::Manager;

    let owned_window_number = app
        .get_window("main")
        .and_then(|window| window.ns_window().ok())
        .map(|window| unsafe { (&*window.cast::<NSWindow>()).windowNumber() });
    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let key = unsafe { event.as_ref() };
        if key.r#type() == objc2_app_kit::NSEventType::LeftMouseDown {
            if Some(key.windowNumber()) == owned_window_number {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                    forward_page_focus(&app);
                });
            }
            return event.as_ptr();
        }
        let flags = key.modifierFlags();
        let command = pane_command(
            key.keyCode(),
            flags.contains(NSEventModifierFlags::Command),
            flags.contains(NSEventModifierFlags::Shift),
            flags.contains(NSEventModifierFlags::Option),
            flags.contains(NSEventModifierFlags::Control),
        );
        if let Some(command) = command.filter(|_| {
            Some(key.windowNumber()) == owned_window_number
                && WORKSPACE_ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
        }) {
            if !key.isARepeat() {
                let app = app.clone();
                let owner = WORKSPACE_OWNER
                    .lock()
                    .expect("workspace owner lock")
                    .clone();
                // Do not reenter Tauri's webview registry inside AppKit's event
                // monitor: Wry may still hold it while dispatching this event.
                tauri::async_runtime::spawn(async move {
                    forward_pane_command(&app, command, owner);
                });
            }
            return std::ptr::null_mut();
        }
        if is_toggle_shortcut(key) {
            let _ = app.emit(TOGGLE_EVENT, ());
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    // SAFETY: the handler returns either the event it was given or null.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::KeyDown | NSEventMask::LeftMouseDown,
            &handler,
        )
    };
    // The monitor lives as long as the app.
    std::mem::forget(monitor);

    fn is_toggle_shortcut(event: &NSEvent) -> bool {
        let flags = event.modifierFlags();
        if !flags.contains(NSEventModifierFlags::Command)
            || flags.intersects(NSEventModifierFlags::Control | NSEventModifierFlags::Option)
        {
            return false;
        }
        let Some(characters) = event.charactersIgnoringModifiers() else {
            return false;
        };
        let characters = characters.to_string();
        characters == "?" || (characters == "/" && flags.contains(NSEventModifierFlags::Shift))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_app: &AppHandle<R>) {}

/// Kept pure so modifier precedence and safe close interception can be tested.
fn pane_command(
    code: u16,
    command: bool,
    shift: bool,
    option: bool,
    control: bool,
) -> Option<&'static str> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Binding {
        id: String,
        native_key_code: u16,
        shift: bool,
        alt: bool,
    }
    static BINDINGS: std::sync::OnceLock<Vec<Binding>> = std::sync::OnceLock::new();
    if !command || control {
        return None;
    }
    let bindings = BINDINGS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/workspace/paneCommands.json"))
            .expect("shared pane command registry")
    });
    bindings
        .iter()
        .find(|binding| {
            binding.native_key_code == code && binding.shift == shift && binding.alt == option
        })
        .map(|binding| binding.id.as_str())
}

#[cfg(target_os = "macos")]
fn forward_pane_command<R: Runtime>(
    app: &AppHandle<R>,
    command: &'static str,
    owner: Option<String>,
) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel, ClassType};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSError, NSNumber, NSString};
    use objc2_web_kit::WKWebView;
    use tauri::Manager;

    // Read focus from the native responder tree, never from remote-page IPC.
    let resources = app
        .try_state::<crate::page_peek::PageRegistry>()
        .map(|registry| registry.resources())
        .unwrap_or_default();
    let targets = std::iter::once(("main".to_string(), owner, None)).chain(
        resources
            .into_iter()
            .map(|r| (r.label.clone(), Some(r.pane_id.clone()), Some(r.id.clone()))),
    );
    for (label, owner, resource_id) in targets {
        let Some(webview) = app.get_webview(&label) else {
            continue;
        };
        let app = app.clone();
        let owner = owner.clone();
        let _ = webview.with_webview(move |platform| unsafe {
            let view = &*platform.inner().cast::<WKWebView>();
            let Some(window) = view.window() else { return; };
            let Some(responder) = window.firstResponder() else { return; };
            let is_view: bool = msg_send![&*responder, isKindOfClass: NSView::class()];
            if !is_view { return; }
            let responder_view = &*(&*responder as *const _ as *const NSView);
            if !responder_view.isDescendantOf(view) { return; }
            let supports_marked: bool = msg_send![&*responder, respondsToSelector: sel!(hasMarkedText)];
            if supports_marked {
                let marked: bool = msg_send![&*responder, hasMarkedText];
                if marked { return; }
            }
            let native_page = label != "main";
            let detail = serde_json::json!({ "command": command, "nativePage": native_page, "sourcePaneId": owner, "resourceId": resource_id });
            let script = format!("window.dispatchEvent(new CustomEvent('forage-pane-command',{{detail:{detail}}}))");
            if !native_page {
                if let Some(main) = app.get_webview("main") { let _ = main.eval(&script); }
                return;
            }
            // Remote pages gain no bridge. Native WebKit evaluates only an input
            // ownership predicate; errors fail closed. App commands run in main.
            let done = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                if !error.is_null() || result.is_null() { return; }
                let allowed = &*(result.cast::<NSNumber>());
                if allowed.boolValue() && resource_id.as_ref().map_or(true, |id| app.try_state::<crate::page_peek::PageRegistry>().is_some_and(|registry| registry.get(id).is_ok())) {
                    if let Some(main) = app.get_webview("main") { let _ = main.eval(&script); }
                }
            });
            view.evaluateJavaScript_completionHandler(&NSString::from_str("!document.activeElement?.closest('input,textarea,select,form,[contenteditable=true],[role=menu]') && !document.querySelector('[aria-modal=true],[role=menu]')"), Some(&done));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::pane_command;
    #[test]
    fn pane_bindings_are_exact_and_close_is_intercepted() {
        assert_eq!(pane_command(13, true, false, false, false), Some("close"));
        assert_eq!(
            pane_command(36, true, true, false, false),
            Some("openRight")
        );
        assert_eq!(pane_command(42, true, true, false, false), Some("split"));
        assert_eq!(
            pane_command(123, true, false, true, false),
            Some("previous")
        );
        assert_eq!(pane_command(124, true, false, true, false), Some("next"));
        assert_eq!(pane_command(13, true, true, false, false), None);
        assert_eq!(pane_command(13, true, false, false, true), None);
        assert_eq!(pane_command(13, false, false, false, false), None);
    }
}

#[cfg(target_os = "macos")]
fn forward_page_focus<R: Runtime>(app: &AppHandle<R>) {
    use objc2::{msg_send, ClassType};
    use objc2_app_kit::NSView;
    use objc2_web_kit::WKWebView;
    use tauri::Manager;
    let Some(registry) = app.try_state::<crate::page_peek::PageRegistry>() else {
        return;
    };
    for resource in registry.resources() {
        let Some(view) = app.get_webview(&resource.label) else {
            continue;
        };
        let app = app.clone();
        let _ = view.with_webview(move |platform| unsafe {
            let web = &*platform.inner().cast::<WKWebView>();
            let Some(responder) = web.window().and_then(|w| w.firstResponder()) else { return; };
            let is_view: bool = msg_send![&*responder, isKindOfClass: NSView::class()];
            if !is_view || !(&*(&*responder as *const _ as *const NSView)).isDescendantOf(web) { return; }
            if app.state::<crate::page_peek::PageRegistry>().get(&resource.id).is_err() { return; }
            let detail = serde_json::json!({"resourceId":resource.id,"sourcePaneId":resource.pane_id});
            if let Some(main) = app.get_webview("main") { let _ = main.eval(&format!("window.dispatchEvent(new CustomEvent('forage-page-focus',{{detail:{detail}}}))")); }
        });
    }
}
