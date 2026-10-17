// Reviewroom.app: native tabs for the pages of local review servers. Nothing is watched or polled: `reviewroom`
// hands each new review to the app (`open -b dev.reviewroom.mac <url>`, RunEvent::Opened), and links between
// pages (the hub's Open, a review's All reviews) open tabs here. The first tab is the hub (`reviewroom hub`),
// which lists every running review. Each tab loads the server's own page, so the client in src/ runs unchanged.
// The menu bar is in menu.rs.
mod menu;

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use dispatch2::DispatchQueue;
use objc2_app_kit::{NSWindow, NSWindowTabbingMode};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::Submenu,
    webview::{NewWindowResponse, PageLoadEvent}, AppHandle, Manager, PhysicalPosition, RunEvent, Url, Webview,
    WebviewBuilder, WebviewUrl, Window, WindowBuilder, WindowEvent, Wry,
};

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    /// reviews handed to the app open here; off: in the browser
    auto_open: bool,
    focus_new: bool,
    unload_idle: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { auto_open: true, focus_new: true, unload_idle: true }
    }
}

// Lock one at a time and never across a window call: window events re-enter through the menu.
#[derive(Default)]
struct State {
    /// open tabs by window label, in the order they opened: the Reviews menu and its shortcuts
    tabs: Mutex<Vec<(String, Url)>>,
    /// each tab's page title, by window label (the window's own title lags behind)
    titles: Mutex<HashMap<String, String>>,
    /// each tab's guided walkthrough, as its page reports it: "none", "closed", "paused" or "playing"
    walkthrough: Mutex<HashMap<String, String>>,
    /// pages of closed tabs, last closed last: File > Reopen Closed Tab
    closed: Mutex<Vec<Url>>,
    settings: Mutex<Settings>,
    zoom: Mutex<HashMap<String, f64>>,
    /// label of the tab last focused
    current: Mutex<Option<String>>,
    /// since when a tab has been in the background
    idle: Mutex<HashMap<String, Instant>>,
    /// tabs whose page was unloaded to free memory; focusing one loads it again
    asleep: Mutex<HashSet<String>>,
    reviews_menu: Mutex<Option<Submenu<Wry>>>,
    /// the hub's port, once `reviewroom hub` has said where it runs
    hub_port: Mutex<Option<u16>>,
    /// a `reviewroom hub` is running for us now
    hub_asking: AtomicBool,
}

// A page costs 95-300 MB (its own WebKit process); one left in the background this long is unloaded.
// REVIEWROOM_IDLE_SECS overrides it, for trying it out.
fn idle_after() -> Duration {
    let secs = std::env::var("REVIEWROOM_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    Duration::from_secs(secs)
}

/// One tab per server: a restarted round takes over its review's port, and the open tab reconnects.
fn label_of(u: &Url) -> String {
    format!("tab-{}", u.port_or_known_default().unwrap_or(0))
}

fn url_of(app: &AppHandle, label: &str) -> Option<Url> {
    let st = app.state::<State>();
    let tabs = st.tabs.lock().unwrap();
    tabs.iter().find(|(l, _)| l == label).map(|(_, u)| u.clone())
}

fn set_url(app: &AppHandle, label: &str, u: Url) {
    let st = app.state::<State>();
    let mut tabs = st.tabs.lock().unwrap();
    if let Some(t) = tabs.iter_mut().find(|(l, _)| l == label) {
        t.1 = u;
    }
}

fn is_hub(app: &AppHandle, label: &str) -> bool {
    app.state::<State>().hub_port.lock().unwrap().is_some_and(|p| label == format!("tab-{p}"))
}

/// A tab came to the front: load its page again if it was unloaded.
fn wake(app: &AppHandle, label: &str) {
    let st = app.state::<State>();
    st.idle.lock().unwrap().remove(label);
    if !st.asleep.lock().unwrap().remove(label) {
        return;
    }
    if let (Some(w), Some(u)) = (app.get_window(label), url_of(app, label)) {
        if page(app, label).is_none() {
            let _ = attach(&w, &u);
        }
    }
}

/// Unloads the pages of tabs in the background for longer than idle_after(); the tab shown in a window never is.
/// Drafts survive (the page keeps them in localStorage); layout, threads and rounds are on the server. Main thread.
fn unload_idle(app: &AppHandle) {
    let st = app.state::<State>();
    for (label, w) in app.windows() {
        let since = st.idle.lock().unwrap().get(&label).copied();
        if since.is_some_and(|t| t.elapsed() > idle_after())
            && !selected(&w)
            && st.asleep.lock().unwrap().insert(label.clone())
        {
            if let Some(p) = page(app, &label) {
                if let Ok(u) = p.url() {
                    set_url(app, &label, u); // where it was: a walkthrough keeps its slide in the URL
                }
                let _ = p.close(); // ends its WebKit process; a blank page would keep ~70 MB
            }
        }
    }
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    let Some(p) = settings_path(app) else { return };
    let _ = fs::create_dir_all(p.parent().unwrap_or(&p));
    let _ = fs::write(&p, serde_json::to_vec_pretty(s).unwrap_or_default());
}

fn is_loopback(u: &Url) -> bool {
    u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost"))
}

fn is_own(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "about" | "blob" => true,
        _ => is_loopback(url) && url.port_or_known_default() == Some(port),
    }
}

// Links out of the reviews (GitHub, CI) belong in the browser, not in a tab here.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
    }
}

// A page leaving its server: a review's All reviews (/api/hub) shows the hub's tab, another local page (the hub's
// Open) opens in a tab here, the rest (and the hub's Open in browser, marked #rr-browser) in the browser.
fn route(app: &AppHandle, u: &Url) {
    let mut u = u.clone();
    if u.fragment() == Some("rr-browser") {
        u.set_fragment(None);
        return open_external(&u);
    }
    if !is_loopback(&u) {
        return open_external(&u);
    }
    // after the page's own event: building a window inside a web view's callback deadlocks
    let app = app.clone();
    after_event(move || {
        if u.path() == "/api/hub" {
            show_hub(&app, true);
        } else {
            drop(open_tab(&app, &u, true));
        }
    });
}

/// Shows the page's tab, creating it if needed; `focus` also brings the app to the front. Main thread.
fn open_tab(app: &AppHandle, u: &Url, focus: bool) -> tauri::Result<()> {
    let label = label_of(u);
    if let Some(w) = app.get_window(&label) {
        let tour = |u: &Url| u.query_pairs().find(|(k, _)| k == "walkthrough").map(|(_, v)| !v.is_empty());
        if tour(u) == Some(false) {
            // the hub's Play (?walkthrough, no slide): play this tab's walkthrough, or resume it where it is;
            // a page that hasn't reported one yet (still loading) is loaded with the link, which plays once ready
            let ready = app.state::<State>().walkthrough.lock().unwrap().get(&label).is_some_and(|t| t != "none");
            match page(app, &label) {
                Some(p) if ready => drop(p.eval("window.reviewroomWalkthrough?.('play')")),
                Some(p) => {
                    set_url(app, &label, u.clone());
                    let _ = p.navigate(u.clone());
                }
                // unloaded: it comes back on its slide if it had one (unload_idle kept the URL), else plays from the start
                None if url_of(app, &label).is_some_and(|v| tour(&v) != Some(true)) => set_url(app, &label, u.clone()),
                None => {}
            }
        } else if u.query().is_some() || u.path() != "/" {
            // a link to a place in the page (?walkthrough=<chapter>/<step>) goes there, not just to the tab
            set_url(app, &label, u.clone());
            if let Some(p) = page(app, &label) {
                let _ = p.navigate(u.clone());
            } // an unloaded page loads it when its tab is shown
        }
        if focus {
            bring_forward(w);
        }
        return Ok(());
    }
    let w = WindowBuilder::new(app, &label)
        .title(format!("{}:{}", u.host_str().unwrap_or_default(), u.port_or_known_default().unwrap_or(0))) // until the page's title
        .inner_size(1440.0, 900.0)
        .tabbing_identifier("reviewroom")
        .visible(false)
        .build()?;
    // AppKit joins it to the other windows when it is shown, whatever "Prefer tabs" says
    // (its default, full screen only, would open a separate window).
    if let Some(win) = ns_window(&w) {
        win.setTabbingMode(NSWindowTabbingMode::Preferred);
    }
    attach(&w, u)?;
    let st = app.state::<State>();
    st.tabs.lock().unwrap().push((label.clone(), u.clone()));
    st.idle.lock().unwrap().insert(label, Instant::now());
    after_event(move || {
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
        }
    });
    menu::refresh(app);
    Ok(())
}

/// Runs AppKit work that can redraw a window on the spot (joining a tab group, showing, focusing) after the
/// current event. tao's event handler is not re-entrant: a redraw from inside it deadlocks the app.
fn after_event(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

fn bring_forward(w: Window) {
    after_event(move || {
        let _ = w.unminimize();
        let _ = w.set_focus();
    });
}

// The page is a web view inside the tab's window, not the window itself, so it can be closed to free memory
// while the tab stays. Its label changes each time: a closed web view's label is not free right away.
static PAGES: AtomicUsize = AtomicUsize::new(0);

fn page(app: &AppHandle, label: &str) -> Option<Webview> {
    app.get_window(label)?.webviews().into_iter().next()
}

fn attach(w: &Window, u: &Url) -> tauri::Result<()> {
    let port = u.port_or_known_default().unwrap_or(0);
    let n = PAGES.fetch_add(1, Ordering::Relaxed);
    let (app, app2) = (w.app_handle().clone(), w.app_handle().clone());
    let b = WebviewBuilder::new(format!("{}-page-{n}", w.label()), WebviewUrl::External(u.clone()))
        .auto_resize()
        .initialization_script("window.reviewroomApp = true") // the hub page adds Open in browser
        .on_navigation(move |u| is_own(u, port) || (route(&app, u), false).1)
        .on_new_window(move |u, _| {
            route(&app2, &u);
            NewWindowResponse::Deny
        })
        .on_page_load(|p, e| {
            // a new page reports its own walkthrough, if any; until then the menu has none
            if e.event() == PageLoadEvent::Started {
                let w = p.window();
                w.app_handle().state::<State>().walkthrough.lock().unwrap().remove(w.label());
                after_event(move || menu::refresh(w.app_handle()));
            }
        })
        .on_document_title_changed(|p, title| {
            // the tab is named by its page (`<rr-app>` sets the PR's title)
            let w = p.window();
            w.app_handle().state::<State>().titles.lock().unwrap().insert(w.label().to_string(), title.clone());
            after_event(move || {
                let _ = w.set_title(&title);
                menu::refresh(w.app_handle());
            });
        });
    let p = w.add_child(b, PhysicalPosition::new(0, 0), w.inner_size()?)?;
    let zoom = w.app_handle().state::<State>().zoom.lock().unwrap().get(w.label()).copied();
    if let Some(z) = zoom {
        p.set_zoom(z)?;
    }
    Ok(())
}

/// Where the hub last said it runs (~/.reviewroom/hub.json, AGENTS.md: a contract), read when asked for.
fn hub_record() -> Option<Url> {
    let home = std::env::var_os("REVIEWROOM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".reviewroom"));
    let rec: serde_json::Value = serde_json::from_slice(&fs::read(home.join("hub.json")).ok()?).ok()?;
    rec["url"].as_str()?.parse().ok()
}

/// The hub's tab (at launch, the Dock icon, Reviews > All Reviews, a review's All reviews), from hub.json right
/// away; then `reviewroom hub` starts the hub if it isn't running and prints where it runs, and a hub on
/// another port replaces the tab. Main thread.
fn show_hub(app: &AppHandle, focus: bool) {
    let rec = hub_record();
    if let Some(u) = &rec {
        *app.state::<State>().hub_port.lock().unwrap() = u.port_or_known_default();
        let _ = open_tab(app, u, focus);
    }
    let known = rec.and_then(|u| u.port_or_known_default());
    if app.state::<State>().hub_asking.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    thread::spawn(move || {
        // the app's PATH has neither `reviewroom` nor `bun`: the user's login shell has both
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = std::process::Command::new(shell)
            .args(["-ilc", "reviewroom hub --detach --no-open"])
            .stdin(std::process::Stdio::null())
            .output();
        app.state::<State>().hub_asking.store(false, Ordering::SeqCst);
        let out = out.ok();
        // a hub started just now: an open tab of it holds a load error from before (stderr says which)
        let started = out.as_ref().is_some_and(|o| !String::from_utf8_lossy(&o.stderr).contains("already running"));
        let url = out.and_then(|o| {
            let s = String::from_utf8_lossy(&o.stdout).into_owned();
            s.lines().rev().find_map(|l| l.trim().parse::<Url>().ok().filter(is_loopback))
        });
        let Some(url) = url else {
            return eprintln!("reviewroom: `reviewroom hub` did not start the hub (is `reviewroom` on your login shell's PATH?)");
        };
        let app2 = app.clone();
        if url.port_or_known_default() == known {
            if let Some(p) = started.then(|| page(&app, &label_of(&url))).flatten() {
                let _ = p.reload();
            }
            return;
        }
        // after the current event: building windows inside tao's handler deadlocks
        after_event(move || {
            let new = url.port_or_known_default();
            let old = std::mem::replace(&mut *app2.state::<State>().hub_port.lock().unwrap(), new);
            // the tabs of hubs no longer running: the one this request saw, and one a later request opened meanwhile
            for p in [known, old].into_iter().flatten().filter(|p| Some(*p) != new) {
                if let Some(w) = app2.get_window(&format!("tab-{p}")) {
                    let _ = w.close();
                }
            }
            let _ = open_tab(&app2, &url, focus);
        });
    });
}

/// A page's guided walkthrough changed state (src/overlays/walkthrough.ts): the Reviews menu follows.
#[tauri::command]
fn walkthrough_state(webview: Webview, state: String) {
    let w = webview.window();
    w.app_handle().state::<State>().walkthrough.lock().unwrap().insert(w.label().to_string(), state);
    after_event(move || menu::refresh(w.app_handle()));
}

/// `reviewroom` handed the app a review (`open -b dev.reviewroom.mac <url>`). Main thread.
fn opened(app: &AppHandle, urls: Vec<Url>) {
    let settings = *app.state::<State>().settings.lock().unwrap();
    for u in urls.iter().filter(|u| is_loopback(u)) {
        if !settings.auto_open {
            open_external(u);
        } else if let Err(e) = open_tab(app, u, settings.focus_new) {
            eprintln!("reviewroom: could not open {u}: {e}");
        }
    }
}

/// File > Reopen Closed Tab: the last closed tab's page.
fn reopen_closed(app: &AppHandle) {
    let last = app.state::<State>().closed.lock().unwrap().pop();
    if let Some(u) = last {
        let _ = open_tab(app, &u, true);
    }
}

// AppKit side of a tab's window. Main thread only.
fn ns_window(w: &Window) -> Option<&NSWindow> {
    // SAFETY: Tauri hands out the window's live NSWindow, which outlives this borrow of `w`.
    w.ns_window().ok().map(|p| unsafe { &*(p as *const NSWindow) })
}

// isVisible is true for every tab of a window; only the selected one is on screen.
fn selected(w: &Window) -> bool {
    let Some(win) = ns_window(w) else { return true };
    win.tabGroup().and_then(|g| g.selectedWindow()).is_none_or(|sel| std::ptr::eq(&*sel, win))
}

fn main() {
    tauri::Builder::default()
        .manage(State::default())
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<State>().settings.lock().unwrap() = load_settings(&handle);
            menu::install(&handle)?;
            show_hub(&handle, false);
            // a timer, not a watcher: background tabs past idle_after() give their memory back
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(60));
                if handle.state::<State>().settings.lock().unwrap().unload_idle {
                    let app = handle.clone();
                    let _ = handle.run_on_main_thread(move || unload_idle(&app));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![walkthrough_state])
        .on_menu_event(menu::handle)
        .on_window_event(|w, e| {
            let app = w.app_handle();
            let st = app.state::<State>();
            match e {
                WindowEvent::Focused(true) => {
                    *st.current.lock().unwrap() = Some(w.label().to_string());
                    wake(app, w.label());
                }
                WindowEvent::Focused(false) => {
                    st.idle.lock().unwrap().insert(w.label().to_string(), Instant::now());
                }
                WindowEvent::Destroyed => {
                    let gone = {
                        let mut tabs = st.tabs.lock().unwrap();
                        tabs.iter().position(|(l, _)| l == w.label()).map(|i| tabs.remove(i).1)
                    };
                    st.closed.lock().unwrap().extend(gone);
                    st.titles.lock().unwrap().remove(w.label());
                    st.walkthrough.lock().unwrap().remove(w.label());
                }
                _ => {}
            }
            if matches!(e, WindowEvent::Focused(_) | WindowEvent::Destroyed) {
                // queued: a destroyed window leaves the app's list after its event
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || menu::refresh(&app2));
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Reviewroom")
        .run(|app, event| match event {
            RunEvent::Opened { urls } => {
                let app = app.clone();
                after_event(move || opened(&app, urls)); // builds windows: not inside tao's handler
            }
            // stay in the Dock with no tabs open: the next review opens a window
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Reopen { has_visible_windows: false, .. } => show_hub(app, true),
            _ => {}
        });
}
