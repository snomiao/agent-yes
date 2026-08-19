//! Host memory + uptime for `GET /api/host`.
//!
//! The TS daemon answers this endpoint with Node's `os.totalmem()` /
//! `os.freemem()` / `os.uptime()`. The Rust daemon used to hard-code both to
//! `0`, so a console talking to a Rust host had no memory numbers to render at
//! all. This module supplies the real values with no extra crates — only
//! `libc` (unix) and `windows-sys` (windows), both already dependencies.
//!
//! # Why `available` is a NEW field instead of a redefined `free`
//!
//! `free` keeps Node's `os.freemem()` semantics so the two daemons stay
//! interchangeable for existing callers. On macOS libuv computes that as
//! `free_count * page_size` — strictly untouched pages, excluding the inactive
//! pages the kernel would hand out on demand. That number is far smaller than
//! what a user reads as "free" in Activity Monitor or glances: on a normally
//! loaded desktop the two routinely differ by an order of magnitude or more, so
//! a UI that shows only `free` reports a machine as nearly out of memory while
//! gigabytes are in fact reclaimable.
//!
//! `available` is therefore added alongside it, meaning "memory that can
//! actually be handed to a new allocation": `free_count + inactive_count` on
//! macOS, `MemAvailable` on Linux, `ullAvailPhys` on Windows. Old callers keep
//! reading `free` and see no change; new UI prefers `available`. Adding rather
//! than redefining is what keeps that backward compatibility.
//!
//! Everything degrades to `0` rather than panicking — `0` is exactly what the
//! endpoint reported before, so an unsupported platform is never worse off.

/// Physical memory snapshot, in bytes. `0` means "could not determine".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MemStats {
    /// Total physical RAM.
    pub total: u64,
    /// Node `os.freemem()` semantics — see the module docs.
    pub free: u64,
    /// Memory realistically available to new allocations — see the module docs.
    pub available: u64,
}

/// Parse the contents of Linux `/proc/meminfo`.
///
/// Kept `cfg`-free and pure (`&str` in, numbers out) so it can be unit-tested
/// with fixed sample text on every platform, not just on Linux.
///
/// Lines look like `MemTotal:       16316164 kB`; the unit column is always kB
/// for these three keys, hence the `* 1024`. Unknown/garbage lines are skipped.
/// Kernels older than 3.14 have no `MemAvailable`, in which case `free` is the
/// best estimate we have and is used verbatim.
pub fn parse_meminfo(text: &str) -> MemStats {
    let mut total = 0u64;
    let mut free = 0u64;
    let mut available: Option<u64> = None;
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(kb) = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u64>().ok())
        else {
            continue;
        };
        let bytes = kb.saturating_mul(1024);
        match key.trim() {
            "MemTotal" => total = bytes,
            "MemFree" => free = bytes,
            "MemAvailable" => available = Some(bytes),
            _ => {}
        }
    }
    MemStats {
        total,
        free,
        available: normalize_available(total, free, available.unwrap_or(free)),
    }
}

/// Clamp `available` into `[free, total]`.
///
/// `MemAvailable` is an estimate (`si_mem_available()` subtracts the page-cache
/// low watermark and reserved pages), so on a freshly booted box with a tiny
/// page cache the kernel can report it BELOW `MemFree`. Callers and tests rely
/// on the `free <= available <= total` invariant, so it is established here
/// constructively instead of being left to chance.
fn normalize_available(total: u64, free: u64, available: u64) -> u64 {
    let a = available.max(free);
    if total > 0 {
        a.min(total)
    } else {
        a
    }
}

/// Parse the contents of Linux `/proc/uptime` into whole seconds.
///
/// The file is `"<uptime-seconds> <idle-seconds>"`, both fractional; only the
/// first field is uptime. Pure + `cfg`-free for the same testability reason as
/// [`parse_meminfo`]. Unparseable input yields `0`.
pub fn parse_proc_uptime(text: &str) -> u64 {
    text.split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.0)
        .map(|v| v as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{normalize_available, MemStats};

    /// Read a `u64`-valued sysctl by name; `None` if the node is missing.
    fn sysctl_u64(name: &str) -> Option<u64> {
        let cname = std::ffi::CString::new(name).ok()?;
        let mut out: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let rc = unsafe {
            libc::sysctlbyname(
                cname.as_ptr(),
                &mut out as *mut u64 as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc == 0 {
            Some(out)
        } else {
            None
        }
    }

    pub fn mem_stats() -> MemStats {
        let total = sysctl_u64("hw.memsize").unwrap_or(0);

        // `mach_host_self` is deprecated in the `libc` crate (it suggests the
        // `mach2` crate), but libuv itself calls exactly this pair of functions
        // for `uv_get_free_memory`, and pulling in another crate just for one
        // symbol is not worth it. The port returned here is the host self port,
        // which is not owned by the caller, so there is nothing to deallocate.
        #[allow(deprecated)]
        let host = unsafe { libc::mach_host_self() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let mut st: libc::vm_statistics64 = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::host_statistics64(
                host,
                libc::HOST_VM_INFO64,
                &mut st as *mut libc::vm_statistics64 as *mut libc::integer_t,
                &mut count,
            )
        };
        if rc != libc::KERN_SUCCESS {
            return MemStats {
                total,
                free: 0,
                available: 0,
            };
        }
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64;
        // free_count / inactive_count are natural_t (u32) page counts.
        let free = (st.free_count as u64).saturating_mul(page);
        let available =
            ((st.free_count as u64).saturating_add(st.inactive_count as u64)).saturating_mul(page);
        MemStats {
            total,
            free,
            available: normalize_available(total, free, available),
        }
    }

    pub fn uptime_secs() -> u64 {
        // `kern.boottime` yields a struct timeval of the wall-clock instant the
        // kernel booted; uptime is now - boottime.
        let cname = match std::ffi::CString::new("kern.boottime") {
            Ok(c) => c,
            Err(_) => return 0,
        };
        let mut bt: libc::timeval = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::timeval>();
        let rc = unsafe {
            libc::sysctlbyname(
                cname.as_ptr(),
                &mut bt as *mut libc::timeval as *mut libc::c_void,
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || bt.tv_sec <= 0 {
            return 0;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // saturating: a clock stepped backwards must not underflow to ~u64::MAX.
        now.saturating_sub(bt.tv_sec as u64)
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::MemStats;

    pub fn mem_stats() -> MemStats {
        std::fs::read_to_string("/proc/meminfo")
            .map(|t| super::parse_meminfo(&t))
            .unwrap_or_default()
    }

    pub fn uptime_secs() -> u64 {
        std::fs::read_to_string("/proc/uptime")
            .map(|t| super::parse_proc_uptime(&t))
            .unwrap_or(0)
    }
}

#[cfg(windows)]
mod imp {
    use super::MemStats;
    use windows_sys::Win32::System::SystemInformation::{
        GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };

    pub fn mem_stats() -> MemStats {
        let mut s: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        s.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        if unsafe { GlobalMemoryStatusEx(&mut s) } == 0 {
            return MemStats::default();
        }
        // Windows exposes a single "available physical memory" number and draws
        // no distinction between strictly-free pages and reclaimable ones, so
        // `free` and `available` are necessarily the same value here. That is
        // also what Node reports for `os.freemem()` on Windows, which keeps the
        // two daemons consistent.
        MemStats {
            total: s.ullTotalPhys,
            free: s.ullAvailPhys,
            available: s.ullAvailPhys,
        }
    }

    pub fn uptime_secs() -> u64 {
        unsafe { GetTickCount64() / 1000 }
    }
}

// Any other platform: report zeros, which is exactly what this endpoint did
// before this module existed.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
mod imp {
    use super::MemStats;

    pub fn mem_stats() -> MemStats {
        MemStats::default()
    }

    pub fn uptime_secs() -> u64 {
        0
    }
}

/// Physical memory snapshot for this machine, in bytes.
pub fn mem_stats() -> MemStats {
    imp::mem_stats()
}

/// Seconds since this machine booted; `0` when unavailable.
pub fn uptime_secs() -> u64 {
    imp::uptime_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    // /proc/meminfo parsing is exercised on EVERY platform (the parser is
    // deliberately cfg-free) with synthetic fixture text.
    #[test]
    fn parse_meminfo_reads_all_three_keys() {
        let sample = "\
MemTotal:       16316164 kB
MemFree:          194560 kB
MemAvailable:    4404224 kB
Buffers:          102400 kB
Cached:          8192000 kB
SwapTotal:             0 kB
";
        let m = parse_meminfo(sample);
        assert_eq!(m.total, 16316164 * 1024);
        assert_eq!(m.free, 194560 * 1024);
        assert_eq!(m.available, 4404224 * 1024);
        // The gap `available` exists to expose: free is a small fraction of it.
        assert!(m.available > m.free * 10);
    }

    #[test]
    fn parse_meminfo_without_memavailable_falls_back_to_free() {
        // Kernels older than 3.14 have no MemAvailable line.
        let sample = "MemTotal: 1024 kB\nMemFree: 256 kB\n";
        let m = parse_meminfo(sample);
        assert_eq!(m.total, 1024 * 1024);
        assert_eq!(m.free, 256 * 1024);
        assert_eq!(m.available, 256 * 1024);
    }

    #[test]
    fn parse_meminfo_clamps_available_into_free_total_range() {
        // MemAvailable is an estimate and can legitimately sit below MemFree.
        let below = parse_meminfo("MemTotal: 1000 kB\nMemFree: 400 kB\nMemAvailable: 100 kB\n");
        assert_eq!(below.available, 400 * 1024);
        // ...and must never exceed MemTotal.
        let above = parse_meminfo("MemTotal: 1000 kB\nMemFree: 400 kB\nMemAvailable: 9999 kB\n");
        assert_eq!(above.available, 1000 * 1024);
    }

    #[test]
    fn parse_meminfo_ignores_garbage() {
        let m = parse_meminfo("not a meminfo line\nMemTotal: abc kB\n\n:::\nMemFree: 8 kB\n");
        assert_eq!(m.total, 0);
        assert_eq!(m.free, 8 * 1024);
        assert_eq!(m.available, 8 * 1024);
        // Empty input must yield zeros, never a panic.
        assert_eq!(parse_meminfo(""), MemStats::default());
    }

    #[test]
    fn parse_proc_uptime_takes_first_field() {
        assert_eq!(parse_proc_uptime("350735.47 234388.90\n"), 350735);
        assert_eq!(parse_proc_uptime("12 34"), 12);
        assert_eq!(parse_proc_uptime(""), 0);
        assert_eq!(parse_proc_uptime("garbage\n"), 0);
        assert_eq!(parse_proc_uptime("-5.0 1.0"), 0);
    }

    // Live invariants, asserted only on platforms that have a real
    // implementation — an unimplemented platform must not silently "pass".
    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn live_mem_stats_are_real_and_ordered() {
        let m = mem_stats();
        assert!(m.total > 0, "total memory should be known: {m:?}");
        assert!(
            m.free <= m.available,
            "free must not exceed available: {m:?}"
        );
        assert!(m.available <= m.total, "available must fit in total: {m:?}");
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn live_uptime_is_positive() {
        assert!(uptime_secs() > 0, "machine has been up for some time");
    }
}
