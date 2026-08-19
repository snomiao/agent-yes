# Building Binaries with Bun

This project now supports building standalone binaries using Bun's compile feature. No need for Node.js or npm at runtime!

## Quick Start

### Build Binary for Current Platform

To build a binary for your current platform (Linux, macOS, or Windows):

```bash
bunj run build:binary
```

This will create binaries in `dist/bin/`:

- `agent-yes` (main binary)
- `claude-yes` (symlink/copy)
- `codex-yes` (symlink/copy)
- `copilot-yes` (symlink/copy)
- `cursor-yes` (symlink/copy)
- `gemini-yes` (symlink/copy)
- `grok-yes` (symlink/copy)
- `qwen-yes` (symlink/copy)

### Build Binaries for All Platforms

To build binaries for all supported platforms (Linux, macOS, Windows) and architectures (x64, arm64):

```bash
bun run build:binaries
```

This will create binaries in `dist/binaries/` organized by platform:

- `linux-x64/`
- `linux-arm64/`
- `darwin-x64/`
- `darwin-arm64/`
- `windows-x64/`
- `windows-arm64/`

## Usage

After building, you can run the binaries directly:

```bash
# Add to PATH (optional)
export PATH="./dist/bin:$PATH"

# Run directly
./dist/bin/claude-yes --help

# Or use specific CLI variants
./dist/bin/codex-yes "help me solve all todos"
./dist/bin/cursor-yes "refactor this code"
```

## Benefits of Binary Distribution

1. **No Runtime Dependencies**: Users don't need Node.js, Bun, or npm installed
2. **Faster Startup**: Compiled binaries start faster than interpreted JavaScript
3. **Easier Distribution**: Single executable file is easier to share
4. **Better Performance**: Optimized binary code runs faster
5. **Cross-Platform**: Build once, run anywhere (for each platform)

## Development vs Production

- **Development**: Use `bun run dev` or `bun ts/index.ts` for faster iteration
- **Production**: Use `bun run build:binary` to create optimized binaries

## Notes

- Binaries are platform-specific - a Linux binary won't run on macOS or Windows
- The binary includes Bun runtime, so it's larger (~50-100MB) but self-contained
- External dependencies like `@snomiao/bun-pty` are bundled into the binary
