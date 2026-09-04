# Kernel Resource Limits that Break Agent Launches

> Agent: `ay <cli> …` 在非 TTY 环境或高并发场景下启动失败，通常与内核资源池有关。
> This doc covers the common kernel-level ceilings and how to diagnose/raise them.

---

## 1. Overview: the two failure modes

| Symptom                                       | Actual cause                                               | Errno                                  | Fix                                                               |
| --------------------------------------------- | ---------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `openpty failed: out of pty devices` (Python) | **Sandbox blocks `/dev/ptmx`** (EPERM), NOT pty exhaustion | `errno=1 Operation not permitted`      | Escalate sandbox: `danger-full-access` or remove Seatbelt profile |
| `openpty failed: …` (real exhaustion)         | Actual pty count exceeds `kern.tty.ptmx_max`               | `errno=34 Result too large` / `ENOSPC` | Raise `ptmx_max` or kill idle agents                              |
| `forkpty failed` (C/rs)                       | Same — sandbox (EPERM) or pool exhaustion (ENOSPC)         | EPERM vs ENOSPC                        | Diagnose with `posix_openpt()` test, then appropriate fix         |

**Key diagnostic**: run `open("/dev/ptmx", O_RDWR)` from a C test binary; if it returns
**EPERM**, it's the sandbox. If it returns **ENOSPC**, it's actual pty depletion.

---

## 2. Pseudo-Terminals (pty)

### 2.1 What they are and why agent-yes needs them

Every `ay <cli>` spawns the target CLI under a **pseudoterminal pair**
(master + slave). The master end is opened via `open("/dev/ptmx")` (or the
`posix_openpt(3)` wrapper). The slave end appears as `/dev/ttysXXX` on macOS
or `/dev/pts/N` on Linux.

Each agent's stdin/stdout/stderr attach to the slave end via the master fd;
this is why `ay status` can read the agent's screen and why the agent thinks
it's talking to a real terminal even in headless/CI contexts.

### 2.2 macOS

**Limit variable**: `kern.tty.ptmx_max` (compile-time constant in xnu,
default 511).

**Is it adjustable?** **Yes** — but with constraints:

```bash
# Check current
sysctl kern.tty.ptmx_max    # default: 511

# Raise (requires root; immediate, no reboot)
sudo sysctl -w kern.tty.ptmx_max=999

# macOS Sequoia (Darwin 24.x) hard cap: values >= ~1023 return EINVAL.
# Try 999 first; if rejected, fall back to 512.

# Persist across reboots
echo 'kern.tty.ptmx_max=999' | sudo tee -a /etc/sysctl.conf
```

**Sandbox caveat**: on macOS, agent-yes may run under a **Seatbelt sandbox**
that blocks `open("/dev/ptmx")` with `EPERM` (Operation not permitted),
_regardless_ of whether the pty pool has free slots. The sandbox policy must
explicitly allow `/dev/ptmx` access (`(allow sysctl-read kern.tty.ptmx_max)` +
`(allow file-read* file-write* (char-device "/dev/ptmx"))`). See §4 below.

**Diagnosis**:

```bash
# Count active pty opens
lsof /dev/ptmx | tail -n +2 | wc -l

# Count /dev/ttys* slave nodes
ls -1 /dev/ttys* | wc -l

# Direct test (bypasses Python's misleading error label)
echo '#include <fcntl.h>
#include <stdio.h>
#include <errno.h>
int main(){
  int fd = open("/dev/ptmx", O_RDWR|O_NOCTTY);
  printf("fd=%d errno=%d (%s)\n", fd, errno, strerror(errno));
  return 0;
}' | cc -xc -o /tmp/openptmx - && /tmp/openptmx
```

### 2.3 Linux

**Limit variable**: `/proc/sys/kernel/pty/max`

```bash
# Current
cat /proc/sys/kernel/pty/max    # default: 4096 (modern kernels)

# Raise (immediate, no reboot)
echo 8192 | sudo tee /proc/sys/kernel/pty/max

# Persist
echo 'kernel.pty.max = 8192' | sudo tee -a /etc/sysctl.conf
```

Linux 5.4+ dynamically allocates pty slots (it doesn't pre-create device
nodes up to the limit), so the ceiling is much less likely to be hit than on
macOS. The real limit on Linux is usually **open file descriptors**
(`ulimit -n`) rather than the pty pool itself.

### 2.4 FreeBSD

```bash
sysctl kern.tty.ptmx_max          # check
sudo sysctl kern.tty.ptmx_max=512 # raise
```

---

## 3. Other kernel resource pools that matter for agent-yes

### 3.1 File descriptors

**macOS**:

```bash
kern.maxfiles: 276480         # system-wide
kern.maxfilesperproc: 138240  # per-process
ulimit -n: unlimited          # soft limit (may be lower)
```

**Linux**:

```bash
ulimit -n                    # soft limit (often 1024)
ulimit -n 65536              # raise (session only)
# /etc/security/limits.conf  # persist
```

**Why it matters**: each agent opens log files, fifo pipes, pty fds, and the
CLI's own files. With 86 agents, total fd consumption can easily hit the
per-process soft limit.

### 3.2 Process count

**macOS**:

```bash
kern.maxproc: 9000            # system-wide ceiling
kern.maxprocperuid: 6000      # per-user ceiling
ulimit -u: 6000               # soft limit
```

**Linux**:

```bash
ulimit -u                    # per-user (often 4096 or "unlimited")
# /etc/security/limits.conf  # nproc
```

**Why it matters**: each `ay <cli>` spawns the CLI binary as a child process,
plus agent-yes's own Rust/TS launcher and the reaper daemon. On a busy
development box with tmux/SSH/AI agents all running, the per-user process
limit can be unexpectedly tight.

### 3.3 SysV semaphores (shared by PostgreSQL, Python, some CLIs)

```bash
ipcs -s                      # list active semaphore sets
kern.sysv.semmni: 87381      # macOS: max semaphore sets (generous)
```

Rarely a bottleneck, but visible in `ipcs` when a zombie CLI leaves stale
semaphore sets behind.

### 3.4 Shared memory

```bash
kern.sysv.shmmni: 32         # macOS: max segments (small; mostly legacy)
kern.sysv.shmall: 1024       # max total pages
```

Not typically hit by agents (shared memory is mostly shm_open in newer
software, bypassing these limits).

---

## 4. The sandbox: not a kernel pool, but indistinguishable in error messages

Both the DSH file sandbox and macOS Seatbelt can deny `open("/dev/ptmx")`
with `EPERM`. When the sandbox is active, every new agent launch fails with
`Operation not permitted`, and the pool diagnostics (ptmx_max, lsof counts)
look fine. This is the #1 cause of agent launch failure in sandboxed
environments.

**Check**: run a C test binary that `open("/dev/ptmx")`s — if errno is
`EPERM` and `/dev/ptmx` is world-writable (`crw-rw-rw-`), it's the sandbox,
not exhaustion.

**Fix**: escalate to `danger-full-access` or remove the Seatbelt profile.
The DSH sandbox must explicitly allow the `char-device /dev/ptmx` path in its
policy.

---

## 5. Quick diagnostic script

```bash
#!/bin/bash
echo "=== MAC ==="
echo "pty ceiling:       $(sysctl -n kern.tty.ptmx_max 2>/dev/null || echo N/A)"
echo "pty active (lsof): $(lsof /dev/ptmx 2>/dev/null | tail -n +2 | wc -l)"
echo "ttys* nodes:       $(ls -1 /dev/ttys* 2>/dev/null | wc -l)"
echo "maxfiles:          $(sysctl -n kern.maxfiles 2>/dev/null || echo N/A)"
echo "maxproc:           $(sysctl -n kern.maxproc 2>/dev/null || echo N/A)"
echo "sandbox test:      $(/tmp/openptmx 2>&1 || echo 'sandbox-denied')"
echo
echo "=== LINUX ==="
echo "pty max:           $(cat /proc/sys/kernel/pty/max 2>/dev/null || echo N/A)"
echo "open files (soft): $(ulimit -n)"
echo "open files (hard): $(ulimit -Hn)"
echo "user processes:    $(ulimit -u)"
```

---

## References

- [Fix 'Please free up some pty devices' on macOS — Rodrigue Tusse](https://www.rodrigue.xyz/please-free-up-some-pty-devices-on-macos/)
- [How to Increase the macOS Terminal Device Limit — Mike Bianco](https://mikebian.co/how-to-increase-the-macos-terminal-device-limit/)
- xnu source: `bsd/kern/tty_ptm.c` — `KERN_TTY_PTMX_MAX`
- Linux: `Documentation/admin-guide/sysctl/kernel.rst` — `pty.max`
