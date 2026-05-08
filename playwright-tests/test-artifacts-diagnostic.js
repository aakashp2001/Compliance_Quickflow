#!/usr/bin/env node
'use strict';

/**
 * Diagnostic script to verify artifact capture and linking in test reports
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'backend', 'data');
const testReportsFile = path.join(dataDir, 'test-reports.json');
const artifactsDir = path.resolve(__dirname, 'test-reports');

console.log('=== Test Artifacts Diagnostic ===\n');

// 1. Check test reports
console.log('1. TEST REPORTS:');
if (!fs.existsSync(testReportsFile)) {
  console.log('   ✗ test-reports.json NOT FOUND');
} else {
  const reports = JSON.parse(fs.readFileSync(testReportsFile, 'utf-8'));
  const withScreenshot = reports.filter(r => r.screenshotUrl && r.screenshotUrl.trim());
  const withoutScreenshot = reports.filter(r => !r.screenshotUrl || !r.screenshotUrl.trim());

  console.log(`   Total entries: ${reports.length}`);
  console.log(`   With screenshotUrl: ${withScreenshot.length}`);
  console.log(`   Without screenshotUrl: ${withoutScreenshot.length}`);

  if (withoutScreenshot.length > 0) {
    console.log('\n   Recent entries WITHOUT screenshots:');
    withoutScreenshot.slice(-5).forEach((r) => {
      console.log(`     - ${r.masterName} (${r.operation}) @ ${r.createdAt}`);
    });
  }
}

// 2. Check artifacts on disk
console.log('\n2. ARTIFACT FILES:');
if (!fs.existsSync(artifactsDir)) {
  console.log('   ✗ test-reports directory NOT FOUND');
} else {
  const files = fs.readdirSync(artifactsDir);
  const pngFiles = files.filter(f => f.endsWith('.png'));
  const webmFiles = files.filter(f => f.endsWith('.webm'));

  console.log(`   PNG files: ${pngFiles.length}`);
  console.log(`   WebM files: ${webmFiles.length}`);

  // Show most recent files
  if (pngFiles.length > 0) {
    const sorted = pngFiles
      .map(f => ({ name: f, mtime: fs.statSync(path.join(artifactsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    console.log('\n   Most recent PNG files:');
    sorted.slice(0, 5).forEach((entry) => {
      console.log(`     - ${entry.name}`);
    });
  }
}

// 3. Check for mismatches
console.log('\n3. MISMATCH ANALYSIS:');
if (fs.existsSync(testReportsFile) && fs.existsSync(artifactsDir)) {
  const reports = JSON.parse(fs.readFileSync(testReportsFile, 'utf-8'));
  const files = fs.readdirSync(artifactsDir);
  const pngFiles = files.filter(f => f.endsWith('.png'));

  // Find PNG files that don't have corresponding report entries with screenshotUrl
  const orphanedFiles = pngFiles.filter((pngFile) => {
    // Extract timestamp from filename (first ISO timestamp part)
    const parts = pngFile.split('-');
    const dateStr = parts.slice(0, 2).join('-'); // YYYY-MM-DD and HHMMSS+milliseconds

    // Find reports with matching timestamp
    const matching = reports.filter((r) => {
      if (!r.createdAt) return false;
      const rDate = r.createdAt.split('T')[0];
      return rDate === dateStr.split('-').slice(0, 3).join('-');
    });

    // Check if any matching report has this file linked
    return !matching.some((r) => r.screenshotUrl && r.screenshotUrl.includes(pngFile));
  });

  if (orphanedFiles.length > 0) {
    console.log(`   Found ${orphanedFiles.length} PNG files NOT linked in test reports:`);
    orphanedFiles.slice(0, 10).forEach((f) => {
      console.log(`     - ${f}`);
    });
  } else {
    console.log('   ✓ All PNG files are linked in test reports');
  }
}

console.log('\n=== End Diagnostic ===\n');
