#!/usr/bin/env node
'use strict';

/**
 * Diagnostic script to verify artifact capture and linking in test reports.
 * Reads report metadata from the backend Mongo-backed API; set BACKEND_URL to override default http://127.0.0.1:8000.
 */

const fs = require('fs');
const path = require('path');

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const artifactsDir = path.resolve(__dirname, 'test-reports');

async function fetchJson(urlPath) {
  const res = await fetch(`${BACKEND_URL}${urlPath}`);
  if (!res.ok) {
    throw new Error(`GET ${urlPath} -> HTTP ${res.status}`);
  }
  return res.json();
}

async function loadReports() {
  const data = await fetchJson('/api/test-reports');
  return Array.isArray(data?.reports) ? data.reports : [];
}

async function main() {
  console.log('=== Test Artifacts Diagnostic ===\n');

  // 1. Check test reports
  console.log('1. TEST REPORTS:');
  const reports = await loadReports();
  if (!reports.length) {
    console.log('   ✗ /api/test-reports returned no entries');
  } else {
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

  // 2. Check artifacts on disk (binary artifacts intentionally on disk)
  console.log('\n2. ARTIFACT FILES:');
  if (!fs.existsSync(artifactsDir)) {
    console.log('   ✗ test-reports directory NOT FOUND');
  } else {
    const files = fs.readdirSync(artifactsDir);
    const pngFiles = files.filter(f => f.endsWith('.png'));
    const webmFiles = files.filter(f => f.endsWith('.webm'));

    console.log(`   PNG files: ${pngFiles.length}`);
    console.log(`   WebM files: ${webmFiles.length}`);

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
  if (reports.length && fs.existsSync(artifactsDir)) {
    const files = fs.readdirSync(artifactsDir);
    const pngFiles = files.filter(f => f.endsWith('.png'));

    const orphanedFiles = pngFiles.filter((pngFile) => {
      const parts = pngFile.split('-');
      const dateStr = parts.slice(0, 2).join('-');

      const matching = reports.filter((r) => {
        if (!r.createdAt) return false;
        const rDate = r.createdAt.split('T')[0];
        return rDate === dateStr.split('-').slice(0, 3).join('-');
      });

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
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
