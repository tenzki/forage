//! Self-verifying production Page registry, clipping, browsing, cleanup and ACL.
#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app=tauri::Builder::default().manage(forage_lib::page_peek::PageRegistry::default())
      .plugin(tauri_plugin_store::Builder::new().build())
      .invoke_handler(|invoke| { if !forage_lib::trusted_webview(invoke.message.webview_ref().label()) { invoke.resolver.reject("app commands are not available to this webview"); return true; } false })
      .setup(|app| {
        let window=WindowBuilder::new(app,"main").title("Forage production Page verification").inner_size(1000.0,650.0).build()?;
        let main=window.add_child(WebviewBuilder::new("main",WebviewUrl::External("about:blank".parse()?)),LogicalPosition::new(0.0,0.0),LogicalSize::new(1000.0,650.0))?;
        main.with_webview(|platform| unsafe {
          let web=&*platform.inner().cast::<objc2_web_kit::WKWebView>();
          web.loadHTMLString_baseURL(&objc2_foundation::NSString::from_str("<body><script>window.commands=[];addEventListener('forage-pane-command',e=>commands.push(e.detail))</script>"),None);
        })?;
        forage_lib::shortcuts_key::install(app.handle());
        forage_lib::shortcuts_key::workspace_shortcuts_set_active(true,Some("outline".into()));
        let app=app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let result=tokio::time::timeout(std::time::Duration::from_secs(45),verification::run(&app)).await;
          let report=match result { Ok(Ok(checks))=>serde_json::json!({"passed":true,"checks":checks}),other=>serde_json::json!({"passed":false,"error":format!("{other:?}")}) };
          if let Ok(path)=std::env::var("FORAGE_RESOURCE_REPORT") {std::fs::write(path,serde_json::to_vec_pretty(&report).unwrap()).unwrap();}
          println!("PANE_RESOURCE_REPORT: {report}");
          if report["passed"]!=true {std::process::exit(1);} println!("PANE_RESOURCES_PASSED");app.exit(0);
        }); Ok(())
      }).build(context).expect("production Page probe");
    std::process::exit(app.run_return(|_, _| {}));
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("macOS native resources probe");
}
#[cfg(target_os = "macos")]
mod verification {
    use block2::RcBlock;
    use forage_lib::page_peek::*;
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

    fn require(ok: bool, message: &str) -> Result<(), String> {
        if ok {
            Ok(())
        } else {
            Err(message.into())
        }
    }
    async fn ready(app: &AppHandle, label: &str, path: &str) -> Result<(), String> {
        for _ in 0..100 {
            if javascript(app, label, "document.body?.dataset.page || null").await? == path {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        Err(format!("Page {label} did not reach {path}"))
    }
    fn server() -> Result<String, String> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let address = listener.local_addr().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buffer = [0; 8192];
                let n = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let html = format!(
                    r#"<!doctype html><title>{path}</title><style>body{{margin:0}}.grid{{display:grid;grid-template-columns:repeat(2,1fr)}}@media(max-width:400px){{.grid{{grid-template-columns:1fr}}}}</style><body data-page="{path}"><div class=grid><p>left</p><p>right</p></div><a href="/next" id=next>Next</a><input id=input><p id=body tabindex=0>Page body</p><button id=count onclick='this.textContent=Number(this.textContent)+1'>0</button>"#
                );
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",html.len(),html);
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Ok(format!("http://{address}"))
    }
    fn bounds(x: f64, clip_x: f64, clip_width: f64) -> PeekBounds {
        PeekBounds {
            x,
            y: 48.0,
            width: 600.0,
            height: 500.0,
            clip_x,
            clip_y: 48.0,
            clip_width,
            clip_height: 500.0,
            viewport_width: 1000.0,
            viewport_height: 650.0,
        }
    }
    async fn geometry(
        app: &AppHandle,
        label: &str,
        width: f64,
        visible_width: f64,
        hidden: bool,
    ) -> Result<Value, String> {
        let view = app.get_webview(label).ok_or("Missing Page")?;
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| unsafe {
        let web=&*platform.inner().cast::<WKWebView>();let clip=web.superview().unwrap();let frame=web.frame();let visible=web.visibleRect();
        let result=(||{
          require(clip.clipsToBounds(),"Production container fails to clip")?;
          require(frame.size.width==width,"Full Page layout shrank to clipped width")?;
          require(clip.isHidden()==hidden,"Hidden Page presentation mismatch")?;
          if !hidden {require((visible.size.width-visible_width).abs()<1.0,"Drawable Page exceeds visible intersection")?;}
          let origin=clip.frame().origin;
          for point in [NSPoint::new(origin.x-1.0,origin.y+100.0),NSPoint::new(origin.x+clip.frame().size.width+1.0,origin.y+100.0),NSPoint::new(origin.x+10.0,origin.y-1.0),NSPoint::new(origin.x+10.0,origin.y+501.0)] {require(clip.hitTest(point).is_none(),"Page intercepts neighboring UI")?;}
          Ok(json!({"pageWidth":frame.size.width,"clipWidth":clip.frame().size.width,"visibleWidth":visible.size.width,"hidden":hidden,"outsideHitsRejected":4}))
        })();let _=done.send(result);
      }).map_err(|e|e.to_string())?;
        received.await.map_err(|e| e.to_string())?
    }
    pub async fn run(app: &AppHandle) -> Result<Vec<Value>, String> {
        let base = server()?;
        let a = page_peek_create(app.clone(), "pane-a".into()).await?;
        let b = page_peek_create(app.clone(), "pane-b".into()).await?;
        let al = app.state::<PageRegistry>().get(&a)?.label.clone();
        let bl = app.state::<PageRegistry>().get(&b)?.label.clone();
        page_peek_load(app.clone(), a.clone(), 1, format!("{base}/a"))?;
        page_peek_load(app.clone(), b.clone(), 1, format!("{base}/b"))?;
        page_peek_present(app.clone(), a.clone(), 1, bounds(56.0, 56.0, 300.0), true).await?;
        page_peek_present(app.clone(), b.clone(), 1, bounds(400.0, 700.0, 300.0), true).await?;
        ready(app, &al, "/a").await?;
        ready(app, &bl, "/b").await?;
        let mut checks = vec![];
        let scale = app
            .get_window("main")
            .unwrap()
            .scale_factor()
            .map_err(|e| e.to_string())?;
        for (stage, layout) in [
            ("partial", 56.0, 56.0, 300.0, true),
            ("horizontal-scroll", -480.0, 56.0, 64.0, true),
            ("offscreen", -700.0, 56.0, 0.0, true),
            ("sidebar-expanded", 200.0, 200.0, 300.0, true),
            ("modal", 200.0, 200.0, 300.0, false),
            ("settings", 200.0, 200.0, 300.0, false),
            ("restored", 56.0, 56.0, 300.0, true),
        ]
        .into_iter()
        .enumerate()
        {
            let (name, x, cx, cw, show) = layout;
            page_peek_present(
                app.clone(),
                a.clone(),
                stage as u64 + 2,
                bounds(x, cx, cw),
                show,
            )
            .await?;
            let native = geometry(app, &al, 600.0, cw, !show || cw == 0.0).await?;
            require(
                javascript(app, &al, "innerWidth").await? == 600,
                "WK viewport reflowed under clipping",
            )?;
            require(
                javascript(app, &bl, "document.body.dataset.page").await? == "/b",
                "Another resource lost its page",
            )?;
            checks.push(json!({"stage":name,"native":native,"scaleFactor":scale}));
        }
        let mut resized = bounds(56.0, 56.0, 360.0);
        resized.width = 720.0;
        page_peek_present(app.clone(), a.clone(), 20, resized, true).await?;
        geometry(app, &al, 720.0, 360.0, false).await?;
        require(
            javascript(app, &al, "innerWidth").await? == 720,
            "Resize failed to update full WK viewport",
        )?;
        checks
            .push(json!({"stage":"pane-resize-retains-resource","pageWidth":720,"clipWidth":360}));
        // An obsolete geometry response must not reveal a hidden resource.
        page_peek_present(app.clone(), a.clone(), 50, bounds(56.0, 56.0, 300.0), false).await?;
        page_peek_present(app.clone(), a.clone(), 49, bounds(56.0, 56.0, 300.0), true).await?;
        geometry(app, &al, 600.0, 300.0, true).await?;
        checks.push(json!({"stage":"stale-presentation-rejected"}));
        page_peek_present(app.clone(), a.clone(), 51, bounds(56.0, 56.0, 300.0), true).await?;
        javascript(
            app,
            &al,
            "(() => {document.querySelector('#next').click();return true})()",
        )
        .await?;
        ready(app, &al, "/next").await?;
        require(
            javascript(app, &bl, "document.body.dataset.page").await? == "/b",
            "A navigation changed B",
        )?;
        page_peek_navigate(app.clone(), a.clone(), PeekAction::Back)?;
        ready(app, &al, "/a").await?;
        page_peek_navigate(app.clone(), a.clone(), PeekAction::Forward)?;
        ready(app, &al, "/next").await?;
        page_peek_navigate(app.clone(), b.clone(), PeekAction::Reload)?;
        ready(app, &bl, "/b").await?;
        checks.push(json!({"stage":"independent-navigation-history-reload"}));
        // Native commands are routed from the actual responder, not last main owner.
        for (id, label, pane) in [(&a, &al, "pane-a"), (&b, &bl, "pane-b")] {
            javascript(app, "main", "(() => {commands=[];return true})()").await?;
            javascript(
                app,
                label,
                "(() => {document.querySelector('#body').focus();return true})()",
            )
            .await?;
            post(app, label, 13, false, false, false).await?;
            require(
                javascript(app, "main", "commands").await?
                    == json!([{"command":"close","nativePage":true,"sourcePaneId":pane,"resourceId":id}]),
                "Native command chose another Page owner",
            )?;
        }
        checks.push(json!({"stage":"native-focus-owned-command-delivery"}));
        require(
            page_peek_load(app.clone(), a.clone(), 2, "file:///etc/passwd".into()).is_err(),
            "File URL accepted",
        )?;
        javascript(
            app,
            &al,
            "(() => {location.href='tauri://localhost';return true})()",
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        require(
            javascript(app, &al, "document.body.dataset.page").await? == "/next",
            "Forbidden navigation escaped URL guard",
        )?;
        javascript(app,&al,"(() => {window.__TAURI_INTERNALS__.invoke('page_peek_close',{resourceId:'bogus'}).then(()=>window.denied=false,()=>window.denied=true);return true})()").await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        require(
            javascript(app, &al, "window.denied").await? == true,
            "Remote page gained app command access",
        )?;
        javascript(app,&al,"(() => {window.__TAURI_INTERNALS__.invoke('plugin:store|get',{rid:0,key:'secret'}).then(()=>window.pluginDenied=false,()=>window.pluginDenied=true);return true})()").await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        require(
            javascript(app, &al, "window.pluginDenied").await? == true,
            "Remote page gained plugin access",
        )?;
        checks.push(json!({"stage":"url-policy-and-remote-command-plugin-isolation"}));
        page_peek_close(app.clone(), a.clone())?;
        require(
            app.state::<PageRegistry>().get(&a).is_err(),
            "Closed ID remains registered",
        )?;
        require(
            page_peek_navigate(app.clone(), a.clone(), PeekAction::Reload).is_err(),
            "Closed resource accepted navigation",
        )?;
        require(
            page_peek_navigate(app.clone(), "unknown".into(), PeekAction::Reload).is_err(),
            "Unknown resource accepted navigation",
        )?;
        require(
            javascript(app, &bl, "document.body.dataset.page").await? == "/b",
            "Close changed another Page",
        )?;
        require(
            app.state::<PageRegistry>().resources().len() == 1,
            "Resource leaked on close",
        )?;
        page_peek_close(app.clone(), b)?;
        require(
            app.state::<PageRegistry>().resources().is_empty(),
            "Resource registry did not drain",
        )?;
        for _ in 0..50 {
            if app.get_webview(&al).is_none() && app.get_webview(&bl).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        require(
            app.get_webview(&al).is_none() && app.get_webview(&bl).is_none(),
            "Closed WKWebViews remain registered",
        )?;
        checks.push(
            json!({"stage":"closed-unknown-id-isolation-and-cleanup","nativeResourceCount":0}),
        );
        Ok(checks)
    }
}
