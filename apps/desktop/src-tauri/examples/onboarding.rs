//! Actual React App + native SQLite/Page integration; no desktop automation.
#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let root = std::path::PathBuf::from(
        std::env::var("FORAGE_ONBOARDING_DATA").expect("isolated test directory required"),
    );
    std::fs::create_dir_all(&root).unwrap();
    let mut context = tauri::generate_context!("tauri.workspace-verify.conf.json");
    context.config_mut().identifier = format!(
        "com.forage.onboarding-verification.{}",
        std::env::var("FORAGE_ONBOARDING_RUN_ID").unwrap()
    );
    let app=tauri::Builder::default()
      .manage(forage_lib::commands::NativeState {event_store:forage_lib::persistence::EventStore::open(root.join("events.sqlite3")).unwrap(),asset_store:forage_lib::assets::AssetStore::new(root.join("assets")).unwrap(),agent_sessions_dir:root.join("agent-sessions"),http_client:reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap()})
      .manage(forage_lib::page_peek::PageRegistry::default()).manage(forage_lib::server_stream::ServerStreamState::default())
      .invoke_handler(forage_lib::invoke_handler)
      .plugin(tauri_plugin_store::Builder::new().build()).plugin(tauri_plugin_http::init()).plugin(tauri_plugin_opener::init()).plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_dialog::init())
      .setup(|app| {
        let window=WindowBuilder::new(app,"main").title("Forage — integrated onboarding verification").inner_size(960.0,760.0).build()?;
        window.add_child(WebviewBuilder::new("main",WebviewUrl::App("verify/onboarding.html".into())).initialization_script("window.verifyErrors=[];addEventListener('error',e=>verifyErrors.push(e.message));addEventListener('unhandledrejection',e=>verifyErrors.push(String(e.reason)))"),LogicalPosition::new(0.0,0.0),LogicalSize::new(960.0,760.0))?;
        forage_lib::shortcuts_key::install(app.handle());
        let app=app.handle().clone();
        tauri::async_runtime::spawn(async move {
          let result=tokio::time::timeout(std::time::Duration::from_secs(180),verification::run(&app)).await;
          let report=match result {Ok(Ok(value))=>value, other=>serde_json::json!({"passed":false,"error":format!("{other:?}")})};
          std::fs::write(std::env::var("FORAGE_ONBOARDING_REPORT").unwrap(),serde_json::to_vec_pretty(&report).unwrap()).unwrap();
          println!("ONBOARDING_REPORT: {report}");
          if report["passed"]!=true {std::process::exit(1);} println!("ONBOARDING_NATIVE_PASSED");app.exit(0);
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
    use objc2_foundation::{NSError, NSString};
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

    async fn call(app: &AppHandle, expr: &str) -> Result<Value, String> {
        println!("ONBOARDING_CHECK {expr}");
        javascript(app, "main", &format!("(()=>{{window.verifyResult=null;Promise.resolve().then(()=>{expr}).then(value=>window.verifyResult={{ok:true,value}},error=>window.verifyResult={{ok:false,error:String(error)}});return true}})()")).await?;
        for _ in 0..1500 {
            let result = javascript(app, "main", "window.verifyResult").await?;
            if !result.is_null() {
                if result["ok"] == true {
                    println!("ONBOARDING_VALUE {}", result["value"]);
                    return Ok(result["value"].clone());
                }
                return Err(result["error"].to_string());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        Err(format!("Timed out: {expr}"))
    }
    async fn resize(app: &AppHandle, width: f64, height: f64) -> Result<(), String> {
        app.get_window("main")
            .unwrap()
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        app.get_webview("main")
            .unwrap()
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(200)).await;
        Ok(())
    }
    async fn enter(app: &AppHandle) -> Result<(), String> {
        let view = app.get_webview("main").ok_or("Missing main webview")?;
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| unsafe {
            use objc2_app_kit::{NSApplication, NSEvent, NSEventModifierFlags, NSEventType};
            use objc2_foundation::{MainThreadMarker, NSPoint};
            let web = &*platform.inner().cast::<WKWebView>();
            let window = web.window().unwrap();
            window.makeKeyAndOrderFront(None);
            window.makeFirstResponder(Some(web));
            let event = NSEvent::keyEventWithType_location_modifierFlags_timestamp_windowNumber_context_characters_charactersIgnoringModifiers_isARepeat_keyCode(
                NSEventType::KeyDown, NSPoint::new(0.0, 0.0), NSEventModifierFlags::empty(), 0.0, window.windowNumber(), None, &NSString::from_str("\r"), &NSString::from_str("\r"), false, 36).unwrap();
            NSApplication::sharedApplication(MainThreadMarker::new().unwrap()).postEvent_atStart(&event, false);
            let _ = done.send(());
        }).map_err(|e| e.to_string())?;
        received.await.map_err(|e| e.to_string())?;
        tokio::time::sleep(Duration::from_millis(180)).await;
        Ok(())
    }
    pub async fn run(app: &AppHandle) -> Result<Value, String> {
        for _ in 0..300 {
            if javascript(app, "main", "typeof onboardingVerify !== 'undefined'").await? == true {
                break;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        if javascript(app, "main", "typeof onboardingVerify !== 'undefined'").await? != true {
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
        let ready = call(app, "onboardingVerify.ready()").await?;
        let mode = std::env::var("FORAGE_ONBOARDING_MODE").unwrap_or_else(|_| "flow".into());
        if mode == "restart" {
            return Ok(
                json!({"passed":true,"ready":ready,"persistence":call(app,"onboardingVerify.restart()").await?}),
            );
        }
        if mode == "active" {
            return Ok(
                json!({"passed":true,"ready":ready,"persistence":call(app,"onboardingVerify.activeRestart()").await?}),
            );
        }
        if mode == "completed" {
            return Ok(
                json!({"passed":true,"ready":ready,"persistence":call(app,"onboardingVerify.completedRestart()").await?}),
            );
        }
        let mut checks = vec![];
        checks.push(call(app, "onboardingVerify.layout('09A-note')").await?);
        checks.push(call(app, "onboardingVerify.negativeControl()").await?);
        resize(app, 480.0, 600.0).await?;
        checks.push(call(app, "onboardingVerify.layout('09A-note-narrow')").await?);
        resize(app, 960.0, 760.0).await?;
        checks.push(call(app, "onboardingVerify.note()").await?);
        for stage in [
            "providerForm",
            "pendingProvider",
            "connectedProvider",
            "command",
            "pendingCommand",
            "result",
            "extensions",
            "configureExtension",
            "mcp",
            "mcpUrl",
            "mcpCommand",
            "completion",
        ] {
            if stage == "pendingCommand" {
                call(app, "onboardingVerify.focusCommand()").await?;
                enter(app).await?;
            }
            checks.push(call(app, &format!("onboardingVerify.{stage}()")).await?);
            resize(app, 480.0, 600.0).await?;
            checks.push(call(app, &format!("onboardingVerify.layout('{stage}-narrow')")).await?);
            resize(app, 960.0, 760.0).await?;
        }
        let persistence = call(app, "onboardingVerify.pause()").await?;
        Ok(json!({"passed":true,"checks":checks,"persistence":persistence}))
    }
}
