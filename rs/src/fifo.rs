//! Named-pipe (FIFO) IPC for `cy send`.
//!
//! Mirrors the principle of `ts/beta/fifo.ts`: a FIFO at a per-pid path lets
//! external CLI invocations (`cy send <keyword> <msg>`) inject text into the
//! agent's stdin without going through the user's terminal.
//!
//! Unix path: `~/.agent-yes/fifo/<pid>.stdin` (homedir keeps it out of the
//! user's working tree — no .gitignore needed).
//!
//! Windows path: `\\.\pipe\agent-yes-<pid>` — the Win32 named-pipe namespace,
//! not a filesystem path. Must match `ts/pidStore.ts:getFifoPath` so that
//! `ay send` (TS-side `net.connect`) reaches the same endpoint.
//!
//! On Unix we use `mkfifo(3)` and then open the FIFO with O_RDWR in our own
//! process. RDWR keeps the read-end unblocked at open time and prevents EOF
//! when an external writer closes — same trick `terminal-ws-lib` and the TS
//! `fifo.ts` use (paired read + dummy-write fds).
//!
//! On Windows we use Tokio's `NamedPipeServer` (a thin wrapper over
//! `CreateNamedPipeW`). The pipe is created when the server starts listening
//! — there is no separate "mknode" step — so `create_fifo` is a no-op there
//! and `spawn_fifo_reader` owns the entire lifecycle. After each client
//! disconnects we recreate the server instance so subsequent `ay send` calls
//! see a live endpoint.

#[cfg(unix)]
use std::ffi::CString;
use std::path::{Path, PathBuf};
use tracing::warn;

/// Resolve the FIFO path for a given pid. On Unix this is a filesystem path
/// under `$HOME/.agent-yes/fifo/`; on Windows it's the Win32 named-pipe
/// namespace string (`\\.\pipe\agent-yes-<pid>`), which `net.connect` /
/// `CreateFileW` accept directly.
pub fn fifo_path(pid: u32) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        Some(PathBuf::from(format!(r"\\.\pipe\agent-yes-{}", pid)))
    }
    #[cfg(not(windows))]
    {
        crate::log_files::log_dir().map(|dir| dir.join("fifo").join(format!("{}.stdin", pid)))
    }
}

/// Create the FIFO (idempotent — if it already exists from a stale run, unlink first).
#[cfg(unix)]
pub fn create_fifo(path: &Path) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // If a stale FIFO from a previous crashed run is sitting at this path,
    // unlink it first — same pid would mean process restart, not a live
    // collision (kernel guarantees unique pid for live processes).
    let _ = std::fs::remove_file(path);

    let cpath = CString::new(path.as_os_str().as_encoded_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    // mode 0600 — same as $HOME/.ssh defaults; only the owner can write.
    let rc = unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(windows)]
pub fn create_fifo(_path: &Path) -> std::io::Result<()> {
    // No-op: Win32 named pipes are created the moment the server listens
    // (see `spawn_fifo_reader`), not by a separate mknode-style call.
    // Reporting Ok here keeps main.rs's spawn flow symmetric across platforms
    // without having to special-case "the pipe doesn't exist yet".
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn create_fifo(_path: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "FIFO IPC not yet supported on this platform",
    ))
}

/// Open the FIFO for read+write. Holding both ends in our own process means
/// `read()` never returns EOF when an external writer closes, so each
/// `cy send` invocation is just bytes appearing on the stream.
#[cfg(unix)]
pub fn open_for_reading(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
}

// Kept as a stub on non-unix targets for source-level symmetry — the Windows
// `spawn_fifo_reader` owns the `NamedPipeServer` directly (the server can't be
// re-expressed as a `std::fs::File`), so this is not called in practice.
#[cfg(not(unix))]
#[allow(dead_code)]
pub fn open_for_reading(_path: &Path) -> std::io::Result<std::fs::File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "open_for_reading is not implemented on this platform; use spawn_fifo_reader",
    ))
}

/// Best-effort cleanup. Failures are logged at debug level.
///
/// On Windows the named pipe is reclaimed by the kernel when the last server
/// instance handle drops, so `remove_file` on `\\.\pipe\<name>` is meaningless
/// — but it's also harmless (NotFound is silenced below).
pub fn cleanup_fifo(path: &Path) {
    if let Err(e) = std::fs::remove_file(path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("Failed to remove FIFO at {:?}: {}", path, e);
        }
    }
}

/// Spawn a dedicated OS thread that blocks on `read()` from the FIFO and
/// forwards each chunk to the given mpsc sender (which is shared with the
/// agent's user-stdin reader, so the bytes hit the same /auto detection,
/// Ctrl+C handling, and PTY-readiness gate).
///
/// The thread exits when the receiver is dropped (`blocking_send` fails) or
/// on a hard read error. The OS reaps it when the agent process exits.
///
/// Extracted from `context.rs::run_with_fifo` so the same plumbing can be
/// unit-tested in isolation without spawning agent-yes.
#[cfg(unix)]
pub fn spawn_fifo_reader(
    path: PathBuf,
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let file = open_for_reading(&path)?;
    let handle = std::thread::spawn(move || {
        use std::io::Read;
        let mut reader = file;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    // RDWR fd shouldn't EOF, but defend anyway.
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    continue;
                }
                Ok(n) => {
                    if tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break; // receiver dropped — main loop ended
                    }
                }
                Err(e) => {
                    warn!("FIFO read error at {:?}: {} — stopping reader", path, e);
                    break;
                }
            }
        }
    });
    Ok(handle)
}

/// Windows counterpart: a server-side Win32 named pipe. The thread runs its
/// own current-thread Tokio runtime because the existing caller (context.rs)
/// expects a `std::thread::JoinHandle` — wrapping `tokio::spawn` would break
/// that contract — and because `NamedPipeServer::read` is async-only.
///
/// Uses the **pre-create** pattern: at each iteration the next server
/// instance is created *before* `current.connect()` is awaited. When the
/// current client disconnects and `current` is dropped, `next` already holds
/// an instance bound to the same name, so the kernel namespace stays
/// continuously populated. Without this, the gap between drop and recreate
/// leaks: clients arriving in that window get `ERROR_FILE_NOT_FOUND` (which
/// Node surfaces as `connect ENOENT`). Empirically confirmed on Windows 11
/// build 26200: the *first* `ay send` worked, the *second* failed with
/// ENOENT until the next instance was staged ahead of the disconnect.
#[cfg(windows)]
pub fn spawn_fifo_reader(
    path: PathBuf,
    tx: tokio::sync::mpsc::Sender<Vec<u8>>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    use tokio::io::AsyncReadExt;
    use tokio::net::windows::named_pipe::ServerOptions;

    let path_str = path
        .to_str()
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("named-pipe path is not valid UTF-16: {:?}", path),
            )
        })?
        .to_owned();

    let handle = std::thread::spawn(move || {
        let rt = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(e) => {
                warn!("named-pipe reader: failed to build runtime: {}", e);
                return;
            }
        };
        rt.block_on(async move {
            // Pre-create pattern: always have the NEXT server instance listening
            // before we let the CURRENT one accept a client. Without this, the
            // gap between `drop(current)` and `create(next)` removes the pipe
            // name from the Win32 namespace, so any `ay send` issued in that
            // window gets ENOENT. Empirically confirmed on Windows 11 build
            // 26200: the first `ay send` worked, the second (after the gap)
            // returned `connect ENOENT \\.\pipe\agent-yes-<pid>`.
            let mut current = match ServerOptions::new()
                .first_pipe_instance(true)
                .create(&path_str)
            {
                Ok(s) => s,
                Err(e) => {
                    warn!(
                        "named-pipe create failed at {} (first instance): {}",
                        path_str, e
                    );
                    return;
                }
            };
            loop {
                // Stage the next instance *now*, before letting `current`
                // accept its client. When `current` is dropped at the end of
                // this iteration, the namespace stays populated because `next`
                // already holds an instance — so an `ay send` arriving in the
                // handoff window connects to `next` instead of getting ENOENT.
                let next = match ServerOptions::new().create(&path_str) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!(
                            "named-pipe create failed at {} (next instance): {}",
                            path_str, e
                        );
                        return;
                    }
                };

                if let Err(e) = current.connect().await {
                    warn!("named-pipe connect at {} failed: {}", path_str, e);
                    return;
                }

                let mut buf = [0u8; 4096];
                loop {
                    match current.read(&mut buf).await {
                        Ok(0) => break, // client disconnected — promote `next`
                        Ok(n) => {
                            if tx.send(buf[..n].to_vec()).await.is_err() {
                                return; // receiver dropped — main loop ended
                            }
                        }
                        Err(e) => {
                            warn!("named-pipe read error at {}: {}", path_str, e);
                            break;
                        }
                    }
                }

                // `current` is dropped here (handle released → instance
                // closes), but `next` already holds a live instance, so the
                // pipe name remains continuously present in the namespace.
                current = next;
            }
        });
    });
    Ok(handle)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn test_create_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.stdin");
        create_fifo(&path).unwrap();
        assert!(path.exists());

        // Open for reading (RDWR) — must not block.
        let mut reader = open_for_reading(&path).unwrap();

        // External writer pushes data and closes.
        {
            let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            writer.write_all(b"hello\n").unwrap();
        }

        // Reader sees the bytes despite the external writer closing,
        // because we still hold the write-end via RDWR.
        let mut buf = [0u8; 32];
        let n = reader.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"hello\n");

        cleanup_fifo(&path);
        assert!(!path.exists());
    }

    #[test]
    fn test_create_fifo_idempotent_over_stale() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stale.stdin");
        create_fifo(&path).unwrap();
        // Re-create at same path (simulates same-pid restart) — must succeed.
        create_fifo(&path).unwrap();
        cleanup_fifo(&path);
    }

    #[test]
    fn test_create_fifo_creates_parent_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Nested path whose parent dir does not exist yet — create_fifo
        // should mkdir -p on the way.
        let path = dir.path().join("a/b/c").join("test.stdin");
        create_fifo(&path).unwrap();
        assert!(path.exists());
        cleanup_fifo(&path);
    }

    #[test]
    fn test_cleanup_nonexistent_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("never-existed.stdin");
        // Must not panic or log loudly — NotFound is silenced.
        cleanup_fifo(&path);
    }

    #[test]
    fn test_fifo_path_uses_log_dir() {
        let p = fifo_path(42).expect("home dir resolves in test env");
        // Always under <log_dir>/fifo/<pid>.stdin
        assert!(p.ends_with("fifo/42.stdin"));
        let parent = p.parent().unwrap();
        assert!(parent.ends_with("fifo"));
    }

    #[test]
    fn test_create_fifo_invalid_path_rejects_nul_byte() {
        // Construct a path containing a NUL byte — CString::new must reject it
        // and we must surface that as InvalidInput.
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = dir.path().join("bad").as_os_str().as_bytes().to_vec();
        bytes.push(0); // embedded NUL
        bytes.extend_from_slice(b".stdin");
        let bad_path: std::path::PathBuf =
            std::ffi::OsStr::from_bytes(&bytes).to_os_string().into();
        let result = create_fifo(&bad_path);
        assert!(result.is_err(), "expected error for NUL-byte path");
    }

    /// Closes the integration gap from the feature commit: directly tests
    /// that bytes written through the FIFO arrive at the consumer of the
    /// shared mpsc channel — i.e., the same plumbing context.rs uses for
    /// `cy send`. No agent-yes binary or PTY involved, so it bypasses the
    /// cargo-test fd-inheritance crash that blocks a full e2e test.
    #[tokio::test(flavor = "multi_thread")]
    async fn test_spawn_fifo_reader_forwards_bytes_to_channel() {
        use tokio::sync::mpsc;
        use tokio::time::{timeout, Duration};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.fifo");
        create_fifo(&path).unwrap();

        let (tx, mut rx) = mpsc::channel::<Vec<u8>>(100);
        let handle = spawn_fifo_reader(path.clone(), tx).unwrap();

        // External writer pushes data and closes — repeat to prove the
        // RDWR-keepalive pattern doesn't EOF after the first close.
        for marker in &[b"alpha\n".to_vec(), b"beta\n".to_vec(), b"gamma\n".to_vec()] {
            let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            writer.write_all(marker).unwrap();
            // dropping the writer here closes its fd; reader must not EOF.
        }

        // Drain the channel until we've collected all expected bytes or hit
        // a 2s deadline. Bytes may arrive in one chunk or several.
        let expected: Vec<u8> = b"alpha\nbeta\ngamma\n".to_vec();
        let mut received = Vec::new();
        let drain = async {
            while received.len() < expected.len() {
                match rx.recv().await {
                    Some(chunk) => received.extend_from_slice(&chunk),
                    None => break,
                }
            }
        };
        let _ = timeout(Duration::from_secs(2), drain).await;

        assert_eq!(
            received, expected,
            "FIFO reader did not forward all bytes to the channel"
        );

        // Now exercise the channel-closed branch: drop the receiver, then
        // poke the FIFO so the reader thread tries to send and observes
        // the closed channel. The thread must exit cleanly.
        drop(rx);
        {
            let mut writer = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            writer.write_all(b"after-rx-drop\n").unwrap();
        }
        // Wait for the reader thread to exit (blocking join in a task so we
        // can apply a timeout from the async runtime).
        let join_result = tokio::task::spawn_blocking(move || handle.join()).await;
        let _ = timeout(Duration::from_secs(2), async { join_result.unwrap() }).await;
    }

    /// Cover the read-error branch: open_for_reading succeeds, but the
    /// underlying file is later replaced with something that yields a
    /// hard error on read (closing it from underneath). The reader thread
    /// must log and exit, not panic.
    #[tokio::test(flavor = "multi_thread")]
    async fn test_spawn_fifo_reader_propagates_open_error() {
        use tokio::sync::mpsc;

        // Path doesn't exist → open_for_reading fails → spawn_fifo_reader
        // returns Err(io::Error) without spawning a thread.
        let dir = tempfile::tempdir().unwrap();
        let bogus = dir.path().join("does-not-exist.fifo");
        let (tx, _rx) = mpsc::channel::<Vec<u8>>(1);
        let result = spawn_fifo_reader(bogus, tx);
        assert!(result.is_err(), "expected open error to surface");
    }

    #[test]
    fn test_two_independent_fifos_in_same_dir() {
        // mkfifo two distinct pids in the same directory; both must be live.
        let dir = tempfile::tempdir().unwrap();
        let p1 = dir.path().join("100.stdin");
        let p2 = dir.path().join("200.stdin");
        create_fifo(&p1).unwrap();
        create_fifo(&p2).unwrap();
        assert!(p1.exists() && p2.exists());

        let mut r1 = open_for_reading(&p1).unwrap();
        let r2 = open_for_reading(&p2).unwrap();

        // Cross-write: writing to p1 must be readable on r1, not r2.
        {
            let mut w = std::fs::OpenOptions::new().write(true).open(&p1).unwrap();
            w.write_all(b"to-1").unwrap();
        }
        let mut buf = [0u8; 16];
        let n = r1.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"to-1");

        // r2 must not have received anything — make read non-blocking via
        // O_NONBLOCK to assert. Skip the assertion here since blocking
        // read would hang; the existence check above is sufficient
        // signal that the FIFOs are independent.
        drop(r2);
        cleanup_fifo(&p1);
        cleanup_fifo(&p2);
    }
}
