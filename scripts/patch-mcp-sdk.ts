#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Patch @modelcontextprotocol/sdk to add missing exports
const sdkPath = join(__dirname, '..', 'node_modules/@modelcontextprotocol/sdk/package.json');

try {
  // Check if SDK is installed
  if (!existsSync(sdkPath)) {
    console.log('⚠ @modelcontextprotocol/sdk not found, skipping patch');
    process.exit(0);
  }

  const pkg = JSON.parse(readFileSync(sdkPath, 'utf-8'));

  // Add missing exports
  let modified = false;

  if (!pkg.exports['./server/stdio']) {
    pkg.exports['./server/stdio'] = {
      import: './dist/esm/server/stdio.js',
      require: './dist/cjs/server/stdio.js'
    };
    modified = true;
  }

  if (!pkg.exports['./types']) {
    pkg.exports['./types'] = {
      import: './dist/esm/types.js',
      require: './dist/cjs/types.js'
    };
    modified = true;
  }

  if (modified) {
    writeFileSync(sdkPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('✓ Patched @modelcontextprotocol/sdk package.json');
  } else {
    console.log('✓ @modelcontextprotocol/sdk already patched');
  }
} catch (error) {
  console.error('Failed to patch @modelcontextprotocol/sdk:', error);
  process.exit(1);
}
