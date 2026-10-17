// The menu bar. Reviews lists every running review (also those started with --browser or --no-open) with
// Cmd-1..9, then the settings; shortcuts the review page itself uses (Cmd-K, Shift-Cmd-O/P/F, Option-1..9) stay free.
use tauri::{
    menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager, Url, Window,
};

use crate::{bring_forward, open_external, open_review, page, reopen_closed, save_settings, title, State};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let sep = || PredefinedMenuItem::separator(app);
    let item = |id: &str, text: &str, keys: &str| MenuItem::with_id(app, id, text, true, Some(keys));
    let app_menu = Submenu::with_items(
        app,
        "Reviewroom",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Reviewroom"), None)?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &item("reopen", "Reopen Closed Reviews", "CmdOrCtrl+Shift+T")?,
            &sep()?,
            &item("browser", "Open in Browser", "CmdOrCtrl+Shift+B")?,
            &item("github", "Open on GitHub", "CmdOrCtrl+Shift+G")?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, Some("Close Tab"))?,
        ],
    )?;
    // without these, Cmd-C / Cmd-V do nothing in the page
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &item("reload", "Reload", "CmdOrCtrl+R")?,
            &sep()?,
            &item("zoom_in", "Zoom In", "CmdOrCtrl+Equal")?,
            &item("zoom_out", "Zoom Out", "CmdOrCtrl+Minus")?,
            &item("zoom_reset", "Actual Size", "CmdOrCtrl+0")?,
            &sep()?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    let reviews = Submenu::with_id(app, "reviews", "Reviews", true)?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &file, &edit, &view, &reviews, &window])?)?;
    window.set_as_windows_menu_for_nsapp()?; // macOS adds its tab items (Show Next Tab, Merge All Windows, ...)
    *app.state::<State>().reviews_menu.lock().unwrap() = Some(reviews);
    refresh(app);
    Ok(())
}

// The review tab last focused: menu commands act on it, even while another app is in front.
fn current(app: &AppHandle) -> Option<Window> {
    let label = app.state::<State>().current.lock().unwrap().clone()?;
    app.get_window(&label)
}

/// Rebuilds the Reviews menu from the running reviews; the shown tab gets the check mark. Main thread only.
pub fn refresh(app: &AppHandle) {
    let Some(menu) = app.state::<State>().reviews_menu.lock().unwrap().clone() else { return };
    if let Err(e) = fill(app, &menu) {
        eprintln!("reviewroom: Reviews menu: {e}");
    }
}

fn fill(app: &AppHandle, menu: &Submenu<tauri::Wry>) -> tauri::Result<()> {
    let sessions = app.state::<State>().sessions.lock().unwrap().clone();
    let settings = *app.state::<State>().settings.lock().unwrap();
    let shown = current(app).map(|w| w.label().to_string());
    for it in menu.items()? {
        menu.remove(&it)?;
    }
    if sessions.is_empty() {
        menu.append(&MenuItem::new(app, "No Running Reviews", false, None::<&str>)?)?;
    }
    for (i, (label, s)) in sessions.iter().enumerate() {
        let text = match app.get_window(label) {
            Some(_) => title(s),
            None => format!("{} (not open)", title(s)),
        };
        let keys = (i < 9).then(|| format!("CmdOrCtrl+{}", i + 1));
        let on = shown.as_deref() == Some(label.as_str());
        menu.append(&CheckMenuItem::with_id(app, format!("review:{label}"), text, true, on, keys.as_deref())?)?;
    }
    menu.append_items(&[
        &PredefinedMenuItem::separator(app)?,
        &MenuItem::with_id(app, "next", "Next Review", true, Some("CmdOrCtrl+Shift+BracketRight"))?,
        &MenuItem::with_id(app, "prev", "Previous Review", true, Some("CmdOrCtrl+Shift+BracketLeft"))?,
        &PredefinedMenuItem::separator(app)?,
        &CheckMenuItem::with_id(app, "set:auto_open", "Open New Reviews Automatically", true, settings.auto_open, None::<&str>)?,
        &CheckMenuItem::with_id(app, "set:focus_new", "Bring Reviewroom to the Front for New Reviews", true, settings.focus_new, None::<&str>)?,
        &CheckMenuItem::with_id(app, "set:unload_idle", "Unload Background Tabs After 10 Minutes", true, settings.unload_idle, None::<&str>)?,
    ])
}

pub fn handle(app: &AppHandle, e: MenuEvent) {
    let st = app.state::<State>();
    let id = e.id().as_ref();
    let session = |label: &str| st.sessions.lock().unwrap().iter().find(|(l, _)| l == label).map(|(_, s)| s.clone());
    let cur = current(app);
    match id {
        "reopen" => reopen_closed(app),
        "browser" | "github" => {
            let s = cur.as_ref().and_then(|w| session(w.label()));
            let url = s.and_then(|s| if id == "browser" { Some(s.url) } else { s.pr_url });
            if let Some(u) = url.and_then(|u| u.parse::<Url>().ok()) {
                open_external(&u);
            }
        }
        "reload" => {
            if let Some(p) = cur.and_then(|w| page(app, w.label())) {
                let _ = p.reload();
            }
        }
        "zoom_in" | "zoom_out" | "zoom_reset" => {
            if let Some(w) = cur {
                let f = {
                    let mut z = st.zoom.lock().unwrap();
                    let f = z.entry(w.label().to_string()).or_insert(1.0);
                    *f = match id {
                        "zoom_in" => (*f + 0.1).min(3.0),
                        "zoom_out" => (*f - 0.1).max(0.5),
                        _ => 1.0,
                    };
                    *f
                };
                if let Some(p) = page(app, w.label()) {
                    let _ = p.set_zoom(f);
                }
            }
        }
        "next" | "prev" => {
            let labels: Vec<String> = st.sessions.lock().unwrap().iter().map(|(l, _)| l.clone()).collect();
            let open: Vec<Window> = labels.iter().filter_map(|l| app.get_window(l)).collect();
            if !open.is_empty() {
                let n = open.len();
                let j = match cur.and_then(|c| open.iter().position(|w| w.label() == c.label())) {
                    Some(i) if id == "next" => (i + 1) % n,
                    Some(i) => (i + n - 1) % n,
                    None => 0,
                };
                bring_forward(open[j].clone());
            }
        }
        "set:auto_open" | "set:focus_new" | "set:unload_idle" => {
            let s = {
                let mut s = st.settings.lock().unwrap();
                match id {
                    "set:auto_open" => s.auto_open = !s.auto_open,
                    "set:focus_new" => s.focus_new = !s.focus_new,
                    _ => s.unload_idle = !s.unload_idle,
                }
                *s
            };
            save_settings(app, &s);
        }
        _ => {
            if let Some(label) = id.strip_prefix("review:") {
                if let Some(s) = session(label) {
                    let _ = open_review(app, label, &s, true);
                }
                refresh(app); // the click toggled its check mark
            }
        }
    }
}
