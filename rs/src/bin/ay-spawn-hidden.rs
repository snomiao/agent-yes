//! ay-spawn-hidden — a transparent, window-less process launcher for Windows.
//!
//! ## Why this exists
//!
//! On Windows, a process manager (oxmgr / pm2 / a Task-Scheduler-launched daemon)
//! running in the interactive desktop session spawns each managed program with a
//! freshly-allocated console. For console-subsystem programs (`bash.exe`,
//! `agent-yes.exe`, …) that console is a **visible window that grabs focus** —
//! and crash-looping managed processes flash one window per restart. `oxmgr`
//! exposes no `windowsHide`/`--no-window` flag, so we interpose this launcher.
//!
//! ## How it avoids the flash
//!
//! This binary is compiled for the **Windows GUI subsystem**
//! (`#![windows_subsystem = "windows"]`), so when the manager spawns *it*, the OS
//! allocates **no console at all** — nothing to flash. It then starts the real
//! child with `CREATE_NO_WINDOW` so the child gets no console window either. The
//! child still runs in the interactive session, so any *GUI* windows the agent
//! opens appear normally — only the console window is suppressed.
//!
//! ## Why it's a faithful shim (lifetime correctness)
//!
//! A process manager tracks the launcher's PID for stop/restart/health, so the
//! launcher must live exactly as long as the child — no shorter, no longer:
//!
//!   * It `WaitForSingleObject`s the child and exits with the child's **exact
//!     exit code**, so it never returns early (which would make the manager think
//!     the process died and restart-loop) and never outlives the child (which
//!     would make the manager believe a dead service is still healthy).
//!   * The child is placed in a **Job Object with `KILL_ON_JOB_CLOSE`** before it
//!     runs. The launcher holds the only job handle, so if the manager force-kills
//!     the launcher, the OS tears the job down and **kills the child too** — no
//!     orphans survive a `stop`/`restart`.
//!   * It forwards the manager's inherited **stdio handles** (oxmgr redirects
//!     these to its per-process log files) to the child, so logging is unchanged.
//!
//! Usage: `ay-spawn-hidden <program> [args...]`

// GUI subsystem on Windows → no console is ever allocated for this process.
#![cfg_attr(windows, windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    std::process::exit(windows_impl::run());
}

#[cfg(not(windows))]
fn main() {
    // This launcher only has a purpose on Windows. Elsewhere, behave as a
    // transparent exec-style passthrough would be ideal, but to keep the binary
    // dependency-free on Unix we simply refuse rather than silently differ.
    eprintln!("ay-spawn-hidden is a Windows-only launcher");
    std::process::exit(1);
}

#[cfg(windows)]
mod windows_impl {
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, WAIT_FAILED};
    use windows_sys::Win32::System::Console::{
        GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, INFINITE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
    };

    /// Build a UTF-16, NUL-terminated buffer for the Win32 `*W` APIs.
    fn to_wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Quote one argument per the `CommandLineToArgvW` rules so the child parses
    /// argv exactly as we intend. `force` always wraps in quotes (used for the
    /// program token, which may be a bare name searched on PATH or a path with
    /// spaces). Mirrors Microsoft's "everyone quotes command line arguments the
    /// wrong way" canonical algorithm.
    fn argv_quote(arg: &str, force: bool) -> String {
        let needs = force
            || arg.is_empty()
            || arg
                .chars()
                .any(|c| c == ' ' || c == '\t' || c == '\n' || c == '\u{b}' || c == '"');
        if !needs {
            return arg.to_string();
        }
        let mut out = String::with_capacity(arg.len() + 2);
        out.push('"');
        let chars: Vec<char> = arg.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let mut backslashes = 0;
            while i < chars.len() && chars[i] == '\\' {
                backslashes += 1;
                i += 1;
            }
            if i == chars.len() {
                // Escape trailing backslashes so they don't escape the closing quote.
                for _ in 0..backslashes * 2 {
                    out.push('\\');
                }
            } else if chars[i] == '"' {
                // Escape all backslashes and the embedded quote.
                for _ in 0..backslashes * 2 + 1 {
                    out.push('\\');
                }
                out.push('"');
                i += 1;
            } else {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                out.push(chars[i]);
                i += 1;
            }
        }
        out.push('"');
        out
    }

    /// `true` if a std handle is something we can meaningfully hand to the child.
    fn handle_usable(h: HANDLE) -> bool {
        // GetStdHandle returns 0 (no handle) or INVALID_HANDLE_VALUE (-1) when the
        // stream isn't set up. windows-sys models HANDLE as a pointer.
        !h.is_null() && h as isize != -1
    }

    pub fn run() -> i32 {
        // args[0] = this exe; args[1] = program; args[2..] = its arguments.
        let args: Vec<String> = std::env::args().collect();
        if args.len() < 2 {
            eprintln!("usage: ay-spawn-hidden <program> [args...]");
            return 2;
        }

        // Normalize the program token's slashes (CreateProcessW dislikes '/'),
        // then build a properly-quoted command line. lpApplicationName stays NULL
        // so a bare program name (e.g. `bash`) is still resolved via PATH.
        let program = args[1].replace('/', "\\");
        let mut cmdline = argv_quote(&program, true);
        for a in &args[2..] {
            cmdline.push(' ');
            cmdline.push_str(&argv_quote(a, false));
        }
        let mut cmdline_w = to_wide(&cmdline);

        unsafe {
            // 1) Job object with kill-on-close: tearing down the launcher (even via
            //    TerminateProcess from the manager) takes the child with it.
            let job = CreateJobObjectW(ptr::null(), ptr::null());
            if job.is_null() {
                eprintln!("CreateJobObjectW failed: {}", GetLastError());
                return 3;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                eprintln!("SetInformationJobObject failed: {}", GetLastError());
                return 3;
            }

            // 2) Forward the manager's stdio (oxmgr points these at its log files).
            let h_in = GetStdHandle(STD_INPUT_HANDLE);
            let h_out = GetStdHandle(STD_OUTPUT_HANDLE);
            let h_err = GetStdHandle(STD_ERROR_HANDLE);

            let mut si: STARTUPINFOW = std::mem::zeroed();
            si.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            // Only claim USESTDHANDLES when at least one output stream is real,
            // otherwise an all-invalid set would break the child's stdio.
            let inherit = handle_usable(h_out) || handle_usable(h_err) || handle_usable(h_in);
            if inherit {
                si.dwFlags |= STARTF_USESTDHANDLES;
                si.hStdInput = h_in;
                si.hStdOutput = h_out;
                si.hStdError = h_err;
            }

            // 3) Create the child SUSPENDED + windowless, so we can place it in the
            //    job before it can run or spawn anything that escapes the job.
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let ok = CreateProcessW(
                ptr::null(),
                cmdline_w.as_mut_ptr(),
                ptr::null(),
                ptr::null(),
                /* bInheritHandles */ if inherit { 1 } else { 0 },
                CREATE_NO_WINDOW | CREATE_SUSPENDED,
                ptr::null(),
                ptr::null(),
                &si,
                &mut pi,
            );
            if ok == 0 {
                eprintln!("CreateProcessW failed ({}): {}", GetLastError(), cmdline);
                return 3;
            }

            if AssignProcessToJobObject(job, pi.hProcess) == 0 {
                // Don't leak a running-but-unmanaged child: kill it and fail.
                let err = GetLastError();
                windows_sys::Win32::System::Threading::TerminateProcess(pi.hProcess, 1);
                eprintln!("AssignProcessToJobObject failed: {}", err);
                return 3;
            }

            // 4) Let it run, then mirror its lifetime exactly.
            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            if WaitForSingleObject(pi.hProcess, INFINITE) == WAIT_FAILED {
                eprintln!("WaitForSingleObject failed: {}", GetLastError());
                return 3;
            }

            let mut code: u32 = 0;
            let got = GetExitCodeProcess(pi.hProcess, &mut code);
            CloseHandle(pi.hProcess);
            // Keep `job` alive until here; dropping it now is fine since the child
            // has already exited. (Closing it earlier would kill a live child.)
            CloseHandle(job);

            if got == 0 {
                eprintln!("GetExitCodeProcess failed: {}", GetLastError());
                return 3;
            }
            code as i32
        }
    }
}
