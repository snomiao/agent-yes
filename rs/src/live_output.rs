//! Best-effort cross-process fast path for live PTY output.
//!
//! Agent wrappers append to their durable raw log and then publish the same
//! chunk over a local Unix datagram socket. `ayrs serve` uses the datagrams for
//! live subscribers; the log remains the source for initial replay and recovery.
#![allow(dead_code)] // each binary uses one half (publisher vs subscriber)

#[cfg(unix)]
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::net::UnixDatagram as StdUnixDatagram;
#[cfg(unix)]
use std::path::PathBuf;
#[cfg(unix)]
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug)]
pub struct LiveChunk {
    pub end_offset: u64,
    pub data: Vec<u8>,
}

fn decode_frame(frame: &[u8]) -> Option<(u32, LiveChunk)> {
    if frame.len() < 12 {
        return None;
    }
    let pid = u32::from_be_bytes(frame[0..4].try_into().ok()?);
    let end_offset = u64::from_be_bytes(frame[4..12].try_into().ok()?);
    Some((
        pid,
        LiveChunk {
            end_offset,
            data: frame[12..].to_vec(),
        },
    ))
}

#[cfg(unix)]
fn socket_path() -> Option<PathBuf> {
    crate::log_files::global_dir().map(|p| p.join("live-output.sock"))
}

/// Publish after the matching bytes have been appended to the raw log.
/// Missing/restarting serve daemons are deliberately ignored.
#[cfg(unix)]
pub fn publish(pid: u32, end_offset: u64, data: &[u8]) {
    let Some(path) = socket_path() else { return };
    static SOCK: OnceLock<Option<StdUnixDatagram>> = OnceLock::new();
    let Some(sock) = SOCK.get_or_init(|| StdUnixDatagram::unbound().ok()) else {
        return;
    };
    // Stay below conservative BSD Unix-datagram limits. Each frame carries its
    // exact durable-log end offset, so subscribers can de-duplicate a snapshot.
    const PAYLOAD: usize = 1400;
    let start_offset = end_offset.saturating_sub(data.len() as u64);
    for (i, part) in data.chunks(PAYLOAD).enumerate() {
        let part_end = start_offset + (i * PAYLOAD + part.len()) as u64;
        let mut frame = Vec::with_capacity(12 + part.len());
        frame.extend_from_slice(&pid.to_be_bytes());
        frame.extend_from_slice(&part_end.to_be_bytes());
        frame.extend_from_slice(part);
        let _ = sock.send_to(&frame, &path);
    }
}

#[cfg(not(unix))]
pub fn publish(_pid: u32, _end_offset: u64, _data: &[u8]) {}

#[cfg(unix)]
type Hub = Mutex<HashMap<u32, tokio::sync::broadcast::Sender<LiveChunk>>>;

#[cfg(unix)]
fn hub() -> &'static Hub {
    static HUB: OnceLock<Hub> = OnceLock::new();
    HUB.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(unix)]
fn sender(pid: u32) -> tokio::sync::broadcast::Sender<LiveChunk> {
    let mut h = hub().lock().expect("live output hub poisoned");
    h.entry(pid)
        .or_insert_with(|| tokio::sync::broadcast::channel(256).0)
        .clone()
}

/// Start the daemon-side socket once and subscribe to one agent's output.
#[cfg(unix)]
pub fn subscribe(pid: u32) -> tokio::sync::broadcast::Receiver<LiveChunk> {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        let Some(path) = socket_path() else { return };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::remove_file(&path);
        let Ok(sock) = StdUnixDatagram::bind(&path) else {
            return;
        };
        let _ = sock.set_nonblocking(true);
        let Ok(sock) = tokio::net::UnixDatagram::from_std(sock) else {
            return;
        };
        tokio::spawn(async move {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let Ok(n) = sock.recv(&mut buf).await else {
                    break;
                };
                let Some((pid, chunk)) = decode_frame(&buf[..n]) else {
                    continue;
                };
                let _ = sender(pid).send(chunk);
            }
        });
    });
    sender(pid).subscribe()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip() {
        let mut frame = Vec::new();
        frame.extend_from_slice(&42u32.to_be_bytes());
        frame.extend_from_slice(&1234u64.to_be_bytes());
        frame.extend_from_slice(b"hello");
        let (pid, chunk) = decode_frame(&frame).unwrap();
        assert_eq!(pid, 42);
        assert_eq!(chunk.end_offset, 1234);
        assert_eq!(chunk.data, b"hello");
        assert!(decode_frame(&frame[..11]).is_none());
    }
}
