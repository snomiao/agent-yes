mod cli;
mod config;
mod config_loader;
mod context;
mod idle_waiter;
mod logger;
mod messaging;
mod pty_spawner;
mod ready_manager;
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
