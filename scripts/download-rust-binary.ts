#!/usr/bin/env bun
/**
 * Script to download the prebuilt Rust binary for the current platform
 *
 * Usage:
 *   bun scripts/download-rust-binary.ts
 *   npx agent-yes download-binary
 */

import { downloadBinary, findRustBinary, getBinaryName, getDownloadUrl } from "../ts/rustBinary.ts";

async function main() {
  const verbose = process.argv.includes("--verbose") || process.argv.includes("-v");
  const force = process.argv.includes("--force") || process.argv.includes("-f");

  console.log(`Platform: ${process.platform}-${process.arch}`);
  console.log(`Binary name: ${getBinaryName()}`);
  console.log(`Download URL: ${getDownloadUrl()}`);
  console.log();

  // Check if binary already exists
  if (!force) {
    const existing = findRustBinary(verbose);
    if (existing) {
      console.log(`Binary already exists at: ${existing}`);
      console.log("Use --force to re-download");
      return;
    }
  }

  console.log("Downloading binary...");
  try {
    const binaryPath = await downloadBinary(verbose);
    console.log(`\nSuccess! Binary downloaded to: ${binaryPath}`);
    console.log("\nYou can now use: npx agent-yes --rust");
  } catch (err) {
    console.error(`\nFailed to download binary: ${err instanceof Error ? err.message : err}`);
    console.error("\nYou can build manually with:");
    console.error("  cd rs && cargo build --release");
    process.exit(1);
  }
}

main();
