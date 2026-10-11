//! Self-verifying AppKit shortcut routing. No browser/desktop automation.
#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default().manage(forage_lib::page_peek::PageRegistry::default()).setup(|app| {
        println!("SHORTCUT_PROBE_SETUP");
        let window = WindowBuilder::new(app, "main").title("Forage shortcut verification").inner_size(900.0, 600.0).build()?;
        for (label, x) in [("main", 0.0)] {
            let view = window.add_child(WebviewBuilder::new(label, WebviewUrl::External("about:blank".parse()?)), LogicalPosition::new(x, 0.0), LogicalSize::new(450.0, 600.0))?;
            view.with_webview(move |platform| unsafe {
                let web = &*platform.inner().cast::<objc2_web_kit::WKWebView>();
                let html = format!(r#"<body data-page="{label}"><input id="input"><p tabindex="0" id="body">Native shortcut fixture</p><script>window.commands=[];addEventListener('forage-pane-command',e=>commands.push(e.detail));</script>"#);
                web.loadHTMLString_baseURL(&objc2_foundation::NSString::from_str(&html), None);
            })?;
        }
        println!("SHORTCUT_PROBE_VIEWS_CREATED");
        forage_lib::shortcuts_key::install(app.handle());
        forage_lib::shortcuts_key::workspace_shortcuts_set_active(true, Some("fixture".into()));
        let app = app.handle().clone();
        println!("SHORTCUT_PROBE_MONITOR_INSTALLED");
        tauri::async_runtime::spawn(async move {
            println!("SHORTCUT_PROBE_VERIFYING");
            let result = tokio::time::timeout(std::time::Duration::from_secs(35), verification::run(&app)).await;
            let report = match result { Ok(Ok(checks)) => serde_json::json!({"passed":true,"checks":checks}), other => serde_json::json!({"passed":false,"error":format!("{other:?}")}) };
            if let Ok(path) = std::env::var("FORAGE_SHORTCUT_REPORT") { std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap(); }
            println!("PANE_SHORTCUT_REPORT: {report}");
            if report["passed"] != true { std::process::exit(1); }
            println!("PANE_SHORTCUTS_PASSED"); app.exit(0);
        });
        Ok(())
    }).build(context).expect("shortcut probe");
    std::process::exit(app.run_return(|_, _| {}));
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("macOS shortcut probe");
}

#[cfg(target_os = "macos")]
mod verification {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{MainThreadMarker, NSError, NSPoint, NSString};
    use objc2_web_kit::WKWebView;
    use serde_json::{json, Value};
    use std::time::Duration;
    use tauri::{AppHandle, Manager};
    use tokio::sync::oneshot;
    async fn javascript(app: &AppHandle, label: &str, script: &str) -> Result<Value, String> {
        let view = app.get_webview(label).ok_or("Missing native page")?;
        let script = format!("JSON.stringify({script})");
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| {
            // Callback may only be called once, and never outlives its channel.
            let done = std::cell::Cell::new(Some(done));
            let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
                let result = if !error.is_null() || value.is_null() {
                    Err("WebKit JavaScript evaluation failed".to_string())
                } else {
                    // SAFETY: JSON.stringify returns an NSString through WebKit's
                    // completion callback. This fixture never returns another type.
                    let text = unsafe { &*value.cast::<NSString>() }.to_string();
                    serde_json::from_str(&text).map_err(|error| error.to_string())
                };
                if let Some(done) = done.take() {
                    let _ = done.send(result);
                }
            });
            // SAFETY: with_webview runs on the main thread with a live WKWebView.
            unsafe {
                let web = &*platform.inner().cast::<WKWebView>();
                web.evaluateJavaScript_completionHandler(
                    &NSString::from_str(&script),
                    Some(&callback),
                );
            }
        })
        .map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), received)
            .await
            .map_err(|_| "JavaScript evaluation timed out".to_string())?
            .map_err(|_| "JavaScript evaluation callback dropped".to_string())?
    }

    async fn post(
        app: &AppHandle,
        label: &str,
        code: u16,
        shift: bool,
        option: bool,
        repeated: bool,
    ) -> Result<(), String> {
        let view = app.get_webview(label).ok_or("missing native fixture")?;
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| unsafe {
            use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags as Flags, NSEventType};
            let web = &*platform.inner().cast::<WKWebView>();
            let window = web.window().unwrap();
            window.makeKeyAndOrderFront(None);
            window.makeFirstResponder(Some(web));
            let flags = Flags::Command | if shift { Flags::Shift } else { Flags::empty() } | if option { Flags::Option } else { Flags::empty() };
            let key = match code { 36 => "\r", 42 => "\\", 123 => "\u{f702}", 124 => "\u{f703}", _ => "w" };
            let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                NSEventType::KeyDown, NSPoint::new(0.0, 0.0), flags, 0.0, window.windowNumber(), None, &NSString::from_str(key), &NSString::from_str(key), repeated, code).unwrap();
            NSApplication::sharedApplication(MainThreadMarker::new().unwrap()).postEvent_atStart(&event, false);
            let _ = done.send(());
        }).map_err(|error| error.to_string())?;
        received.await.map_err(|error| error.to_string())?;
        tokio::time::sleep(Duration::from_millis(180)).await;
        Ok(())
    }
    pub async fn run(app: &AppHandle) -> Result<Vec<Value>, String> {
        let id = forage_lib::page_peek::page_peek_create(app.clone(), "fixture".into()).await?;
        let page = app
            .state::<forage_lib::page_peek::PageRegistry>()
            .get(&id)?
            .label
            .clone();
        let view = app.get_webview(&page).ok_or("Missing resource")?;
        let fixture = page.clone();
        view.with_webview(move |platform| unsafe {
            let web = &*platform.inner().cast::<WKWebView>();
            web.loadHTMLString_baseURL(&NSString::from_str(&format!(r#"<body data-page="{fixture}"><input id="input"><p tabindex="0" id="body">Native shortcut fixture</p>"#)), None);
        }).map_err(|e| e.to_string())?;
        forage_lib::page_peek::page_peek_present(
            app.clone(),
            id.clone(),
            1,
            forage_lib::page_peek::PeekBounds {
                x: 450.0,
                y: 0.0,
                width: 450.0,
                height: 600.0,
                clip_x: 450.0,
                clip_y: 0.0,
                clip_width: 450.0,
                clip_height: 600.0,
                viewport_width: 900.0,
                viewport_height: 600.0,
            },
            true,
        )
        .await?;
        for label in ["main", &page] {
            for _ in 0..100 {
                if javascript(app, label, "document.body?.dataset.page || null").await? == label {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        let mut checks = vec![];
        for label in ["main", &page] {
            for (code, shift, option, command) in [
                (36, true, false, "openRight"),
                (42, true, false, "split"),
                (123, false, true, "previous"),
                (124, false, true, "next"),
                (13, false, false, "close"),
            ] {
                javascript(app, "main", "(() => { commands=[]; return true })()").await?;
                javascript(
                    app,
                    label,
                    "(() => { document.querySelector('#body').focus(); return true })()",
                )
                .await?;
                println!("SHORTCUT_PROBE_KEY {label}/{command}");
                post(app, label, code, shift, option, false).await?;
                let commands = javascript(app, "main", "commands").await?;
                if commands
                    != json!([{"command":command,"nativePage":label != "main","sourcePaneId":"fixture","resourceId":if label == "main" { None } else { Some(&id) }}])
                {
                    return Err(format!(
                        "{label}/{command}: expected one owned action, got {commands}"
                    ));
                }
                checks.push(json!({"owner":label,"command":command,"count":1}));
            }
        }
        javascript(app, "main", "(() => { commands=[]; return true })()").await?;
        javascript(
            app,
            &page,
            "(() => { document.querySelector('#input').focus(); return true })()",
        )
        .await?;
        post(app, &page, 13, false, false, false).await?;
        if javascript(app, "main", "commands.length").await? != 0 {
            return Err("Native form did not retain ownership".into());
        }
        checks.push(json!({"stage":"native-form-precedence","count":0}));
        javascript(
            app,
            &page,
            "(() => { document.querySelector('#body').focus(); return true })()",
        )
        .await?;
        post(app, &page, 13, false, false, true).await?;
        if javascript(app, "main", "commands.length").await? != 0 {
            return Err("Repeated close executed".into());
        }
        checks.push(json!({"stage":"repeat-suppressed","count":0}));
        // Render the shipped CSS in WKWebView and check the Pen shell dimensions.
        let css_path = std::fs::read_dir("apps/desktop/dist/assets")
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| path.extension().is_some_and(|extension| extension == "css"))
            .ok_or("Build desktop CSS before running the probe")?;
        let css = std::fs::read_to_string(css_path).map_err(|error| error.to_string())?;
        let main = app.get_webview("main").ok_or("main fixture")?;
        app.get_webview(&page)
            .unwrap()
            .hide()
            .map_err(|error| error.to_string())?;
        for (width, count, collapsed) in [
            (1480, 2, false),
            (1480, 3, false),
            (832, 3, true),
            (720, 2, false),
        ] {
            main.set_size(tauri::LogicalSize::new(width as f64, 600.0))
                .map_err(|error| error.to_string())?;
            let rail = if collapsed { " is-collapsed" } else { "" };
            let mut panes = String::new();
            for index in 0..count {
                if index > 0 {
                    panes.push_str("<div class='pane-separator' role='separator'></div>");
                }
                let header = if index == 1 {
                    let mode = if width == 720 {
                        ""
                    } else {
                        "<div data-slot='segmented-control' style='width:118px;flex:none'>Reader / Page</div>"
                    };
                    format!("<div class='link-peek-toolbar'><button class='size-[30px] shrink-0'>←</button><button class='size-[30px] shrink-0'>→</button><div class='link-peek-address'><span class='link-peek-address-host'>example.com</span></div>{mode}<div class='web-overflow'><details><summary>⋯</summary></details></div><div class='pane-actions'><button class='size-[30px] shrink-0'>⋯</button><button class='size-[30px] shrink-0'>×</button></div></div>")
                } else {
                    "<div class='outline-toolbar-bar'><div class='pane-history'><button style='width:30px'>←</button><button style='width:30px'>→</button></div><nav class='outline-breadcrumbs'>Home › A very long pane title that should truncate</nav><div class='pane-actions'><button style='width:30px'>⋯</button><button style='width:30px'>×</button></div></div>".to_string()
                };
                let compact = if width == 720 { " is-compact" } else { "" };
                panes.push_str(&format!("<section data-fixture-pane class='workspace-outline-pane' style='flex-basis:480px'><div class='link-peek-pane{compact}'>{header}</div><div class='workspace-pane-scroll'><div class='outliner-editor' style='height:1600px'>Pane {index}</div></div></section>"));
            }
            let html = format!("<style>{css}</style><div id='app' style='height:600px;width:{width}px'><main class='outliner-main'><aside class='outline-sidebar{rail}'><button class='sidebar-toggle'>Nav</button></aside><section class='outline-workspace'><div class='outline-editor-view'><div class='workspace-panes'>{panes}</div></div></section><aside class='activity-sidebar{rail}'><button class='sidebar-toggle'>Activity</button></aside></main></div>");
            let html_json = serde_json::to_string(&html).unwrap();
            javascript(
                app,
                "main",
                &format!("(() => {{ document.body.innerHTML={html_json}; return true }})()"),
            )
            .await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let geometry = javascript(app,"main",r#"(() => {
                const strip=document.querySelector('.workspace-panes'), panes=[...document.querySelectorAll('.workspace-outline-pane')];
                panes[0].querySelector('.workspace-pane-scroll').scrollTop=111;
                return { viewport:strip.clientWidth, overflow:strip.scrollWidth > strip.clientWidth,
                    widths:panes.map(p=>Math.round(p.getBoundingClientRect().width)), headers:panes.map(p=>p.querySelector('.outline-toolbar-bar,.link-peek-toolbar').getBoundingClientRect().height),
                    scrollers:panes.map(p=>p.querySelector('.workspace-pane-scroll').scrollTop),
                    separators:[...document.querySelectorAll('.pane-separator')].map(p=>p.getBoundingClientRect().width),
                    webControlsFit:[...document.querySelectorAll('.link-peek-toolbar > button,.link-peek-toolbar .pane-actions > button,.link-peek-toolbar summary')].every(button=> { const b=button.getBoundingClientRect(), h=button.closest('.link-peek-toolbar').getBoundingClientRect(); return b.left>=h.left && b.right<=h.right }),
                    nav:document.querySelector('.outline-sidebar').getBoundingClientRect().width,
                    activity:document.querySelector('.activity-sidebar').getBoundingClientRect().width };
            })()"#).await?;
            let minimum = geometry["viewport"].as_i64().unwrap().min(360);
            if geometry["webControlsFit"] != true
                || geometry["headers"] != json!(vec![48; count])
                || geometry["separators"] != json!(vec![1; count - 1])
                || geometry["scrollers"][0] != 111
                || geometry["scrollers"][1] != 0
                || geometry["widths"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|width| width.as_i64().unwrap() < minimum)
                || (count == 3 && geometry["overflow"] != true)
                || (collapsed && (geometry["nav"] != 56 || geometry["activity"] != 56))
            {
                return Err(format!(
                    "Shell layout failed at {width}px/{count} panes: {geometry}"
                ));
            }
            checks.push(json!({"stage":"production-css-shell","windowWidth":width,"panes":count,"collapsed":collapsed,"geometry":geometry}));
        }
        Ok(checks)
    }
}
