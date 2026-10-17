// Reviewroom.app: one native tab per running review. Each review server registers itself in
// ~/.reviewroom/sessions/<pid>.json (AGENTS.md: a contract); the app follows that folder and loads
// each server's own page, so the client in src/ runs unchanged. The menu bar is in menu.rs.
mod menu;

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
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
    webview::NewWindowResponse, AppHandle, Manager, PhysicalPosition, RunEvent, Url, Webview,
    WebviewBuilder, WebviewUrl, Window, WindowBuilder, WindowEvent, Wry,
};

#[derive(Deserialize, Clone, PartialEq)]
struct Session {
    pid: u32,
    port: u16,
    url: String,
    repo: String,
    title: Option<String>,
    number: Option<serde_json::Value>,
    // where the CLI wants the review shown: "app", "browser" (--browser) or "none" (--no-open)
    open: Option<String>,
    #[serde(rename = "prUrl")]
    pr_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
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
    /// pids shown once: closing a tab does not bring it back (Reopen Closed Reviews does)
    opened: Mutex<HashSet<u32>>,
    /// live reviews by window label, in port order: the Reviews menu and its shortcuts
    sessions: Mutex<Vec<(String, Session)>>,
    settings: Mutex<Settings>,
    zoom: Mutex<HashMap<String, f64>>,
    /// label of the review tab last focused
    current: Mutex<Option<String>>,
    /// since when a tab has been in the background
    idle: Mutex<HashMap<String, Instant>>,
    /// tabs whose page was unloaded to free memory; focusing one loads it again
    asleep: Mutex<HashSet<String>>,
    reviews_menu: Mutex<Option<Submenu<Wry>>>,
}

// A page costs 95-300 MB (its own WebKit process); one left in the background this long is unloaded.
// REVIEWROOM_IDLE_SECS overrides it, for trying it out.
fn idle_after() -> Duration {
    let secs = std::env::var("REVIEWROOM_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    Duration::from_secs(secs)
}

/// A tab came to the front: load its page again if it was unloaded.
fn wake(app: &AppHandle, label: &str) {
    let st = app.state::<State>();
    st.idle.lock().unwrap().remove(label);
    if !st.asleep.lock().unwrap().remove(label) {
        return;
    }
    let s = st.sessions.lock().unwrap().iter().find(|(l, _)| l == label).map(|(_, s)| s.clone());
    if let (Some(w), Some(s)) = (app.get_window(label), s) {
        if page(app, label).is_none() {
            let _ = attach(&w, &s);
        }
    }
}

/// Unloads the pages of tabs in the background for longer than idle_after(); the tab shown in a window never is.
/// Drafts and layout survive (the page keeps them in localStorage), threads and rounds are on the server. Main thread.
fn unload_idle(app: &AppHandle) {
    let st = app.state::<State>();
    for (label, w) in app.windows() {
        let since = st.idle.lock().unwrap().get(&label).copied();
        if since.is_some_and(|t| t.elapsed() > idle_after())
            && !selected(&w)
            && st.asleep.lock().unwrap().insert(label.clone())
        {
            if let Some(p) = page(app, &label) {
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

fn sessions_dir() -> PathBuf {
    std::env::var_os("REVIEWROOM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".reviewroom"))
        .join("sessions")
}

// Keyed by port, not pid: a restarted round takes over its review's port, and the open tab reconnects.
fn read_sessions() -> HashMap<String, Session> {
    let Ok(entries) = fs::read_dir(sessions_dir()) else { return HashMap::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_slice::<Session>(&fs::read(e.path()).ok()?).ok())
        .filter(answers)
        .map(|s| (format!("review-{}", s.port), s))
        .collect()
}

// A server killed hard leaves its session file behind, and its port can go to another review: a session is live
// only if the server on its port says it is that pid (as cli/lib/lock.ts answers() checks).
fn answers(s: &Session) -> bool {
    let Ok(mut c) = TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], s.port)), Duration::from_millis(300)) else {
        return false;
    };
    let mut head = String::new();
    let read = c
        .set_read_timeout(Some(Duration::from_millis(800)))
        .and_then(|_| c.write_all(format!("HEAD /favicon.ico HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n\r\n", s.port).as_bytes()))
        .and_then(|_| c.read_to_string(&mut head));
    match read {
        // busy (git calls are synchronous): still there
        Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => true,
        _ => head.lines().any(|l| l.trim().eq_ignore_ascii_case(&format!("x-reviewroom-pid: {}", s.pid))),
    }
}

fn title(s: &Session) -> String {
    let repo = s.repo.rsplit('/').next().unwrap_or(&s.repo);
    let num = match &s.number {
        Some(serde_json::Value::Null) | None => String::new(),
        Some(serde_json::Value::String(n)) => format!(" #{n}"),
        Some(n) => format!(" #{n}"),
    };
    match &s.title {
        Some(t) => format!("{repo}{num} \u{b7} {t}"),
        None => format!("{repo}{num}"),
    }
}

fn is_own(url: &Url, port: u16) -> bool {
    match url.scheme() {
        "about" | "blob" => true,
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")) && url.port() == Some(port),
        _ => false,
    }
}

// Links out of the review (GitHub, CI) belong in the browser, not in the review's tab.
fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
    }
}

/// Shows the review's tab, creating it if needed; `focus` also brings the app to the front.
fn open_review(app: &AppHandle, label: &str, s: &Session, focus: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_window(label) {
        bring_forward(w);
        return Ok(());
    }
    let w = WindowBuilder::new(app, label)
        .title(title(s))
        .inner_size(1440.0, 900.0)
        .tabbing_identifier("reviewroom")
        .visible(false)
        .build()?;
    // AppKit joins it to the other review windows when it is shown, whatever "Prefer tabs" says
    // (its default, full screen only, would open a separate window).
    if let Some(win) = ns_window(&w) {
        win.setTabbingMode(NSWindowTabbingMode::Preferred);
    }
    attach(&w, s)?;
    app.state::<State>().idle.lock().unwrap().insert(label.to_string(), Instant::now());
    after_event(move || {
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
        }
    });
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

fn attach(w: &Window, s: &Session) -> tauri::Result<()> {
    let Ok(url) = s.url.parse::<Url>() else { return Ok(()) };
    let port = s.port;
    let n = PAGES.fetch_add(1, Ordering::Relaxed);
    let b = WebviewBuilder::new(format!("{}-page-{n}", w.label()), WebviewUrl::External(url))
        .auto_resize()
        .on_navigation(move |u| is_own(u, port) || (open_external(u), false).1)
        .on_new_window(|u, _| {
            open_external(&u);
            NewWindowResponse::Deny
        });
    let p = w.add_child(b, PhysicalPosition::new(0, 0), w.inner_size()?)?;
    let zoom = w.app_handle().state::<State>().zoom.lock().unwrap().get(w.label()).copied();
    if let Some(z) = zoom {
        p.set_zoom(z)?;
    }
    Ok(())
}

/// The Dock icon and File > Reopen Closed Reviews: every running review meant for the app gets its tab back.
fn reopen_closed(app: &AppHandle) {
    let sessions = app.state::<State>().sessions.lock().unwrap().clone();
    for (label, s) in sessions.iter().filter(|(l, s)| s.open.as_deref() == Some("app") && app.get_window(l).is_none()) {
        let _ = open_review(app, label, s, true);
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


/// Opens a tab for each new review that asked for the app (unless turned off in Settings), closes it once its
/// server is gone, and keeps the Reviews menu in step.
fn follow(app: AppHandle) {
    let mut missing: HashMap<String, Instant> = HashMap::new();
    let mut startup = true; // reviews already running at launch get their tabs without taking focus
    loop {
        let mut live: Vec<_> = read_sessions().into_iter().collect();
        live.sort_by_key(|(_, s)| s.port);
        let st = app.state::<State>();
        let settings = *st.settings.lock().unwrap();
        for (label, s) in &live {
            missing.remove(label);
            // restarted with --browser: the review now belongs in the browser, which opens once this tab is gone
            if s.open.as_deref() == Some("browser") {
                if let Some(w) = app.get_window(label) {
                    let _ = w.close();
                }
            }
            let new = st.opened.lock().unwrap().insert(s.pid);
            if new && settings.auto_open && s.open.as_deref() == Some("app") && app.get_window(label).is_none() {
                let (app2, label, s) = (app.clone(), label.clone(), s.clone());
                let _ = app.run_on_main_thread(move || {
                    if let Err(e) = open_review(&app2, &label, &s, settings.focus_new && !startup) {
                        eprintln!("reviewroom: could not open {}: {e}", s.url);
                    }
                });
            }
        }
        // grace period: a new round restarts the server on the same port
        for (label, w) in app.windows() {
            if live.iter().any(|(l, _)| *l == label) {
                continue;
            }
            if missing.entry(label.clone()).or_insert_with(Instant::now).elapsed() > Duration::from_secs(5) {
                let _ = w.close();
                missing.remove(&label);
            }
        }
        if settings.unload_idle {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || unload_idle(&app2));
        }
        let changed = *st.sessions.lock().unwrap() != live;
        if changed {
            *st.sessions.lock().unwrap() = live;
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || menu::refresh(&app2));
        }
        startup = false;
        // shortcut: polls the sessions folder each second; switch to a file watcher if it ever shows up in Activity Monitor
        thread::sleep(Duration::from_secs(1));
    }
}

fn main() {
    tauri::Builder::default()
        .manage(State::default())
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<State>().settings.lock().unwrap() = load_settings(&handle);
            menu::install(&handle)?;
            thread::spawn(move || follow(handle));
            Ok(())
        })
        .on_menu_event(menu::handle)
        .on_window_event(|w, e| {
            let st = w.app_handle().state::<State>();
            match e {
                WindowEvent::Focused(true) => {
                    *st.current.lock().unwrap() = Some(w.label().to_string());
                    wake(w.app_handle(), w.label());
                }
                WindowEvent::Focused(false) => {
                    st.idle.lock().unwrap().insert(w.label().to_string(), Instant::now());
                }
                _ => {}
            }
            if matches!(e, WindowEvent::Focused(_) | WindowEvent::Destroyed) {
                // queued: a destroyed window leaves the app's list after its event
                let app = w.app_handle().clone();
                let _ = w.app_handle().run_on_main_thread(move || menu::refresh(&app));
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Reviewroom")
        .run(|app, event| match event {
            // stay in the Dock with no reviews open: the next review opens a window
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Reopen { has_visible_windows: false, .. } => reopen_closed(app),
            _ => {}
        });
}
