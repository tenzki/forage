//! Command+? for the keyboard shortcuts panel on macOS.
//!
//! The `unstable` feature (needed for the link peek's second webview) makes the
//! main webview a child view, and wry then declines key equivalents in child
//! webviews (tauri-apps/tauri#9426) so the menu bar sees Command+key first. The
//! default Help menu claims Command+? for Help search, so the webview's keydown
//! handler never runs. A local event monitor sees the key before the menu bar
//! and hands it to the page instead.

use tauri::{AppHandle, Runtime};

pub const TOGGLE_EVENT: &str = "forage-toggle-keyboard-shortcuts";

#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use std::ptr::NonNull;
    use tauri::Emitter;

    let app = app.clone();
    let handler = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the duration of the call.
        let key = unsafe { event.as_ref() };
        if is_toggle_shortcut(key) {
            let _ = app.emit(TOGGLE_EVENT, ());
            return std::ptr::null_mut();
        }
        event.as_ptr()
    });
    // SAFETY: the handler returns either the event it was given or null.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &handler)
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
        characters == "?"
            || (characters == "/" && flags.contains(NSEventModifierFlags::Shift))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_app: &AppHandle<R>) {}
