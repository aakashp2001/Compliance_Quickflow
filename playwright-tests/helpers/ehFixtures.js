'use strict';

const fs = require('fs');
const path = require('path');

function buildXssPayload() {
  return "<script>alert('XSS')</script>";
}

function buildSqlInjectionPayload() {
  return "' OR '1'='1";
}

function buildOversizedString(length = 10000, seed = 'EH-LONG-INPUT-') {
  const safeLength = Math.max(1, Number(length) || 10000);
  if (seed.length >= safeLength) return seed.slice(0, safeLength);
  return seed + 'X'.repeat(safeLength - seed.length);
}

function ensureEhFixturesDir() {
  const dir = path.resolve(__dirname, '..', 'compliance', 'fixtures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createExecutableFixture(fileName = 'malicious.exe') {
  const dir = ensureEhFixturesDir();
  const filePath = path.join(dir, String(fileName || 'malicious.exe'));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, Buffer.from('4d5a9000', 'hex')); // MZ header bytes
  }
  return filePath;
}

function createOversizedFixture(fileName = 'oversized.bin', sizeBytes = 11 * 1024 * 1024) {
  const dir = ensureEhFixturesDir();
  const filePath = path.join(dir, String(fileName || 'oversized.bin'));
  const safeSize = Math.max(1024, Number(sizeBytes) || 11 * 1024 * 1024);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).size !== safeSize) {
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    const fd = fs.openSync(filePath, 'w');
    let written = 0;
    try {
      while (written < safeSize) {
        const remaining = safeSize - written;
        const slice = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        fs.writeSync(fd, slice);
        written += slice.length;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  return filePath;
}

function resolveMacroFixturePath(fileName = 'macro-test.xlsm') {
  const dir = ensureEhFixturesDir();
  return path.join(dir, String(fileName || 'macro-test.xlsm'));
}

function createMacroEnabledFixture(fileName = 'macro-test.xlsm') {
  const filePath = resolveMacroFixturePath(fileName);
  if (!fs.existsSync(filePath)) {
    const content = [
      'This is a synthetic macro-enabled fixture placeholder for EH testing.',
      'Filename extension is .xlsm to exercise upload policy checks.',
      'It is intentionally not a real Office macro binary.',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return filePath;
}

module.exports = {
  buildXssPayload,
  buildSqlInjectionPayload,
  buildOversizedString,
  createExecutableFixture,
  createOversizedFixture,
  createMacroEnabledFixture,
  resolveMacroFixturePath,
};
