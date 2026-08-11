// `ayrs` — standalone pure-Rust ay-serve daemon (experimental). Currently
// implements `ayrs serve --webrtc`: host a browser-console share room over
// WebRTC with no Bun/Node process involved. Coexists with the TS `ay serve`
// (separate room persisted in ~/.agent-yes/.share-room-ayrs).
#![allow(dead_code)]

#[path = "../agent_permissions.rs"]
mod agent_permissions;
#[path = "../pid_store.rs"]
mod pid_store;
// needs_input classification reuses the CLI `needsInput`/`working` patterns
// that ship embedded in default.config.yaml, so the Rust daemon's dot matches
// `ay ls` exactly instead of re-deriving its own heuristics.
#[path = "../config_loader.rs"]
mod config_loader;
#[path = "../fifo.rs"]
mod fifo;
#[path = "../log_files.rs"]
mod log_files;
#[path = "../serve/mod.rs"]
mod serve;
#[path = "../vterm.rs"]
mod vterm;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "ayrs",
    version,
    about = "agent-yes Rust serve daemon (experimental)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve local agents to the browser console
    Serve {
        /// Host a WebRTC share room (webrtc://room:e1.<hex>@sighost to pin an
        /// explicit room; omit the value to load/mint the persisted one)
        #[arg(long, num_args = 0..=1, default_missing_value = "")]
        webrtc: Option<String>,
        /// Signaling host when minting a room
        #[arg(long, default_value = serve::share::DEFAULT_SIGHOST)]
        sighost: String,

        /// Also (or instead) serve the console over a local HTTP port.
        /// 0 picks a free port. Loopback only.
        #[arg(long)]
        port: Option<u16>,

        /// Install/uninstall/inspect the daemon as a native OS service
        /// (launchd on macOS, systemd --user on Linux) instead of running it
        /// in the foreground.
        #[command(subcommand)]
        action: Option<ServeAction>,
    },
}

#[derive(Subcommand)]
enum ServeAction {
    /// Register `ayrs serve --webrtc` with the OS supervisor and start it
    Install,
    /// Stop and deregister the service
    Uninstall,
    /// Bounce the installed service (picks up a rebuilt binary; keeps the unit,
    /// the room and boot-autostart exactly as they are)
    Restart,
    /// Show whether the service is installed and running
    Status,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve {
            webrtc,
            sighost,
            action,
            port,
        } => {
            match action {
                // Service management never needs a room up front: the unit
                // re-runs `ayrs serve --webrtc` which loads/mints as usual.
                Some(ServeAction::Install) => return serve::service::install(&webrtc, &sighost),
                Some(ServeAction::Uninstall) => return serve::service::uninstall(),
                Some(ServeAction::Restart) => return serve::service::restart(),
                Some(ServeAction::Status) => return serve::service::status(),
                None => {}
            }
            // Recover the login-shell env in the background now, so the first
            // /api/spawn doesn't pay the shell's rc-file startup cost (see
            // serve/shell_env.rs — launchd hands us a bare PATH).
            serve::shell_env::warm();

            // --port and --webrtc are independent transports over the SAME API
            // surface; running both is the normal local+remote setup.
            let http = port.map(|p| tokio::spawn(serve::http::run(p)));
            match webrtc {
                Some(webrtc) => {
                    // Record what we're running so a later `ayrs serve install`
                    // can detect it's already current and skip a needless
                    // restart. Only the WebRTC path writes it — that's the shape
                    // the installed service unit runs, so the args match exactly
                    // what `install` recomputes for the same webrtc/sighost.
                    serve::service::write_run_receipt(&serve::service::service_args(
                        &Some(webrtc.clone()),
                        &sighost,
                    ));
                    let url = if webrtc.is_empty() {
                        None
                    } else {
                        Some(webrtc)
                    };
                    serve::share::run_share(serve::share::ShareConfig { url, sighost }).await
                }
                None => match http {
                    Some(h) => h.await?,
                    None => anyhow::bail!("ayrs serve needs --webrtc and/or --port"),
                },
            }
        }
    }
}
