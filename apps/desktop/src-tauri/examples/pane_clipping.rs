//! Isolated macOS native-surface feasibility probe, without app persistence or IPC.
//! Run with `cargo run --example pane_clipping -- --verify` from src-tauri.
//! Verification runs inside real Tauri/WKWebView, emits a JSON report, and exits.
//! It needs neither desktop automation nor screen-recording/accessibility access.
#[cfg(target_os = "macos")]
fn main() {
    use tauri::{LogicalPosition, LogicalSize, WebviewBuilder, WebviewUrl, WindowBuilder};
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let verify = std::env::args().any(|argument| argument == "--verify");
    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = WindowBuilder::new(app, "clip-probe")
                .title("Forage — two native Page clipping probe")
                .inner_size(1000.0, 650.0)
                .resizable(false)
                .build()?;
            // Both pages lay out at 600px. Each exposes 300px, with an 80px gap.
            for (label, x, offset, color) in [
                ("clip-probe-a", 110.0, 0.0, "#bbe4d0"),
                ("clip-probe-b", 490.0, -300.0, "#c3d9ff"),
            ] {
                // Responsive CSS would switch to one column if clipping actually
                // shrank the page viewport; inspect its computed layout in WebKit.
                let html = format!(r#"<!doctype html><style>body{{margin:0;background:{color};font:20px system-ui}}.grid{{display:grid;grid-template-columns:repeat(2,1fr)}}@media(max-width:400px){{.grid{{grid-template-columns:1fr}}}}.cell{{height:440px;border:2px solid black;box-sizing:border-box;padding:20px}}button{{font-size:20px}}</style><body data-page="{label}"><div class=grid><div class=cell>{label} LEFT<br><button onclick='this.textContent=Number(this.textContent)+1'>0</button></div><div class=cell>{label} RIGHT<br><button onclick='this.textContent=Number(this.textContent)+1'>0</button></div></div><p id=width></p><script>document.querySelector('#width').textContent='layout width: '+innerWidth</script>"#);
                let view = window.add_child(
                    WebviewBuilder::new(label, WebviewUrl::External("about:blank".parse()?)),
                    LogicalPosition::new(x, 100.0), LogicalSize::new(600.0, 500.0),
                )?;
                view.with_webview(move |platform| {
                    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
                    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString};
                    use objc2_web_kit::WKWebView;
                    // SAFETY: with_webview supplies a live WKWebView on the main
                    // thread. The parent retains the clip, which retains the page.
                    unsafe {
                        let web = &*platform.inner().cast::<WKWebView>();
                        let parent = web.superview().expect("native parent");
                        let frame = web.frame();
                        let mtm = MainThreadMarker::new().expect("main thread");
                        let clip = NSView::new(mtm);
                        clip.setFrame(NSRect::new(frame.origin, NSSize::new(300.0, 500.0)));
                        clip.setClipsToBounds(true);
                        parent.addSubview(&clip);
                        web.removeFromSuperview();
                        clip.addSubview(web);
                        web.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
                        web.setFrame(NSRect::new(NSPoint::new(offset, 0.0), NSSize::new(600.0, 500.0)));
                        web.loadHTMLString_baseURL(&NSString::from_str(&html), None);
                        println!("{label}: clip=300x500 page=600x500 offset={offset}; native clip={}", clip.clipsToBounds());
                    }
                })?;
            }
            println!("CLIPPING_PROBE_READY: two independent surfaces; header/side margins/gap must remain clear");
            if verify {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let result = tokio::time::timeout(
                        std::time::Duration::from_secs(30), verification::run(&app),
                    ).await.unwrap_or_else(|_| Err("Native verification timed out".to_string()));
                    let passed = result.is_ok();
                    let report = match result {
                        Ok(checks) => serde_json::json!({"passed": true, "checks": checks}),
                        Err(error) => serde_json::json!({"passed": false, "error": error}),
                    };
                    if let Ok(path) = std::env::var("FORAGE_PANE_PROBE_REPORT") {
                        if let Err(error) = std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()) {
                            eprintln!("Cannot write probe report: {error}");
                            std::process::exit(1);
                        }
                    }
                    println!("CLIPPING_PROBE_REPORT: {report}");
                    println!("CLIPPING_PROBE_{}", if passed { "PASSED" } else { "FAILED" });
                    // Cocoa terminated this probe with status 0 even when
                    // AppHandle::exit(1) was requested. Preserve the test failure
                    // status explicitly after flushing its report.
                    if !passed { std::process::exit(1); }
                    app.exit(0);
                });
            }
            Ok(())
        })
        .build(context)
        .expect("native clipping probe");
    let exit_code = app.run_return(|_, _| {});
    std::process::exit(exit_code);
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This native clipping feasibility probe requires macOS.");
    if std::env::args().any(|argument| argument == "--verify") {
        std::process::exit(1);
    }
}

#[cfg(target_os = "macos")]
mod verification {
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSPoint, NSRect, NSSize, NSString};
    use objc2_web_kit::WKWebView;
    use serde_json::{json, Value};
    use tauri::{AppHandle, Manager};
    use tokio::sync::oneshot;

    const A: &str = "clip-probe-a";
    const B: &str = "clip-probe-b";

    fn require(condition: bool, message: &str) -> Result<(), String> {
        condition.then_some(()).ok_or_else(|| message.to_string())
    }

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

    async fn ready(app: &AppHandle, label: &str) -> Result<(), String> {
        for _ in 0..100 {
            if javascript(
                app,
                label,
                "document.readyState === 'complete' && document.body?.dataset.page || null",
            )
            .await?
                == label
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Err(format!("{label}: fixture did not finish loading"))
    }

    // Query the actual AppKit hierarchy, not the geometry requested from Tauri.
    // visibleRect is the ancestor-clipped drawable rectangle in page coordinates.
    async fn geometry(
        app: &AppHandle,
        label: &str,
        width: f64,
        offset: f64,
        hidden: bool,
    ) -> Result<Value, String> {
        let view = app.get_webview(label).ok_or("Missing native page")?;
        let (done, received) = oneshot::channel();
        view.with_webview(move |platform| {
            let result = (|| {
                // SAFETY: this main-thread callback has a live WKWebView; its
                // parent clipping view is retained by the window's content view.
                let web = unsafe { &*platform.inner().cast::<WKWebView>() };
                let clip = unsafe { web.superview() }.ok_or("Missing clipping ancestor")?;
                let fault = std::env::var("FORAGE_PANE_PROBE_FAULT").unwrap_or_default();
                if fault == "no-clipping" {
                    clip.setClipsToBounds(false);
                }
                require(clip.clipsToBounds(), "Native ancestor does not clip")?;
                let origin = clip.frame().origin;
                clip.setFrame(NSRect::new(origin, NSSize::new(width, 500.0)));
                clip.setHidden(hidden);
                let page_width = if fault == "reflow" { width } else { 600.0 };
                web.setFrame(NSRect::new(
                    NSPoint::new(offset, 0.0),
                    NSSize::new(page_width, 500.0),
                ));
                let visible = web.visibleRect();
                let frame = web.frame();
                require(
                    frame.size.width == 600.0,
                    "Native page shrank to its visible sliver",
                )?;
                if hidden {
                    require(
                        visible.size.width == 0.0 || visible.size.height == 0.0,
                        "Hidden page retains a drawable rectangle",
                    )?;
                } else {
                    require(
                        visible.origin.x == -offset && visible.size.width == width,
                        "AppKit drawable rectangle escapes the clipping ancestor",
                    )?;
                    require(
                        visible.origin.y == 0.0 && visible.size.height == 500.0,
                        "Native page escapes vertically",
                    )?;
                    let inside = NSPoint::new(origin.x + width / 2.0, origin.y + 250.0);
                    require(
                        clip.hitTest(inside).is_some(),
                        "Visible native page rejects an in-pane hit",
                    )?;
                }
                // Native hit testing must reject adjacent UI, even though the
                // full WKWebView frame extends into that area behind its clip.
                for point in [
                    NSPoint::new(origin.x - 1.0, origin.y + 250.0),
                    NSPoint::new(origin.x + width + 1.0, origin.y + 250.0),
                    NSPoint::new(origin.x + width / 2.0, origin.y - 1.0),
                    NSPoint::new(origin.x + width / 2.0, origin.y + 501.0),
                ] {
                    require(
                        clip.hitTest(point).is_none(),
                        "Native page intercepts neighboring UI",
                    )?;
                }
                Ok(
                    json!({"nativePageWidth": frame.size.width, "clipWidth": width,
                    "visibleX": visible.origin.x, "visibleWidth": visible.size.width,
                    "hidden": hidden, "outsideHitsRejected": 4}),
                )
            })();
            let _ = done.send(result);
        })
        .map_err(|error| error.to_string())?;
        tokio::time::timeout(Duration::from_secs(5), received)
            .await
            .map_err(|_| "Native geometry timed out".to_string())?
            .map_err(|_| "Native geometry callback dropped".to_string())?
    }

    async fn layout(app: &AppHandle, label: &str) -> Result<Value, String> {
        let value = javascript(app, label, r#"({
            page: document.body.dataset.page,
            viewportWidth: innerWidth,
            responsiveColumns: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns,
            rightColumnX: document.querySelectorAll('.cell')[1].getBoundingClientRect().x,
            counters: [...document.querySelectorAll('button')].map(button => Number(button.textContent))
        })"#).await?;
        require(
            value["page"] == label,
            "Native page state was routed to the wrong resource",
        )?;
        require(
            value["viewportWidth"] == 600,
            "WebKit viewport reflowed to its visible sliver",
        )?;
        require(
            value["responsiveColumns"] == "300px 300px" && value["rightColumnX"] == 300,
            "Responsive webpage layout changed under clipping",
        )?;
        Ok(value)
    }

    pub async fn run(app: &AppHandle) -> Result<Vec<Value>, String> {
        ready(app, A).await?;
        ready(app, B).await?;
        let mut checks = Vec::new();
        for (stage, a_width, a_offset, a_hidden, b_offset) in [
            ("opposite-halves", 300.0, 0.0, false, -300.0),
            (
                "horizontal-scroll-and-narrow-sliver",
                120.0,
                -480.0,
                false,
                -150.0,
            ),
            ("first-page-offscreen", 120.0, -480.0, true, 0.0),
            ("restored", 300.0, 0.0, false, -300.0),
        ] {
            let a_geometry = geometry(app, A, a_width, a_offset, a_hidden).await?;
            let b_geometry = geometry(app, B, 300.0, b_offset, false).await?;
            // Reading WebKit layout also waits for its process to observe the resize.
            let a_layout = layout(app, A).await?;
            let b_layout = layout(app, B).await?;
            checks.push(
                json!({"stage": stage, "a": {"native": a_geometry, "web": a_layout},
                "b": {"native": b_geometry, "web": b_layout}}),
            );
        }
        javascript(
            app,
            A,
            "(() => { document.querySelectorAll('button')[0].click(); return true })()",
        )
        .await?;
        require(
            layout(app, A).await?["counters"] == json!([1, 0]),
            "Page A interaction failed",
        )?;
        require(
            layout(app, B).await?["counters"] == json!([0, 0]),
            "Page A interaction affected Page B",
        )?;
        javascript(
            app,
            B,
            "(() => { document.querySelectorAll('button')[1].click(); return true })()",
        )
        .await?;
        require(
            layout(app, A).await?["counters"] == json!([1, 0]),
            "Page B interaction affected Page A",
        )?;
        require(
            layout(app, B).await?["counters"] == json!([0, 1]),
            "Page B interaction failed",
        )?;
        checks.push(json!({"stage": "independent-page-interaction", "aCounters": [1, 0], "bCounters": [0, 1]}));
        // Change one page's document; the other must retain its own live state.
        javascript(app, A, "(() => { document.querySelector('.cell').firstChild.textContent = 'changed A'; return true })()").await?;
        require(
            javascript(
                app,
                B,
                "document.querySelector('.cell').firstChild.textContent",
            )
            .await?
                == "clip-probe-b LEFT",
            "Page A document mutation affected Page B",
        )?;
        require(
            layout(app, B).await?["counters"] == json!([0, 1]),
            "Independent page lost its state",
        )?;
        checks.push(json!({"stage": "independent-document-state", "passed": true}));
        Ok(checks)
    }
}
