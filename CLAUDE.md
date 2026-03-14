# agent-yes

## After making changes, always rebuild and relink

```bash
bun run build && bun link
```

This compiles `ts/` → `dist/` via tsdown and registers the binaries globally.
