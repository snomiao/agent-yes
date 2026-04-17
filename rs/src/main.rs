mod cli;
mod codex_sessions;
mod config;
mod config_loader;
mod context;
mod idle_waiter;
mod log_files;
mod logger;
mod messaging;
mod pid_store;
mod pty_spawner;
mod ready_manager;
mod running_lock;
mod swarm;
mod utils;
mod vterm;
mod webhook;

use anyhow::Result;
use cli::CliArgs;
use tracing::info;

/// Detect how the Rust binary was installed.
/// Returns "cargo" for ~/.cargo/bin, "git" if running from a git repo target dir, or the path hint.
fn detect_install_method() -> &'static str {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return "unknown",
    };
    let exe_str = exe.to_string_lossy();

    if exe_str.contains(".cargo/bin") {
        return "cargo install";
    }
    if exe_str.contains("/target/release") || exe_str.contains("/target/debug") {
        return "cargo build (dev)";
    }
    if exe_str.contains("node_modules") {
        return "npm/bun";
    }
    "binary"
}

#[tokio::main]
async fn main() -> Result<()> {
    // Parse CLI arguments
    let args = cli::parse_args()?;

    // Initialize logging
    logger::init(args.verbose);

    let install_method = detect_install_method();
    info!(
        "agent-yes v{} ({})",
        env!("CARGO_PKG_VERSION"),
        install_method
    );

    // Capture current working directory early
    let cwd = std::env::current_dir()
        .map_err(|e| anyhow::anyhow!("Failed to get current working directory: {}", e))?
        .to_string_lossy()
        .to_string();

    // Check for swarm mode (new --swarm flag or deprecated --experimental-swarm)
    if args.swarm.is_some() {
        #[cfg(feature = "swarm")]
        {
            let exit_code = run_swarm_mode(args, &cwd).await?;
            std::process::exit(exit_code);
        }

        #[cfg(not(feature = "swarm"))]
        {
            swarm::swarm_not_available();
            std::process::exit(1);
        }
    }

    // Run the agent
    let exit_code = run_agent(args, &cwd).await?;

    std::process::exit(exit_code);
}

async fn run_agent(args: CliArgs, cwd: &str) -> Result<i32> {
    use crate::config::get_runtime_cli_config;
    use crate::context::AgentContext;
    use crate::pid_store::PidStore;
    use crate::pty_spawner::spawn_agent;

    let cli_config = get_runtime_cli_config(&args.cli)?;

    // Build command arguments
    let mut cmd_args = args.cli_args.clone();

    // Add prompt based on promptArg configuration
    if let Some(ref prompt) = args.prompt {
        match cli_config.prompt_arg.as_str() {
            "first-arg" => {
                cmd_args.insert(0, prompt.clone());
            }
            "last-arg" => {
                cmd_args.push(prompt.clone());
            }
            flag if flag.starts_with("--") || flag.starts_with("-") => {
                cmd_args.push(flag.to_string());
                cmd_args.push(prompt.clone());
            }
            _ => {}
        }
    }

    // Add --dangerously-skip-permissions if -y was passed
    if args.skip_permissions {
        cmd_args.push("--dangerously-skip-permissions".to_string());
    }

    // Add default args
    cmd_args.extend(cli_config.default_args.iter().cloned());

    // Codex session resume: look up stored session ID for this cwd
    if args.continue_session && args.cli == "codex" {
        if let Some(session_id) = codex_sessions::get_session(cwd) {
            info!("Resuming codex session: {}", session_id);
            cmd_args.push("--session".to_string());
            cmd_args.push(session_id);
        } else {
            cmd_args.extend(cli_config.restore_args.iter().cloned());
        }
    } else if args.continue_session {
        cmd_args.extend(cli_config.restore_args.iter().cloned());
    }

    // Acquire run lock if --queue
    let _lock = if args.queue {
        let lock = running_lock::RunningLock::new(cwd);
        lock.acquire(args.prompt.as_deref()).await?;
        Some(lock)
    } else {
        None
    };

    let pid = std::process::id();

    // Clean up stale PID records on startup
    let pid_store = PidStore::new();
    pid_store.clean_stale();

    loop {
        // Spawn the agent process
        let mut ctx = spawn_agent(&args.cli, &cmd_args, &cli_config, cwd, args.verbose).await?;

        // Create agent context (also initialises log file)
        let (term_cols, term_rows) = crate::pty_spawner::get_terminal_size();
        let mut agent_ctx = AgentContext::new(
            args.cli.clone(),
            cli_config.clone(),
            args.verbose,
            args.robust,
            args.auto_yes,
            cwd.to_string(),
            pid,
            term_rows,
            term_cols,
        );

        // Register in PID store and send RUNNING webhook
        let log_file = agent_ctx.raw_log_path();
        pid_store.register(
            pid,
            &args.cli,
            args.prompt.as_deref(),
            cwd,
            log_file.as_deref(),
        );
        webhook::notify("RUNNING", args.prompt.as_deref().unwrap_or(""), cwd);

        // Run the main loop
        let exit_code = agent_ctx
            .run(&mut ctx, args.timeout_ms, args.idle_action.as_deref())
            .await?;

        // Update PID store and send EXIT webhook
        let exit_reason = if agent_ctx.is_user_abort {
            "user_abort"
        } else if agent_ctx.is_fatal {
            "fatal"
        } else if exit_code == 0 {
            "completed"
        } else {
            "crashed"
        };
        pid_store.update_status(pid, "exited", Some(exit_code), Some(exit_reason));
        webhook::notify(
            "EXIT",
            &format!("{} exitCode={}", exit_reason, exit_code),
            cwd,
        );

        // Handle restart-without-continue (e.g., "No conversation found to continue")
        // Must be checked before normal crash restart to avoid re-adding --continue
        if agent_ctx.should_restart_without_continue {
            info!("Restarting without continue args...");
            // Remove restore args (--continue, --resume) from cmd_args
            cmd_args.retain(|a| !cli_config.restore_args.contains(a));
            continue;
        }

        // Check if we should restart
        if args.robust && exit_code != 0 && !agent_ctx.is_fatal && !agent_ctx.is_user_abort {
            info!("Agent crashed with code {}, restarting...", exit_code);
            // Add restore args for next iteration
            if !cmd_args.iter().any(|a| cli_config.restore_args.contains(a)) {
                cmd_args.extend(cli_config.restore_args.iter().cloned());
            }
            continue;
        }

        return Ok(exit_code);
    }
}

/// Run in swarm mode - P2P agent networking
#[cfg(feature = "swarm")]
async fn run_swarm_mode(args: CliArgs, cwd: &str) -> Result<i32> {
    use crate::swarm::{
        generate_room_code, SwarmCommand, SwarmConfig, SwarmEvent2, SwarmNode, SwarmUrlConfig,
    };
    use tokio::sync::mpsc;
    use tracing::{info, warn};

    // Parse swarm value using new URL parser
    let swarm_value = args.swarm.as_deref();
    let mut url_config = SwarmUrlConfig::parse(swarm_value);

    // Merge deprecated flags (for backwards compatibility)
    if !args.swarm_bootstrap.is_empty() && url_config.bootstrap_peers.is_empty() {
        url_config.bootstrap_peers = args.swarm_bootstrap.clone();
    }
    if args.swarm_topic != "agent-yes-swarm" && url_config.topic == "agent-yes-swarm" {
        url_config.topic = args.swarm_topic.clone();
    }

    // Generate room code for this session
    let room_code = generate_room_code();

    info!("Starting swarm mode");
    info!("  Topic: {}", url_config.topic);
    info!("  Room Code: {}", room_code);
    if !url_config.bootstrap_peers.is_empty() {
        info!("  Bootstrap peers: {:?}", url_config.bootstrap_peers);
    }
    if let Some(ref code) = url_config.room_code {
        info!("  Resolving room code: {}", code);
    }

    let listen_addr = url_config
        .listen_addr
        .or(args.swarm_listen)
        .unwrap_or_else(|| "/ip4/0.0.0.0/tcp/0".to_string());

    let config = SwarmConfig {
        listen_addr,
        topic: url_config.topic.clone(),
        bootstrap_peers: url_config.bootstrap_peers.clone(),
        cli: args.cli.clone(),
        cwd: cwd.to_string(),
        room_code: Some(room_code.clone()),
        room_code_to_resolve: url_config.room_code.clone(),
    };

    let node = SwarmNode::new(config).await?;

    // Create channels for communication
    let (cmd_tx, cmd_rx) = mpsc::channel::<SwarmCommand>(100);
    let (event_tx, mut event_rx) = mpsc::channel::<SwarmEvent2>(100);

    // Spawn the swarm node
    let swarm_handle = tokio::spawn(async move {
        if let Err(e) = node.run(cmd_rx, event_tx).await {
            tracing::error!("Swarm error: {}", e);
        }
    });

    // Handle stdin for commands (only if we have a TTY)
    let cmd_tx_clone = cmd_tx.clone();
    let is_tty = std::io::IsTerminal::is_terminal(&std::io::stdin());

    let stdin_handle = tokio::spawn(async move {
        if !is_tty {
            // Not a TTY, just wait forever
            info!("Running in non-interactive mode (no TTY)");
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            }
        }

        use tokio::io::{AsyncBufReadExt, BufReader};
        let stdin = tokio::io::stdin();
        let mut reader = BufReader::new(stdin);
        let mut line = String::new();

        println!("\n[Swarm Mode Commands]");
        println!("  /task <prompt>  - Broadcast a task to the swarm");
        println!("  /chat <msg>     - Send a chat message");
        println!("  /status         - Get swarm status");
        println!("  /quit           - Exit swarm mode");
        println!("");

        loop {
            line.clear();
            print!("> ");
            use std::io::Write;
            std::io::stdout().flush().ok();

            match reader.read_line(&mut line).await {
                Ok(0) => break, // EOF
                Ok(_) => {
                    let line = line.trim();
                    if line.starts_with("/task") {
                        let prompt = line.strip_prefix("/task").unwrap_or("").trim().to_string();
                        if prompt.is_empty() {
                            println!("Usage: /task <prompt>");
                        } else {
                            let _ = cmd_tx_clone
                                .send(SwarmCommand::BroadcastTask { prompt })
                                .await;
                        }
                    } else if line.starts_with("/chat") {
                        let message = line.strip_prefix("/chat").unwrap_or("").trim().to_string();
                        if message.is_empty() {
                            println!("Usage: /chat <message>");
                        } else {
                            let _ = cmd_tx_clone.send(SwarmCommand::Chat { message }).await;
                        }
                    } else if line == "/status" || line == "/s" {
                        let _ = cmd_tx_clone.send(SwarmCommand::GetStatus).await;
                    } else if line == "/quit" || line == "/exit" || line == "/q" {
                        let _ = cmd_tx_clone.send(SwarmCommand::Shutdown).await;
                        break;
                    } else if line == "/help" || line == "/?" || line == "?" {
                        println!("\n[Swarm Mode Commands]");
                        println!("  /task <prompt>  - Broadcast a task to the swarm");
                        println!("  /chat <msg>     - Send a chat message");
                        println!("  /status         - Get swarm status");
                        println!("  /quit           - Exit swarm mode");
                    } else if !line.is_empty() && !line.starts_with("/") {
                        // Treat non-command input as chat
                        let _ = cmd_tx_clone
                            .send(SwarmCommand::Chat {
                                message: line.to_string(),
                            })
                            .await;
                    } else if !line.is_empty() {
                        println!("Unknown command: {}. Try /help", line);
                    }
                }
                Err(e) => {
                    warn!("Stdin error: {}", e);
                    break;
                }
            }
        }
    });

    // Handle events
    let event_handle = tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            match event {
                SwarmEvent2::PeerDiscovered { peer_id } => {
                    println!("\n[+] Peer discovered: {}", peer_id);
                }
                SwarmEvent2::PeerLeft { peer_id } => {
                    println!("\n[-] Peer left: {}", peer_id);
                }
                SwarmEvent2::TaskReceived { task_id, prompt } => {
                    println!("\n[Task] {}: {}", task_id, prompt);
                }
                SwarmEvent2::TaskUpdate { task_id, status } => {
                    println!("\n[Task Update] {}: {}", task_id, status);
                }
                SwarmEvent2::ChatReceived { agent_id, message } => {
                    println!("\n[{}] {}", agent_id, message);
                }
                SwarmEvent2::BecameCoordinator => {
                    println!("\n[*] You are now the coordinator!");
                }
                SwarmEvent2::NewCoordinator { coordinator_id } => {
                    println!("\n[*] New coordinator: {}", coordinator_id);
                }
                SwarmEvent2::Status {
                    peer_count,
                    is_coordinator,
                    coordinator_id,
                } => {
                    println!("\n[Status]");
                    println!("  Peers: {}", peer_count);
                    println!(
                        "  Coordinator: {}",
                        if is_coordinator {
                            "You"
                        } else {
                            coordinator_id.as_deref().unwrap_or("Unknown")
                        }
                    );
                }
            }
            print!("> ");
            use std::io::Write;
            std::io::stdout().flush().ok();
        }
    });

    // Wait for any task to complete
    tokio::select! {
        _ = swarm_handle => {
            info!("Swarm node stopped");
        }
        _ = stdin_handle => {
            info!("Stdin handler stopped");
        }
        _ = event_handle => {
            info!("Event handler stopped");
        }
        _ = tokio::signal::ctrl_c() => {
            info!("Received Ctrl+C, shutting down");
            let _ = cmd_tx.send(SwarmCommand::Shutdown).await;
        }
    }

    Ok(0)
}
