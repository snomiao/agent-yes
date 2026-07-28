// `ayrs` — standalone pure-Rust ay-serve daemon (experimental). Currently
// implements `ayrs serve --webrtc`: host a browser-console share room over
// WebRTC with no Bun/Node process involved. Coexists with the TS `ay serve`
// (separate room persisted in ~/.agent-yes/.share-room-ayrs).
#![allow(dead_code)]

#[path = "../agent_permissions.rs"]
mod agent_permissions;
#[path = "../pid_store.rs"]
mod pid_store;
#[path = "../log_files.rs"]
mod log_files;
#[path = "../fifo.rs"]
mod fifo;
#[path = "../serve/mod.rs"]
mod serve;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "ayrs", version, about = "agent-yes Rust serve daemon (experimental)")]
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
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { webrtc, sighost } => {
            let Some(webrtc) = webrtc else {
                anyhow::bail!("ayrs serve currently requires --webrtc (HTTP mode still lives in `ay serve`)");
            };
            let url = if webrtc.is_empty() { None } else { Some(webrtc) };
            serve::share::run_share(serve::share::ShareConfig { url, sighost }).await
        }
    }
}
