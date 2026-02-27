//! Logging configuration module

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Initialize logging with optional verbose mode
pub fn init(verbose: bool) {
    let filter = if verbose || std::env::var("VERBOSE").is_ok() {
        "debug"
    } else {
        "info"
    };

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(filter));

    tracing_subscriber::registry()
        .with(fmt::layer().with_target(false))
        .with(env_filter)
        .init();
}
