const { chromium } = require('@playwright/test');

const SEL = {
  username: '#txtUsername',
  password: '#txtPassword',
  loginBtn: '#btnLogin',
  unlockBtn: '#btnUnlock',
  homeReady: '#divAppButton',
  tableRows: '.dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr',
};

function firstMeaningfulCellText(row) {
  const cells = Array.from(row.querySelectorAll('td'));
  for (let i = 1; i < cells.length; i++) {
    const text = (cells[i].textContent || '').replace(/\s+/g, ' ').trim();
    if (text && !/^edit|delete|deactivate|active|inactive$/i.test(text)) return text;
  }
  return '';
}

async function run() {
  const loginUrl = process.env.QT_URL || 'https://ipdev.quickflow.in/login';
  const username = process.env.QT_USER || 'dhruvi';
  const password = process.env.QT_PASS || '';
  const masterName = String(process.env.QT_MASTER || '').trim();
  const headless = String(process.env.QT_HEADLESS || 'true').toLowerCase() !== 'false';

  if (!masterName) throw new Error('QT_MASTER is required');

  const base = new URL(loginUrl).origin;
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();

  try {
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForSelector(SEL.username, { timeout: 30000 });
    await page.fill(SEL.username, username);
    await page.fill(SEL.password, password);
    await page.click(SEL.loginBtn);
    await page.waitForTimeout(1200);

    const unlock = await page.locator(SEL.unlockBtn).isVisible().catch(() => false);
    if (unlock) {
      await page.click(SEL.unlockBtn).catch(() => { });
      await page.waitForTimeout(900);
    }

    await page.waitForSelector(SEL.homeReady, { timeout: 30000 });

    const fullUrl = `${base}/${masterName}`;
    await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(1200);

    const recordName = await page.evaluate(({ selector, helperSource }) => {
      const helper = new Function(`return (${helperSource});`)();
      const rows = Array.from(document.querySelectorAll(selector)).filter((row) => {
        const style = getComputedStyle(row);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      for (const row of rows) {
        const text = helper(row);
        if (text) return text;
      }
      return '';
    }, { selector: SEL.tableRows, helperSource: firstMeaningfulCellText.toString() });

    if (!recordName) {
      throw new Error(`No existing records found for ${masterName}`);
    }

    process.stdout.write(JSON.stringify({ masterName, recordName }));
  } finally {
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
  }
}

run().catch((error) => {
  const msg = String(error?.message || error || 'Failed to fetch first record').trim();
  process.stderr.write(msg + '\n');
  process.exit(1);
});
