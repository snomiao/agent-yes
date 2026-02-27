.PHONY: build release test clean install symlinks

# Build in debug mode
build:
	cargo build

# Build in release mode
release:
	cargo build --release

# Run tests
test:
	cargo test

# Clean build artifacts
clean:
	cargo clean

# Install the binary
install: release symlinks
	cargo install --path .

# Create symlinks for CLI aliases
symlinks: release
	cd target/release && \
	ln -sf agent-yes claude-yes && \
	ln -sf agent-yes gemini-yes && \
	ln -sf agent-yes codex-yes && \
	ln -sf agent-yes copilot-yes && \
	ln -sf agent-yes cursor-yes && \
	ln -sf agent-yes grok-yes && \
	ln -sf agent-yes qwen-yes && \
	ln -sf agent-yes auggie-yes

# Run the agent with debug output
run:
	cargo run -- --verbose

# Format code
fmt:
	cargo fmt

# Lint code
lint:
	cargo clippy
