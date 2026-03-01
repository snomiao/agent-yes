mod cli;
mod config;
mod config_loader;
mod context;
mod idle_waiter;
mod logger;
mod messaging;
mod pty_spawner;
mod ready_manager;
mod swarm;
mod utils;

use anyhow::Result;
use cli::CliArgs;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    // Parse CLI arguments
    let args = cli::parse_args()?;

    // Initialize logging
    logger::init(args.verbose);

    info!("agent-yes v{}", env!("CARGO_PKG_VERSION"));

    // Check for swarm mode (new --swarm flag or deprecated --experimental-swarm)
    if args.swarm.is_some() {
        #[cfg(feature = "swarm")]
        {
            let exit_code = run_swarm_mode(args).await?;
            std::process::exit(exit_code);
        }

        #[cfg(not(feature = "swarm"))]
        {
            swarm::swarm_not_available();
            std::process::exit(1);
        }
    }

    // Run the agent
    let exit_code = run_agent(args).await?;

    std::process::exit(exit_code);
}

async fn run_agent(args: CliArgs) -> Result<i32> {
    use crate::config::get_cli_config;
    use crate::context::AgentContext;
    use crate::messaging::send_message;
    use crate::pty_spawner::spawn_agent;

    let cli_config = get_cli_config(&args.cli)?;

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

    // Add default args
    cmd_args.extend(cli_config.default_args.iter().cloned());

    // Add restore args if continuing
    if args.continue_session {
        cmd_args.extend(cli_config.restore_args.iter().cloned());
    }

    loop {
        // Spawn the agent process
        let mut ctx = spawn_agent(&args.cli, &cmd_args, &cli_config, args.verbose).await?;

        // Create context
        let mut agent_ctx = AgentContext::new(
            args.cli.clone(),
            cli_config.clone(),
            args.verbose,
            args.robust,
            args.auto_yes,
        );

        // Run the main loop
        let exit_code = agent_ctx.run(&mut ctx, args.timeout_ms).await?;

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
async fn run_swarm_mode(args: CliArgs) -> Result<i32> {
    use crate::swarm::{SwarmConfig, SwarmNode, SwarmEvent2, SwarmCommand, SwarmUrlConfig, generate_room_code};
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

    let listen_addr = url_config.listen_addr
        .or(args.swarm_listen)
        .unwrap_or_else(|| "/ip4/0.0.0.0/tcp/0".to_string());

    let config = SwarmConfig {
        listen_addr,
        topic: url_config.topic.clone(),
        bootstrap_peers: url_config.bootstrap_peers.clone(),
        cli: args.cli.clone(),
        cwd: std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
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
                            let _ = cmd_tx_clone.send(SwarmCommand::BroadcastTask { prompt }).await;
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
                        let _ = cmd_tx_clone.send(SwarmCommand::Chat { message: line.to_string() }).await;
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
                SwarmEvent2::Status { peer_count, is_coordinator, coordinator_id } => {
                    println!("\n[Status]");
                    println!("  Peers: {}", peer_count);
                    println!("  Coordinator: {}", if is_coordinator { "You" } else { coordinator_id.as_deref().unwrap_or("Unknown") });
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
