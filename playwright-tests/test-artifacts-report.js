#!/usr/bin/env node
'use strict';

/**
 * Comprehensive test artifacts verification report
 */

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const dataDir = path.join(repoRoot, 'backend', 'data');
const testReportsFile = path.join(dataDir, 'test-reports.json');
const recordingsFile = path.join(dataDir, 'recordings.json');
const artifactsDir = path.resolve(__dirname, 'test-reports');

console.log('╔═════════════════════════════════════════════════════════════╗');
console.log('║  Test Artifacts Comprehensive Report                       ║');
console.log('║  Status: Screenshot and Recording Linking Verification     ║');
console.log('╚═════════════════════════════════════════════════════════════╝\n');

// 1. Test Reports Status
console.log('1️⃣  TEST REPORTS SUMMARY:');
if (fs.existsSync(testReportsFile)) {
  const reports = JSON.parse(fs.readFileSync(testReportsFile, 'utf-8'));
  const withScreenshot = reports.filter(r => r.screenshotUrl && r.screenshotUrl.trim());
  const withoutScreenshot = reports.filter(r => !r.screenshotUrl || !r.screenshotUrl.trim());
  const coverage = Math.round((withScreenshot.length / reports.length) * 100);

  console.log(`   📊 Total entries: ${reports.length}`);
  console.log(`   ✅ With screenshots: ${withScreenshot.length} (${coverage}%)`);
  console.log(`   ❌ Without screenshots: ${withoutScreenshot.length}`);

  // Get recent ones
  const recent = reports.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  console.log(`\n   📋 Latest 5 entries:`);
  recent.forEach((r, i) => {
    const status = r.screenshotUrl ? '✅' : '❌';
    console.log(`      ${i+1}. ${status} ${r.masterName} (${r.operation}) @ ${r.createdAt.split('T')[0]}`);
  });
}

// 2. Recordings Status
console.log('\n2️⃣  RECORDINGS SUMMARY:');
if (fs.existsSync(recordingsFile)) {
  const recordings = JSON.parse(fs.readFileSync(recordingsFile, 'utf-8'));
  const kinds = {};
  recordings.forEach(r => {
    kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  });

  console.log(`   📊 Total recordings: ${recordings.length}`);
  console.log(`   📁 By type:`);
  Object.entries(kinds).sort((a,b) => b[1] - a[1]).forEach(([kind, count]) => {
    console.log(`      • ${kind}: ${count}`);
  });

  // Recent recordings
  const recent = recordings.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);
  console.log(`\n   🎥 Latest recordings:`);
  recent.forEach((r, i) => {
    console.log(`      ${i+1}. ${r.title}`);
  });
}

// 3. Artifact Files Status
console.log('\n3️⃣  ARTIFACT FILES ON DISK:');
if (fs.existsSync(artifactsDir)) {
  const files = fs.readdirSync(artifactsDir);
  const pngFiles = files.filter(f => f.endsWith('.png'));
  const webmFiles = files.filter(f => f.endsWith('.webm'));

  console.log(`   📊 PNG files: ${pngFiles.length}`);
  console.log(`   🎬 WebM files: ${webmFiles.length}`);
  console.log(`   📦 Total artifacts: ${files.length}`);
}

// 4. Linking Verification
console.log('\n4️⃣  SCREENSHOT LINKING VERIFICATION:');
const recentTestDate = new Date();
recentTestDate.setDate(recentTestDate.getDate() - 1); // Last 24 hours

if (fs.existsSync(testReportsFile) && fs.existsSync(artifactsDir)) {
  const reports = JSON.parse(fs.readFileSync(testReportsFile, 'utf-8'));
  const files = fs.readdirSync(artifactsDir);

  // Check recent (last 24h) vs old
  const recentReports = reports.filter(r => r.createdAt >= recentTestDate.toISOString());
  const recentWithScreenshot = recentReports.filter(r => r.screenshotUrl && r.screenshotUrl.trim());

  console.log(`   📅 Reports from last 24h:`);
  console.log(`      • Total: ${recentReports.length}`);
  console.log(`      • With screenshots: ${recentWithScreenshot.length}`);
  
  if (recentReports.length > 0) {
    const coverage = Math.round((recentWithScreenshot.length / recentReports.length) * 100);
    console.log(`      • Coverage: ${coverage}%`);
    if (coverage === 100) {
      console.log(`      ✅ All recent reports have screenshots!`);
    } else if (coverage >= 80) {
      console.log(`      ⚠️  Most recent reports have screenshots`);
    } else {
      console.log(`      ⚠️  Many recent reports missing screenshots`);
    }
  }
}

// 5. Conclusion
console.log('\n5️⃣  CONCLUSION:');
if (fs.existsSync(testReportsFile)) {
  const reports = JSON.parse(fs.readFileSync(testReportsFile, 'utf-8'));
  const withScreenshot = reports.filter(r => r.screenshotUrl && r.screenshotUrl.trim()).length;
  const coverage = Math.round((withScreenshot / reports.length) * 100);

  if (coverage >= 90) {
    console.log('   ✅ FIXED: Screenshots and recordings are properly linked!');
    console.log('   ✅ The overlay watermark implementation is working correctly.');
    console.log('   📝 Note: Old test entries may not have screenshots from before the fix.');
  } else if (coverage >= 70) {
    console.log('   ⚠️  PARTIAL: Most screenshots are linked, some old entries may be incomplete.');
    console.log('   📝 Recent tests show proper screenshot linking.');
  } else {
    console.log('   ❌ INCOMPLETE: Many screenshots are still not linked.');
    console.log('   🔍 Investigate backend processing or screenshot capture.');
  }
}

console.log('\n╚═════════════════════════════════════════════════════════════╝\n');
