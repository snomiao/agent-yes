//! `kill <pid>` on an interactive run must end it like Ctrl-C does: exit 143,
//! terminal restored. Run it under a real pty, because the point is the tty
//! mode left behind — the bun launcher that used to catch SIGTERM now execs
//! into this binary and is gone.
#![cfg(unix)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::Read;
use std::time::{Duration, Instant};

#[test]
fn sigterm_exits_143_and_restores_the_terminal() {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_agent-yes"));
    cmd.args(["bash", "--norc", "--noprofile"]);
    cmd.env("HOME", home.path());
    cmd.env("AGENT_YES_ATTACH", "1");
    cmd.env_remove("AGENT_YES_PID");
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    drop(pair.slave);

    // Wait for the shell prompt: the run loop is up and the tty is raw.
    let mut reader = pair.master.try_clone_reader().unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let mut seen = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    while !String::from_utf8_lossy(&seen).contains("$ ") && Instant::now() < deadline {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
            seen.extend(chunk);
        }
    }
    assert!(
        String::from_utf8_lossy(&seen).contains("$ "),
        "no prompt: {}",
        String::from_utf8_lossy(&seen)
    );

    unsafe { libc::kill(child.process_id().unwrap() as i32, libc::SIGTERM) };

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(
            Instant::now() < deadline,
            "still running 10 s after SIGTERM"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(status.exit_code(), 143);

    let fd = pair.master.as_raw_fd().expect("master fd");
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::tcgetattr(fd, &mut t) }, 0);
    let cooked = libc::ICANON | libc::ECHO;
    assert_eq!(
        t.c_lflag & cooked,
        cooked,
        "terminal left raw: lflag {:#x}",
        t.c_lflag
    );
}
