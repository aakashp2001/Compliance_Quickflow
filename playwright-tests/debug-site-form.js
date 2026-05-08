const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://ipdev.quickflow.in/login');
  await page.waitForSelector('#txtUsername', { timeout: 30000 });
  await page.fill('#txtUsername', 'dhruvi');
  await page.fill('#txtPassword', '');
  await page.click('#btnLogin');
  await page.waitForTimeout(2000);
  const unlock = await page.locator('#btnUnlock').isVisible().catch(() => false);
  if (unlock) { await page.click('#btnUnlock'); await page.waitForTimeout(1000); }
  await page.waitForSelector('#divAppButton', { timeout: 30000 });
  await page.waitForTimeout(1000);

  // Navigate to Site
  await page.goto('https://ipdev.quickflow.in/Site');
  await page.waitForTimeout(2000);

  // Open create form
  const addBtn = page.locator('#btnAdd, button:has-text("Add"), .btn-add, button:has-text("Create")').first();
  await addBtn.click({ timeout: 8000 }).catch(() => { });
  await page.waitForTimeout(2000);

  // Try fill Country to see what loads
  const countryEl = page.locator('#CountryId33732, [id*="CountryId"], .ele:first-child [role="combobox"], .ele:first-child input').first();
  await countryEl.click({ force: true, timeout: 5000 }).catch(() => { });
  await page.waitForTimeout(600);

  const info = await page.evaluate(() => {
    const body = document.querySelector('.offcanvas.show .offcanvas-body, .offcanvas-body');
    if (!body) return { error: 'no offcanvas' };

    // Full body structure snapshot
    const allElements = Array.from(body.querySelectorAll('*')).slice(0, 200).map(el => ({
      tag: el.tagName,
      id: el.id || '',
      cls: String(el.className || '').substring(0, 80),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '',
      type: el.getAttribute('type') || '',
      value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ? (el.value || '').substring(0, 50) : '',
      ariaHidden: el.getAttribute('aria-hidden') || '',
      children: el.children.length,
    }));

    // Find ALL inputs/selects in form
    const controls = Array.from(body.querySelectorAll('input:not([type=hidden]), select, textarea')).map(el => ({
      tag: el.tagName,
      id: el.id,
      name: el.name,
      type: el.getAttribute('type') || '',
      cls: String(el.className || '').substring(0, 80),
      value: el.value || '',
      disabled: el.disabled,
      placeholder: el.getAttribute('placeholder') || '',
      ariaLabel: el.getAttribute('aria-label') || '',
    }));

    // React-select: find all comboboxes and their containers
    const comboboxes = Array.from(body.querySelectorAll('[role="combobox"], [aria-haspopup="listbox"]')).map(el => ({
      id: el.id,
      cls: (el.className || '').substring(0, 80),
      value: el.value || el.textContent?.trim().substring(0, 50),
      controlParentId: el.closest('[id]')?.id || '',
    }));

    // What's inside each .ele  
    const eles = Array.from(body.querySelectorAll('.ele')).map((ele, i) => {
      const eleId = ele.id;
      // Check parent row for label
      const row = ele.closest('.row, .form-row, .mb-3, .fv-row');
      const siblingLabel = row?.querySelector('label') || ele.previousElementSibling?.querySelector('label') || ele.previousElementSibling;
      // Check for the actual React-Select value container
      const rsValue = ele.querySelector('[class*="singleValue"], [class*="placeholder"], .css-1dimb5e-singleValue');
      const rsInput = ele.querySelector('input[id^="react-select"]');
      const rsControl = ele.querySelector('[class*="control"]');
      return {
        idx: i,
        id: eleId,
        rsValueText: rsValue?.textContent?.trim() || '',
        rsInputId: rsInput?.id || '',
        hasRsControl: !!rsControl,
        childCount: ele.childElementCount,
        innerHTMLLen: ele.innerHTML.length,
        innerHTML300: ele.innerHTML.substring(0, 300),
      };
    });

    return { controls, comboboxes, eles, eleCount: eles.length };
  });

  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
