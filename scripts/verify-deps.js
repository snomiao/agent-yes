#!/usr/bin/env node
/**
 * Pre-publish verification script
 * Checks that critical runtime dependencies are properly configured
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const errors = [];
const warnings = [];

// Load package.json
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

console.log('🔍 Verifying agent-yes package configuration...\n');

// Check 1: Verify critical runtime dependencies are in dependencies, not devDependencies
const runtimeImports = [
  // No critical runtime dependencies to verify currently
];

for (const { module, reason } of runtimeImports) {
  const inDeps = pkg.dependencies?.[module];
  const inDevDeps = pkg.devDependencies?.[module];

  if (!inDeps && !inDevDeps) {
    errors.push(`❌ ${module} is not listed in dependencies or devDependencies`);
    console.error(`   Required for: ${reason}`);
  } else if (inDevDeps && !inDeps) {
    errors.push(`❌ ${module} is in devDependencies but should be in dependencies`);
    console.error(`   Required at runtime for: ${reason}`);
  } else if (inDeps) {
    console.log(`✓ ${module} correctly in dependencies`);
  }
}

// Check 2: Verify build script externalizes the right dependencies
const buildScript = pkg.scripts?.build || '';
const externals = buildScript.match(/--external=[^\s]+/g) || [];

console.log('\n📦 Build externals:');
for (const ext of externals) {
  console.log(`  ${ext}`);
  const modName = ext.replace('--external=', '');

  // Check if externalized module is in dependencies
  if (modName.startsWith('@') || modName.includes('/')) {
    const inDeps = pkg.dependencies?.[modName];
    const inOptionalDeps = pkg.optionalDependencies?.[modName];

    if (!inDeps && !inOptionalDeps) {
      warnings.push(`⚠️  ${modName} is externalized but not in dependencies`);
      console.warn(`   This may cause "module not found" errors in production`);
    }
  }
}

// Check 3: Verify files field includes necessary runtime files
console.log('\n📁 Package files configuration:');
const files = pkg.files || [];
console.log(`  Files patterns: ${files.join(', ')}`);

if (!files.includes('dist/**/*.js') && !files.includes('dist')) {
  errors.push('❌ dist directory not included in package files');
}

if (!files.includes('scripts') && pkg.scripts?.postinstall?.includes('scripts/')) {
  warnings.push('⚠️  postinstall references scripts/ but it may not be included');
}

// Check 4: Verify bin entries point to existing files (after build)
console.log('\n🔗 Binary entries:');
for (const [name, path] of Object.entries(pkg.bin || {})) {
  const fullPath = join(__dirname, '..', path);
  if (existsSync(fullPath)) {
    console.log(`  ✓ ${name} → ${path}`);
  } else {
    warnings.push(`⚠️  Binary ${name} points to ${path} which doesn't exist yet`);
    console.warn(`   Run 'npm run build' before publishing`);
  }
}

// Summary
console.log('\n' + '='.repeat(60));
if (errors.length === 0 && warnings.length === 0) {
  console.log('✅ All checks passed! Package is ready for publish.\n');
  process.exit(0);
} else {
  if (errors.length > 0) {
    console.error('\n❌ ERRORS FOUND:');
    errors.forEach(err => console.error(`  ${err}`));
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️  WARNINGS:');
    warnings.forEach(warn => console.warn(`  ${warn}`));
  }

  if (errors.length > 0) {
    console.error('\n❌ Fix errors before publishing!\n');
    process.exit(1);
  } else {
    console.warn('\n⚠️  Review warnings before publishing.\n');
    process.exit(0);
  }
}
