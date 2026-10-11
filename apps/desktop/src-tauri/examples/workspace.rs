//! Actual React App + native SQLite/Page integration; no desktop automation.
#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let root = std::path::PathBuf::from(
        std::env::var("FORAGE_WORKSPACE_DATA").expect("isolated test directory required"),
    );
    std::fs::create_dir_all(&root).unwrap();
    let mut context = tauri::generate_context!("tauri.workspace-verify.conf.json");
    context.config_mut().identifier = format!(
        "com.forage.workspace-verification.{}",
        std::env::var("FORAGE_WORKSPACE_RUN_ID").unwrap()
    );
    let app=tauri::Builder::default()
      .manage(forage_lib::commands::NativeState {event_store:forage_lib::persistence::EventStore::open(root.join("events.sqlite3")).unwrap(),asset_store:forage_lib::assets::AssetStore::new(root.join("assets")).unwrap(),agent_sessions_dir:root.join("agent-sessions"),http_client:reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()})
      .manage(forage_lib::page_peek::PageRegistry::default()).manage(forage_lib::server_stream::ServerStreamState::default())
      .invoke_handler(forage_lib::invoke_handler)
      .plugin(tauri_plugin_store::Builder::new().build()).plugin(tauri_plugin_http::init()).plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_dialog::init())
      .setup(|app| {
        let window=WindowBuilder::new(app,"main").title("Forage — integrated workspace verification").inner_size(1480.0,800.0).build()?;
        window.add_child(WebviewBuilder::new("main",WebviewUrl::App("verify/index.html".into())).initialization_script("window.verifyErrors=[];addEventListener('error',e=>verifyErrors.push(e.message));addEventListener('unhandledrejection',e=>verifyErrors.push(String(e.reason)))"),LogicalPosition::new(0.0,0.0),LogicalSize::new(1480.0,800.0))?;
        forage_lib::shortcuts_key::install(app.handle());
        let app=app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let result=tokio::time::timeout(std::time::Duration::from_secs(180),verification::run(&app)).await;
          let report=match result {Ok(Ok(value))=>value, other=>serde_json::json!({"passed":false,"error":format!("{other:?}")})};
          std::fs::write(std::env::var("FORAGE_WORKSPACE_REPORT").unwrap(),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
          println!("WORKSPACE_REPORT: {report}");
          if report["passed"]!=true {std::process::exit(1);} println!("WORKSPACE_NATIVE_PASSED");app.exit(0);
        });Ok(())
      }).build(context).expect("isolated workspace");
    std::process::exit(app.run_return(|_, _| {}));
}
#[cfg(not(target_os = "macos"))]
fn main() {
    panic!("macOS integration verification required")
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

    fn require(ok: bool, message: &str) -> Result<(), String> {
        if ok {
            Ok(())
        } else {
            Err(message.into())
        }
    }
    async fn call(app: &AppHandle, expr: &str) -> Result<Value, String> {
        println!("WORKSPACE_CHECK {expr}");
        javascript(app,"main",&format!("(()=>{{window.verifyResult=null;Promise.resolve({expr}).then(value=>window.verifyResult={{ok:true,value}},error=>window.verifyResult={{ok:false,error:String(error)}});return true}})()")).await?;
        for poll in 0..6000 {
            let result = javascript(app, "main", "window.verifyResult").await?;
            if !result.is_null() {
                if result["ok"] == true {
                    println!("WORKSPACE_VALUE {}", result["value"]);
                    return Ok(result["value"].clone());
                }
                return Err(result["error"].to_string());
            }
            if expr.contains("benchmark") && poll % 100 == 0 {
                println!("WORKSPACE_PROGRESS {}", javascript(app, "main", "workspaceVerify.progress()").await?);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err(format!("Timed out: {expr}"))
    }
    async fn page_geometry(app: &AppHandle, hidden: bool) -> Result<Vec<Value>, String> {
        let mut values = vec![];
        for resource in app
            .state::<forage_lib::page_peek::PageRegistry>()
            .resources()
        {
            let view = app.get_webview(&resource.label).ok_or("Page missing")?;
            let (done, received) = oneshot::channel();
            view.with_webview(move |platform| unsafe {
          let web=&*platform.inner().cast::<WKWebView>();let clip=web.superview().unwrap();let frame=web.frame();let visible=web.visibleRect();
          let result: Result<Value,String>=(||{
            require(clip.clipsToBounds(),"Unclipped production Page")?;
            require(!hidden || clip.isHidden(),"Application view did not hide Page")?;
            require(!clip.isHidden() || visible.size.width == 0.0,"Hidden Page is still visible")?;
            require(visible.size.width<=frame.size.width+1.0,"Page escaped pane intersection")?;
            Ok(json!({"resourceId":resource.id,"paneId":resource.pane_id,"pageWidth":frame.size.width,"visibleWidth":visible.size.width,"hidden":clip.isHidden()}))
          })();let _=done.send(result);
        }).map_err(|e|e.to_string())?;
            values.push(received.await.map_err(|e| e.to_string())??);
        }
        Ok(values)
    }
    pub async fn run(app: &AppHandle) -> Result<Value, String> {
        for _ in 0..300 {
            if javascript(app, "main", "typeof workspaceVerify !== 'undefined'").await? == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        if javascript(app, "main", "typeof workspaceVerify !== 'undefined'").await? != true {
            return Err(format!(
                "App module failed: {}",
                javascript(
                    app,
                    "main",
                    "({url:location.href,body:document.body.innerText,errors:window.verifyErrors})"
                )
                .await?
            ));
        }
        call(app, "workspaceVerify.ready()").await?;
        if std::env::var("FORAGE_WORKSPACE_RESTART").is_ok() {
            let persisted = call(app, "workspaceVerify.persistence()").await?;
            let panes = call(app, "workspaceVerify.panes()").await?;
            require(
                panes["outline"] == 1 && panes["web"] == 0,
                "Session layout leaked across restart",
            )?;
            require(
                panes["text"]
                    .as_str()
                    .is_some_and(|s| s.contains("A") && s.contains("B")),
                "Saved cross-pane text lost",
            )?;
            require(javascript(app,"main","document.querySelector('.tiptap').editor.state.doc.textContent.includes('Native result after source pane closed')").await?==true,"Run placement lost on restart")?;
            call(app, "workspaceVerify.focus(0)").await?;
            let undone = call(app, "workspaceVerify.undo()").await?;
            require(
                undone["text"] != panes["text"],
                "Restart did not restore durable undo",
            )?;
            let after_undo = call(app, "workspaceVerify.persistence()").await?;
            require(
                after_undo["count"].as_u64() == persisted["count"].as_u64().map(|n| n + 1),
                "Restart undo was recaptured or not saved",
            )?;
            return Ok(
                json!({"passed":true,"restart":true,"persisted":persisted,"panes":panes,"afterUndo":after_undo,"durableUndoAvailable":true}),
            );
        }
        let mut checks = vec![];
        checks.push(json!({"stage":"seed", "data":call(app,"workspaceVerify.seed()").await?}));
        let base = server()?;
        checks.push(json!({"stage":"open-right-source-visibility", "data":call(app,&format!("workspaceVerify.openRightRegression({})",json!(base))).await?}));
        if std::env::var("FORAGE_WORKSPACE_LAYOUT_ONLY").as_deref() == Ok("1") {
            return Ok(json!({"passed":true,"checks":checks}));
        }
        call(app, "workspaceVerify.focus(0)").await?;
        post(app, "main", 42, true, false, false).await?;
        post(app, "main", 42, true, false, false).await?;
        let panes = call(app, "workspaceVerify.panes()").await?;
        require(
            panes["outline"] == 3,
            "Native Split did not create three App panes",
        )?;
        checks.push(json!({"stage":"three-real-app-views","data":panes}));
        call(app, "workspaceVerify.edit(0,'A')").await?;
        call(app, "workspaceVerify.focus(1)").await?;
        call(app, "workspaceVerify.edit(1,'B')").await?;
        let before = call(app, "workspaceVerify.panes()").await?;
        require(before["equal"] == true, "Same-node edits diverged")?;
        let undone = call(app, "workspaceVerify.undo()").await?;
        require(
            undone["text"] != before["text"],
            "Shared undo did not compensate",
        )?;
        let redone = call(app, "workspaceVerify.redo()").await?;
        require(
            redone["text"] == before["text"],
            "Shared redo did not restore",
        )?;
        let durable = call(app, "workspaceVerify.persistence()").await?;
        require(
            durable["count"] == 5,
            "Edits/undo/redo were recaptured or omitted",
        )?;
        checks.push(json!({"stage":"same-node-shared-undo-durability","data":durable}));
        let run = call(app, "workspaceVerify.startRun()").await?;
        post(app, "main", 13, false, false, false).await?;
        let finished = call(app, "workspaceVerify.finishRun()").await?;
        require(
            finished["outline"] == 2 && finished["equal"] == true,
            "Source closure destroyed run/document",
        )?;
        checks.push(json!({"stage":"close-during-durable-run","run":run,"data":finished}));
        call(app, "workspaceVerify.focus(1)").await?;
        post(app, "main", 13, false, false, false).await?;
        javascript(app,"main",r#"(()=>{for(const label of ['Collapse sidebar','Collapse activity sidebar'])document.querySelector(`button[aria-label="${label}"]`)?.click();return true})()"#).await?;
        call(app, &format!("workspaceVerify.web({})", json!(base))).await?;
        for _ in 0..100 {
            if app
                .state::<forage_lib::page_peek::PageRegistry>()
                .resources()
                .len()
                == 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
        tokio::time::sleep(Duration::from_millis(350)).await;
        let ids = app
            .state::<forage_lib::page_peek::PageRegistry>()
            .resources()
            .iter()
            .map(|r| r.id.clone())
            .collect::<Vec<_>>();
        require(ids.len() == 2, "App did not create two native resources")?;
        let layout = call(app, "workspaceVerify.layout()").await?;
        require(
            layout["headerHeights"].as_array().is_some_and(|heights| {
                heights.len() == 3 && heights.iter().all(|h| h.as_f64() == Some(48.0))
            }),
            "App headers differ from the 48px Pen alignment",
        )?;
        require(
            layout["separatorWidths"]
                .as_array()
                .is_some_and(|widths| widths.iter().all(|w| w.as_f64() == Some(1.0))),
            "App separators differ from the Pen rule",
        )?;
        checks.push(json!({"stage":"actual-app-pen-layout","data":layout,"references":["j6MIs","U6GEmb","Lv3U2","B3v8d9","LHer1","MVl2N"]}));
        for resource in app
            .state::<forage_lib::page_peek::PageRegistry>()
            .resources()
        {
            let mut loaded = false;
            for _ in 0..100 {
                if javascript(app, &resource.label, "Boolean(document.body?.dataset.page)").await?
                    == true
                {
                    loaded = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            require(loaded, "App Page failed to load fixture")?;
        }
        checks.push(json!({"stage":"three-pane-outline-two-pages","geometry":page_geometry(app,false).await?}));
        let order=call(app,"workspaceVerify.order()").await?;
        let resources=app.state::<forage_lib::page_peek::PageRegistry>().resources();
        let right=resources.iter().find(|r|json!(r.pane_id)==order["ids"][2]).ok_or("Right Page missing")?;
        let middle=resources.iter().find(|r|json!(r.pane_id)==order["ids"][1]).ok_or("Middle Page missing")?;
        post(app,&right.label,123,false,true,false).await?;
        require(call(app,"workspaceVerify.order()").await?["active"]==order["ids"][1],"Native previous did not focus the adjacent App pane")?;
        post(app,&middle.label,124,false,true,false).await?;
        require(call(app,"workspaceVerify.order()").await?["active"]==order["ids"][2],"Native next did not focus the adjacent App pane")?;
        checks.push(json!({"stage":"actual-app-native-previous-next","paneOrder":order["ids"]}));
        call(app, "workspaceVerify.settings(true)").await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        checks.push(
            json!({"stage":"settings-hides-surfaces","geometry":page_geometry(app,true).await?}),
        );
        call(app, "workspaceVerify.settings(false)").await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        require(
            app.state::<forage_lib::page_peek::PageRegistry>()
                .resources()
                .iter()
                .all(|r| ids.contains(&r.id)),
            "Settings recreated resources",
        )?;
        app.get_window("main")
            .unwrap()
            .set_size(tauri::LogicalSize::new(980.0, 700.0))
            .map_err(|e| e.to_string())?;
        app.get_webview("main")
            .unwrap()
            .set_size(tauri::LogicalSize::new(980.0, 700.0))
            .map_err(|e| e.to_string())?;
        javascript(
            app,
            "main",
            "(()=>{document.querySelector('.workspace-panes').scrollLeft=150;return true})()",
        )
        .await?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        let geometry = page_geometry(app, false).await?;
        require(
            geometry
                .iter()
                .any(|g| g["visibleWidth"].as_f64().unwrap() < g["pageWidth"].as_f64().unwrap()),
            "Real strip did not partially clip a page",
        )?;
        checks.push(json!({"stage":"real-strip-scroll-clipping","geometry":geometry}));
        let page = app
            .state::<forage_lib::page_peek::PageRegistry>()
            .resources()[0]
            .label
            .clone();
        post(app, &page, 13, false, false, false).await?;
        require(
            app.state::<forage_lib::page_peek::PageRegistry>()
                .resources()
                .len()
                == 1,
            "Native Page Close did not remove exactly its owner",
        )?;
        call(app, "workspaceVerify.closeWeb()").await?;
        tokio::time::sleep(Duration::from_millis(100)).await;
        require(
            app.state::<forage_lib::page_peek::PageRegistry>()
                .resources()
                .is_empty(),
            "Page leaked after App closure",
        )?;
        checks.push(json!({"stage":"owned-native-close-and-resource-cleanup"}));
        let cycles_started = std::time::Instant::now();
        for _ in 0..5 {
            call(app, &format!("workspaceVerify.web({})", json!(base))).await?;
            for _ in 0..100 {
                if app
                    .state::<forage_lib::page_peek::PageRegistry>()
                    .resources()
                    .len()
                    == 2
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            require(
                app.state::<forage_lib::page_peek::PageRegistry>()
                    .resources()
                    .len()
                    == 2,
                "Page cycle did not mount two resources",
            )?;
            call(app, "workspaceVerify.settings(true)").await?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            call(app, "workspaceVerify.settings(false)").await?;
            call(app, "workspaceVerify.closeWeb()").await?;
            for _ in 0..100 {
                if app
                    .state::<forage_lib::page_peek::PageRegistry>()
                    .resources()
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            require(
                app.state::<forage_lib::page_peek::PageRegistry>()
                    .resources()
                    .is_empty(),
                "Native Page cycle leaked resources",
            )?;
            require(app.webviews().len() == 1, "Page cycle leaked native views")?;
        }
        let layout = call(app, "workspaceVerify.layout()").await?;
        require(
            layout["objectUrls"] == 0,
            "Page snapshots leaked object URLs",
        )?;
        checks.push(json!({"stage":"native-page-open-close-snapshot-cycles","cycles":5,"resourcesCreated":10,"remainingNativeWebviews":app.webviews().len(),"objectUrls":layout["objectUrls"],"elapsedMs":cycles_started.elapsed().as_millis()}));
        // WebKit suspends requestAnimationFrame for an occluded/inactive app.
        // The latency probe needs the fixture window visible and active.
        app.get_window("main").unwrap().set_focus().map_err(|e| e.to_string())?;
        let performance = call(app, "workspaceVerify.benchmark()").await?;
        let durable = call(app, "workspaceVerify.persistence()").await?;
        require(durable["runs"].as_array().is_some_and(|runs|runs.len()==1&&runs[0]["status"]=="completed"&&!runs[0]["resultIdentity"].is_null()),"Run admission/result was not durable")?;
        require(
            durable["count"] == durable["unique"],
            "Duplicate durable event IDs",
        )?;
        require(
            app.webviews().len() == 1,
            "Native resources leaked through cycles",
        )?;
        Ok(
            json!({"passed":true,"checks":checks,"performance":performance,"durable":durable,"nativeWebviews":app.webviews().len()}),
        )
    }
}
