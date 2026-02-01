# setup node, bun, git, debian(bookworm)
FROM node:latest
RUN npm i -g bun

# python3 and build tools
RUN apt update -y && apt upgrade -y
RUN apt-get update -y && apt-get install -y \
    git \
    build-essential \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# VS Code installation disabled for Docker compatibility
# Users can install VS Code manually if needed in their containers
# RUN apt update -y && apt install code -y

# Install Rust for building bun-pty native module
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

# TODO: golang for dev
# RUN apt install -y golang-go

# common db cli (optional, uncomment if needed)
# RUN apt-get update -y && apt-get install -y postgresql-client && rm -rf /var/lib/apt/lists/*

# install agents cli globally - prefer native methods when available
# Claude - use native installation (preferred)
RUN curl -fsSL https://claude.ai/install.sh | bash

# Cursor Agent - use native installation
RUN curl -fsSL https://cursor.com/install | bash

# Amp by Sourcegraph - use native installation
RUN curl -fsSL https://ampcode.com/install.sh | bash

# GitHub Copilot - use native installation
RUN curl -fsSL https://gh.io/copilot-install | bash

# Remaining tools via npm (no native installers available)
RUN npm i -g \
    @qwen-code/qwen-code \
    @vibe-kit/grok-cli \
    @google/gemini-cli \
    @openai/codex \
    @augmentcode/auggie \
    opencode-ai
    

# install bun seems not working
RUN curl -fsSL https://bun.com/install | bash && \
    echo 'export BUN_INSTALL="$HOME/.bun"' >> /root/.bashrc && \
    echo 'export PATH="$BUN_INSTALL/bin:$PATH"' >> /root/.bashrc && \
    . /root/.bashrc
    
# install this project
WORKDIR /src/agent-yes
COPY package.json bun.lock ./
# Install dependencies - node-pty will build its native modules (needs build-essential, python3)
RUN bun install

# build and link
COPY . .
RUN bun run build && bun link

# bot user?
RUN useradd -ms /bin/bash bot
# USER bot
# WORKDIR /home/bot/

# specify a workdir is recommended
WORKDIR /root/

# Use node to run (uses node-pty which properly passes environment variables)
# ENTRYPOINT ["bash", "-c", "exec node /src/agent-yes/dist/agent-yes.js $@", "bash"]
ENTRYPOINT claude-yes
# ENTRYPOINT bash -c " \
# cp -r /root /root/bo && \
# bun /src/agent-yes/dist/agent-yes.js $* \
# "
