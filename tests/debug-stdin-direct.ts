#!/usr/bin/env bun
/**
 * Debug script to test if process.stdin receives data at all
 * WITHOUT using fromReadable/sflow
 *
 * This will help isolate whether the issue is with:
 * - stdin itself not receiving data
 * - fromReadable not consuming properly
 */

console.log("=== Direct stdin Test ===");
console.log("Process info:");
console.log("- stdin.isTTY:", process.stdin.isTTY);
console.log("- stdin.isRaw:", (process.stdin as any).isRaw);
console.log("- stdin.readable:", process.stdin.readable);
console.log("- stdin.isPaused:", process.stdin.isPaused());

if (process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
  console.log("✓ Raw mode enabled");
  console.log("- stdin.isRaw:", (process.stdin as any).isRaw);
}

console.log("\nPress Ctrl+C now...");
console.log("(or type some text)\n");

let dataCount = 0;

// Use direct event listener instead of fromReadable
process.stdin.on('data', (buffer: Buffer) => {
  dataCount++;
  console.log(`\n[DATA EVENT ${dataCount}] Received:`, {
    length: buffer.length,
    hex: buffer.toString('hex'),
    string: JSON.stringify(buffer.toString()),
    isCtrlC: buffer.toString() === '\u0003',
  });

  if (buffer.toString() === '\u0003') {
    console.log('\n✓ Ctrl+C DETECTED via direct event listener!');
    process.exit(130);
  }
});

process.stdin.on('readable', () => {
  console.log('[READABLE EVENT] stdin is readable, attempting to read...');

  // In non-flowing mode, we need to manually read
  let chunk;
  while (null !== (chunk = process.stdin.read())) {
    const buffer = chunk as Buffer;
    dataCount++;
    console.log(`\n[MANUAL READ ${dataCount}] Got data:`, {
      length: buffer.length,
      hex: buffer.toString('hex'),
      string: JSON.stringify(buffer.toString()),
      isCtrlC: buffer.toString() === '\u0003',
    });

    if (buffer.toString() === '\u0003') {
      console.log('\n✓ Ctrl+C DETECTED via manual read!');
      process.exit(130);
    }
  }
});

process.stdin.on('pause', () => {
  console.log('[PAUSE EVENT] stdin was paused');
});

process.stdin.on('resume', () => {
  console.log('[RESUME EVENT] stdin was resumed');
});

process.stdin.on('end', () => {
  console.log('[END EVENT] stdin ended');
});

console.log('[DEBUG] Event listeners registered');
console.log('[DEBUG] stdin.isPaused:', process.stdin.isPaused());

// Resume stdin if it's paused
if (process.stdin.isPaused()) {
  console.log('[DEBUG] Resuming paused stdin...');
  process.stdin.resume();
}

// Keep process alive
setInterval(() => {
  // Just to keep the process running
}, 1000);
