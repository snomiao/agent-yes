//! agent-yes-tray — a small system-tray companion for agent-yes.
//!
//! v1 (Windows-first, cross-platform code): shows the agent-yes tray icon with a
//! menu to open the web console and quit. It talks to the rest of agent-yes only
//! through the `ay` CLI / the hosted console URL, so it stays a thin, dependency-
//! light client with no backend of its own.
//!
//! Compiled for the GUI subsystem on Windows (`windows_subsystem = "windows"`) so
//! it never owns a console window — consistent with `ay-spawn-hidden`.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem},
    TrayIconBuilder,
};

/// How often we re-confirm that `ay serve` is still installed while the tray runs.
const INSTALL_POLL: Duration = Duration::from_secs(30);
/// Cap on each `ay serve status` call so a wedged CLI can't hang the tray.
const STATUS_TIMEOUT: Duration = Duration::from_secs(4);
/// Longer cap for a start/stop action (oxmgr restart can take a few seconds).
const ACTION_TIMEOUT: Duration = Duration::from_secs(10);

/// The hosted console. Overridable via `AGENT_YES_CONSOLE_URL` so a self-hosted /
/// local (`http://localhost:PORT`) console works without a rebuild.
fn console_url() -> String {
    std::env::var("AGENT_YES_CONSOLE_URL").unwrap_or_else(|_| "https://agent-yes.com".to_string())
}

/// Run `ay <args>` window-less with a hard timeout so a wedged CLI can't hang the
/// tray. `None` on spawn error / timeout. std's `wait_with_output` has no timeout,
/// so we bound it on a helper thread.
fn run_ay(args: &[&str], timeout: Duration) -> Option<Output> {
    let mut cmd = Command::new("ay");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().ok()?;
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => Some(out),
        _ => None,
    }
}

/// Snapshot of `ay serve status --json`.
struct ServeState {
    /// `Some(true/false)` when the manager could be queried; `None` when unknown
    /// (CLI missing / slow / malformed). The tray is strict at startup (hide on
    /// anything but `Some(true)`) and lenient while running (only a definitive
    /// `Some(false)` tears it down).
    installed: Option<bool>,
    /// Whether the daemon PROCESS is online (manager-reported; the only up/down
    /// signal for a webrtc daemon, which opens no HTTP port).
    running: bool,
}

fn serve_status(timeout: Duration) -> ServeState {
    match run_ay(&["serve", "status", "--json"], timeout) {
        Some(out) => {
            let s = String::from_utf8_lossy(&out.stdout);
            let installed = if s.contains("\"installed\": true") {
                Some(true)
            } else if s.contains("\"installed\": false") {
                Some(false)
            } else {
                None
            };
            ServeState {
                installed,
                running: s.contains("\"running\": true"),
            }
        }
        None => ServeState {
            installed: None,
            running: false,
        },
    }
}

/// `~/.agent-yes` (or `$AGENT_YES_HOME`) — MUST match the TS `agentYesHome()` so
/// the hide marker is the same file the `ay tray` CLI writes.
fn agent_yes_home() -> PathBuf {
    if let Ok(h) = std::env::var("AGENT_YES_HOME") {
        return PathBuf::from(h);
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    PathBuf::from(home).join(".agent-yes")
}

/// Marker whose presence means the user hid the tray (via the menu or `ay tray
/// hide`); the tray refuses to show until it's cleared by `ay tray show`.
fn hidden_marker() -> PathBuf {
    agent_yes_home().join("tray.hidden")
}

fn is_hidden() -> bool {
    hidden_marker().exists()
}

fn set_hidden() {
    let p = hidden_marker();
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(p, "hidden from the tray menu\n");
}

/// Single context-item label: it shows serve's state AND is the toggle.
fn toggle_label(running: bool) -> &'static str {
    if running {
        "● serve: running — click to stop"
    } else {
        "○ serve: down — click to start"
    }
}

/// The agent-yes website brand mark as a 32×32 RGBA tray glyph: a dark rounded
/// square (#0d1117) with a green (#3fb950) checkmark — the SAME mark as
/// `lab/ui/icon.svg` (the /w/ console favicon + site icon), so the tray reads as
/// "agent-yes" at a glance. Drawn procedurally from the SVG's own coordinates
/// (512-viewBox, scaled to 32) so the crate still carries no binary asset and
/// needs no SVG/PNG-decoding dependency.
fn make_icon() -> tray_icon::Icon {
    const S: i32 = 32;
    let sf = S as f32;
    let mut rgba = vec![0u8; (S * S * 4) as usize];

    // Geometry lifted from lab/ui/icon.svg (viewBox 0 0 512 512), scaled to S.
    let scale = sf / 512.0;
    let radius = 104.0 * scale; // rect rx
    let half = sf / 2.0;
    // Checkmark polyline "M132 268 l78 80 l170 -186" → three absolute points.
    let p0 = (132.0 * scale, 268.0 * scale);
    let p1 = (210.0 * scale, 348.0 * scale); // 132+78, 268+80
    let p2 = (380.0 * scale, 162.0 * scale); // 210+170, 348-186
    let hs = 56.0 * scale / 2.0; // half of stroke-width 56

    let bg = (13.0_f32, 17.0, 23.0); // #0d1117
    let fg = (63.0_f32, 185.0, 80.0); // #3fb950

    // Distance from point p to segment a→b.
    fn seg_dist(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (cx, cy) = (ax + t * dx, ay + t * dy);
        ((px - cx).powi(2) + (py - cy).powi(2)).sqrt()
    }
    let lerp = |a: f32, b: f32, t: f32| (a + (b - a) * t).round().clamp(0.0, 255.0) as u8;

    for y in 0..S {
        for x in 0..S {
            let idx = ((y * S + x) * 4) as usize;
            let fx = x as f32 + 0.5; // pixel center
            let fy = y as f32 + 0.5;

            // Rounded-rect signed distance (<=0 inside), with a 1px AA band.
            let dx = (fx - half).abs() - (half - radius);
            let dy = (fy - half).abs() - (half - radius);
            let outside = dx.max(0.0).hypot(dy.max(0.0));
            let inside = dx.max(dy).min(0.0);
            let rect_d = outside + inside - radius;
            let bg_cov = (0.5 - rect_d).clamp(0.0, 1.0);
            if bg_cov <= 0.0 {
                continue; // transparent outside the square
            }

            // Checkmark coverage: distance to the nearer of the two segments.
            let d = seg_dist(fx, fy, p0.0, p0.1, p1.0, p1.1)
                .min(seg_dist(fx, fy, p1.0, p1.1, p2.0, p2.1));
            let check = (hs + 0.5 - d).clamp(0.0, 1.0);

            // Green check composited over the dark square; edge alpha = bg_cov.
            rgba[idx] = lerp(bg.0, fg.0, check);
            rgba[idx + 1] = lerp(bg.1, fg.1, check);
            rgba[idx + 2] = lerp(bg.2, fg.2, check);
            rgba[idx + 3] = (bg_cov * 255.0).round() as u8;
        }
    }

    tray_icon::Icon::from_rgba(rgba, S as u32, S as u32).expect("valid tray icon rgba")
}

fn main() {
    // Gate: show ONLY when serve is installed AND the user hasn't hidden the tray.
    // Anything but a confirmed "installed" (or a present hide marker) → exit before
    // creating an icon, so a stale autostart or a manual launch shows nothing.
    if is_hidden() || serve_status(STATUS_TIMEOUT).installed != Some(true) {
        return;
    }

    let event_loop = EventLoopBuilder::new().build();

    // Menu (built before the tray on Windows). One context item doubles as the
    // serve status readout AND the start/stop toggle (req: single context item).
    let menu = Menu::new();
    let toggle_item = MenuItem::new(toggle_label(false), true, None);
    let open_item = MenuItem::new("Open agent-yes console", true, None);
    let hide_item = MenuItem::new("Hide tray icon", true, None);
    let quit_item = MenuItem::new("Quit", true, None);
    menu.append_items(&[
        &toggle_item,
        &PredefinedMenuItem::separator(),
        &open_item,
        &PredefinedMenuItem::separator(),
        &hide_item,
        &quit_item,
    ])
    .expect("build tray menu");

    let toggle_id = toggle_item.id().clone();
    let open_id = open_item.id().clone();
    let hide_id = hide_item.id().clone();
    let quit_id = quit_item.id().clone();
    let menu_rx = MenuEvent::receiver();

    // Seed the toggle with the real state.
    let mut running = serve_status(STATUS_TIMEOUT).running;
    toggle_item.set_text(toggle_label(running));

    // The tray icon is created lazily inside the loop: some platforms require an
    // active event loop before the tray/menu can attach to the OS.
    let mut tray = None;

    event_loop.run(move |event, _target, control_flow| {
        // Wake at least every INSTALL_POLL to refresh status + re-check the gates.
        *control_flow = ControlFlow::WaitUntil(Instant::now() + INSTALL_POLL);

        if tray.is_none() {
            tray = Some(
                TrayIconBuilder::new()
                    .with_menu(Box::new(menu.clone()))
                    .with_tooltip("agent-yes")
                    .with_icon(make_icon())
                    .build()
                    .expect("build tray icon"),
            );
        }

        // Periodic refresh: update the toggle, and tear the tray down if serve got
        // uninstalled or the user hid it from elsewhere (`ay tray hide`).
        if let Event::NewEvents(StartCause::ResumeTimeReached { .. }) = event {
            if is_hidden() {
                *control_flow = ControlFlow::Exit;
                return;
            }
            let st = serve_status(STATUS_TIMEOUT);
            if st.installed == Some(false) {
                *control_flow = ControlFlow::Exit;
                return;
            }
            running = st.running;
            toggle_item.set_text(toggle_label(running));
        }

        // Menu clicks (delivered on muda's global channel).
        while let Ok(ev) = menu_rx.try_recv() {
            if ev.id == toggle_id {
                // Start when down / stop when up, then re-read the real state.
                let action = if running { "stop" } else { "start" };
                let _ = run_ay(&["serve", action], ACTION_TIMEOUT);
                running = serve_status(STATUS_TIMEOUT).running;
                toggle_item.set_text(toggle_label(running));
            } else if ev.id == open_id {
                let _ = open::that(console_url());
            } else if ev.id == hide_id {
                set_hidden();
                *control_flow = ControlFlow::Exit;
            } else if ev.id == quit_id {
                *control_flow = ControlFlow::Exit;
            }
        }
    });
}
