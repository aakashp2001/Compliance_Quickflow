/**
 * master-data.spec.js
 *
 * Optional local wrapper for the Master Data compliance runner.
 *
 * To execute intentionally:
 *   QT_RUN_MD_SPEC=true npx playwright test compliance/master-data.spec.js --headed
 */

const { test, expect } = require('@playwright/test');
const { execFile } = require('child_process');
const path = require('path');

const SHOULD_RUN = String(process.env.QT_RUN_MD_SPEC || '').toLowerCase() === 'true';
const RUNNER_PATH = path.resolve(__dirname, 'master-data-runner.js');
const WORKDIR = path.resolve(__dirname, '..');

function runRunner(tcId = '') {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      QT_TC_ID: tcId,
    };

    execFile(process.execPath, [RUNNER_PATH], {
      cwd: WORKDIR,
      env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 12 * 60 * 1000,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = (stderr || stdout || error.message || '').toString().trim();
        reject(new Error(message || 'Master Data compliance runner failed'));
        return;
      }

      try {
        const text = String(stdout || '').trim();
        const match = text.match(/\{[\s\S]*\}$/);
        const parsed = JSON.parse(match ? match[0] : text);
        parsed._debug = String(stderr || '').trim();
        resolve(parsed);
      } catch (parseError) {
        reject(new Error(`Runner output was not valid JSON: ${parseError.message}`));
      }
    });
  });
}

test.describe('Master Data Compliance Runner Wrapper', () => {
  test.skip(!SHOULD_RUN, 'Set QT_RUN_MD_SPEC=true to execute this optional wrapper suite.');

  test('single TC execution returns suite=MD and valid status', async () => {
    const result = await runRunner('TC-MD-02-01');
    expect(result?.suite).toBe('MD');
    expect(['single', 'all']).toContain(result?.mode);
    expect(['passed', 'failed', 'blocked']).toContain(result?.status || result?.results?.[0]?.status);
  });

  test('all TC execution includes blocked count in summary', async () => {
    const result = await runRunner('');
    expect(result?.suite).toBe('MD');
    expect(result?.mode).toBe('all');
    expect(result?.summary).toBeTruthy();
    expect(typeof result.summary.blocked).toBe('number');
    expect(Array.isArray(result?.results)).toBe(true);
  });
});
