/**
 * helpers/discoverMasters.js
 *
 * Logs into the Quickflow app, reads the navigation menu, and returns the
 * list of every master page that currently exists — including any NEW masters
 * added after this script was written.
 *
 * Returns an array of:
 * {
 *   name        : string  — URL slug (e.g. "Department")
 *   displayName : string  — human name  (e.g. "Department")
 *   href        : string  — full href  (e.g. "/Department")
 *   hasReview   : boolean — detected from the page
 * }
 */

const {
  getFields,
  detectDependencies,
  throwIfQuickFlowError,
} = require('../fetch-master-fields');

// Routes that belong to the QuickFlow shell, not to master pages.
const SYSTEM_ROUTES = new Set([
  '/',
  '/Home',
  '/home',
  '/Login',
  '/login',
  '/Create-Master',
  '/create-master',
  '/Dashboard',
  '/dashboard',
  '/Logout',
  '/logout',
  '/Profile',
  '/profile',
  '/ChangePassword',
  '/changepassword',
  '/Settings',
  '/settings',
  '/MasterReviewDashboard',
  '/masterreviewdashboard',
  // Audit / log viewers — read-only, not CRUD masters
  '/Audit-Trails',
  '/audit-trails',
  '/Template-Design-Audit-Trail',
  '/template-design-audit-trail',
  '/Task-Scheduler-Logs',
  '/task-scheduler-logs',
  // Generic / test pages that are not real masters
  '/master',
  '/test',
  // User account management (shell-level, not a data master)
  '/User-Account',
  '/user-account',
  // Access control configuration pages — system-level, not CRUD masters
  '/System-Access-Control',
  '/system-access-control',
  '/App-Access-Control',
  '/app-access-control',
  '/Role-Access-Control',
  '/role-access-control',
  '/Report-Access-Control',
  '/report-access-control',
  '/Widget-Access-Control',
  '/widget-access-control',
  // Template / dashboard / workflow builder pages — designer tools, not data masters
  '/Design-Template',
  '/design-template',
  '/Template-Workflow',
  '/template-workflow',
  '/Create-Dashboard',
  '/create-dashboard',
  '/Dashboard-Agent',
  '/dashboard-agent',
  '/Create-Bot',
  '/create-bot',
  '/RPA-Workflow',
  '/rpa-workflow',
  '/Rule-Editor',
  '/rule-editor',
  '/Functions-Library',
  '/functions-library',
  '/Query-Builder',
  '/query-builder',
  '/OAuth2-Clients',
  '/oauth2-clients',
  // Operational / transactional pages — not CRUD masters
  '/Issuance',
  '/issuance',
  '/Form-Issuance',
  '/form-issuance',
  '/View-Print',
  '/view-print',
  '/QR-Print',
  '/qr-print',
  '/Withdrawal',
  '/withdrawal',
  '/Unlock',
  '/unlock',
  '/Password-Policy',
  '/password-policy',
]);

// Prefixes that always belong to the shell
const SYSTEM_PREFIXES = [
  '/Home#',
  '/home#',
  '#',
  'javascript',
  'mailto',
  'http',   // external links
];

function isSystemRoute(href) {
  if (!href) return true;
  if (SYSTEM_ROUTES.has(href)) return true;
  if (SYSTEM_PREFIXES.some((p) => href.startsWith(p))) return true;
  // Query-string or hash-only
  if (href.startsWith('?') || href === '#') return true;
  return false;
}

/**
 * Collects every <a href="/..."> from the sidebar/topbar nav.
 * Works for both sidebar (isSidebar=true) and top-nav layouts.
 */
async function collectNavLinks(page) {
  const hrefSet = new Set();
  for (let pass = 0; pass < 6; pass++) {
    // Aggressively expand all menu groups and scroll sidebar
    await page.evaluate(() => {
      // Expand all menu groups
      const expandSelectors = [
        '.menu-link[data-kt-menu-trigger]',
        '[data-kt-menu-trigger="click"]',
        '.menu-item.menu-accordion > .menu-link',
        '.menu-arrow',
        '.sidebar .has-sub > a',
        '.sidebar .dropdown-toggle',
        '.sidebar .nav-link',
        '.sidebar .menu-toggle',
      ];
      for (const sel of expandSelectors) {
        document.querySelectorAll(sel).forEach((node) => {
          try {
            node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
            node.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true }));
            node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          } catch { }
        });
      }
      // Scroll sidebar containers to bottom and top
      const sidebars = document.querySelectorAll('.sidebar, #kt_aside, #sidebar, .sidenav, .menu');
      sidebars.forEach(sb => {
        try {
          sb.scrollTop = sb.scrollHeight;
        } catch { }
      });
      setTimeout(() => {
        sidebars.forEach(sb => {
          try {
            sb.scrollTop = 0;
          } catch { }
        });
      }, 200);
    });
    await page.waitForTimeout(600);
    // Now collect links
    const hrefs = await page.evaluate(() => {
      const containers = [
        '#kt_aside',
        '#kt_header_nav',
        '#divAppButton',
        '#ulAppList',
        '.sidebar',
        '.navbar',
        '#sidebar',
        '#nav',
        'nav',
        '.menu',
        '#menu',
        '.sidenav',
      ];
      const anchors = new Set();
      for (const sel of containers) {
        document.querySelectorAll(`${sel} a[href]`).forEach((a) => {
          const href = a.getAttribute('href');
          if (href) anchors.add(href);
        });
      }
      document.querySelectorAll('a[href^="/"]').forEach((a) => {
        const href = a.getAttribute('href');
        if (href) anchors.add(href);
      });
      return Array.from(anchors);
    });
    hrefs.forEach((href) => hrefSet.add(href));
  }
  return Array.from(hrefSet);
}

/**
 * Lightweight route probe: accept a route as a master page only if:
 *   1. The navigation did NOT redirect away (route exists and user has access).
 *   2. QuickFlow's own `.pageTitle` element is present.
 *   3. A "Create" button is visible on the RIGHT side of the page
 *      (i.e. its left edge is in the right half of the viewport).
 *      This is the definitive signal that the page is a CRUD master.
 */
async function isMasterPage(page, href, baseURL) {
  try {
    await page.goto(`${baseURL}${href}`, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for network to settle so JS-rendered buttons are in the DOM
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(800);

    // If the SPA redirected us to /login, /home, or / the route is not accessible.
    const finalPathname = new URL(page.url()).pathname.toLowerCase();
    const expectedPathname = href.toLowerCase();
    if (
      finalPathname === '/login' ||
      finalPathname === '/home' ||
      finalPathname === '/' ||
      (finalPathname !== expectedPathname && !finalPathname.startsWith(expectedPathname))
    ) {
      return false;
    }

    // Must have a .pageTitle element (all QuickFlow master pages have this).
    const hasPageTitle = await page.evaluate(() => !!document.querySelector('.pageTitle'));
    if (!hasPageTitle) return false;

    // Must have a Create button positioned on the right side of the page.
    // Try up to 3 times with short waits to handle slow JS renders.
    for (let attempt = 0; attempt < 3; attempt++) {
      const hasCreateOnRight = await page.evaluate(() => {
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
        const midpoint = viewportWidth / 2;

        const isVisible = (el) => {
          if (!el) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const hasCreateText = (el) => {
          // Check visible text (innerText strips hidden elements like icon-only spans)
          const inner = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (/\bCreate\b/i.test(inner)) return true;
          // Check full textContent (catches stepswhere innerText is empty due to CSS)
          const full = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (/\bCreate\b/i.test(full)) return true;
          // Check aria-label and title attributes (icon-only buttons)
          const aria = el.getAttribute('aria-label') || '';
          const title = el.getAttribute('title') || '';
          if (/\bCreate\b/i.test(aria) || /\bCreate\b/i.test(title)) return true;
          // Check child spans/labels (QuickFlow wraps button text in <span>)
          const spanText = Array.from(el.querySelectorAll('span, label'))
            .map(s => (s.innerText || s.textContent || '').trim())
            .join(' ');
          return /\bCreate\b/i.test(spanText);
        };

        // Collect all candidate Create buttons/links
        const candidates = Array.from(document.querySelectorAll(
          'button, a.btn, a[role="button"]'
        )).filter((el) => isVisible(el) && hasCreateText(el));

        // Accept if any Create button's left edge is past the viewport midpoint
        return candidates.some((el) => {
          const rect = el.getBoundingClientRect();
          return rect.left >= midpoint;
        });
      });

      if (hasCreateOnRight) return true;

      // Button not found yet — wait a bit and retry
      if (attempt < 2) await page.waitForTimeout(700);
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Detect whether the current master page uses a review workflow.
 * We check for the existence of a "Review" button or is_review_workflow
 * reflected in the DOM by creating a record first — here we use a lighter
 * heuristic: after opening the Create form look for a "hasReview" signal
 * stored in `window.data`.
 */
async function detectHasReview(page) {
  try {
    const hasReview = await page.evaluate(() => {
      return !!(window.data?.tblFormMst?.is_review_workflow === 'Y' ||
        window.data?.is_review_workflow === 'Y');
    });
    return hasReview;
  } catch {
    return false;
  }
}

async function openCreateFormOnCurrentMasterPage(page, masterName) {
  const alreadyOpen = await page
    .locator('#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body')
    .first()
    .isVisible()
    .catch(() => false);

  if (!alreadyOpen) {
    const createAction = page.locator('button:visible, a:visible:not(.menu-link)', { hasText: /^\s*Create\s*$/ }).first();
    await createAction.waitFor({ state: 'visible', timeout: 30000 });
    await createAction.click();
  }

  await throwIfQuickFlowError(page, masterName, 'create click (inline discovery)');
  await page.waitForSelector('.offcanvas.show, .offcanvas-body', { timeout: 15000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
  await page.waitForFunction(
    () => window.data != null && (Array.isArray(window.data.tblFormDtl) || Array.isArray(window.data.tblFormSubDtl)),
    { timeout: 10000 }
  ).catch(() => { });
  await page.waitForTimeout(400);
  await throwIfQuickFlowError(page, masterName, 'form metadata load (inline discovery)');
}

/**
 * Main function.
 *
 * @param {import('@playwright/test').Page} page  — already-logged-in page
 * @param {string} baseURL  — e.g. "https://ipdev.quickflow.in"
 * @param {string[]} [onlyNames]  — optional whitelist of slugs; omit to test ALL
 * @param {string[]} [skipNames]  — slugs to skip even if auto-discovered
 * @returns {Promise<Array>}
 */
async function discoverMasters(page, baseURL, onlyNames = [], skipNames = [], options = {}) {
  const includeFields = options?.includeFields === true;
  console.log('[DISCOVER] Collecting nav linksâ€¦');

  const hrefs = await collectNavLinks(page);
  console.log(`[DISCOVER] Found ${hrefs.length} total nav anchors`);

  // Filter: keep only candidate master routes
  const candidates = hrefs
    .filter((h) => h && h.startsWith('/') && !isSystemRoute(h))
    .map((h) => h.split('?')[0].split('#')[0])   // strip query / hash
    .filter((h, i, arr) => arr.indexOf(h) === i); // deduplicate

  console.log(`[DISCOVER] ${candidates.length} candidate routes after filter:`, candidates);

  const skipSet = new Set((skipNames || []).map((n) => n.toLowerCase()));
  const onlySet = new Set((onlyNames || []).map((n) => n.toLowerCase()));

  const discovered = [];

  for (const href of candidates) {
    const slug = href.replace(/^\//, '');       // "Department"
    const slugLower = slug.toLowerCase();

    if (skipSet.has(slugLower)) {
      console.log(`[DISCOVER] skip ${slug} (in skipNames)`);
      continue;
    }

    if (onlySet.size > 0 && !onlySet.has(slugLower)) {
      console.log(`[DISCOVER] skip ${slug} (not in onlyNames filter)`);
      continue;
    }

    try {
      process.stderr.write(`[DISCOVER] Checking ${href} ...\n`);
      const isMaster = await isMasterPage(page, href, baseURL);

      if (isMaster) {
        const hasReview = await detectHasReview(page);
        const displayName = slug.replaceAll('--', ' & ').replaceAll('-', ' ');
        const masterPayload = { name: slug, displayName, href, hasReview };

        if (includeFields) {
          try {
            await openCreateFormOnCurrentMasterPage(page, slug);
            const fields = await getFields(page);
            const detectedDependencies = await detectDependencies(page);
            masterPayload.fields = Array.isArray(fields) ? fields : [];
            masterPayload.detectedDependencies = detectedDependencies || { parentDropdowns: [], dependentDropdowns: [] };
            console.log(`[DISCOVER] master ok ${slug} (hasReview=${hasReview}, fields=${masterPayload.fields.length})`);
          } catch (error) {
            masterPayload.fields = [];
            masterPayload.detectedDependencies = { parentDropdowns: [], dependentDropdowns: [] };
            masterPayload.fieldFetchError = String(error?.message || 'Field extraction failed during discovery');
            console.log(`[DISCOVER] master partial ${slug} (create/field failed, continue-next=true)`);
          }
        } else {
          console.log(`[DISCOVER] master ok ${slug} (hasReview=${hasReview})`);
        }

        discovered.push(masterPayload);
      } else {
        console.log(`[DISCOVER] skip ${slug} (did not meet master-page checks)`);
      }
    } catch (error) {
      console.log(`[DISCOVER] skip ${slug} (runtime error: ${String(error?.message || error)})`);
      continue;
    }
  }

  console.log(`\n[DISCOVER] Total masters discovered: ${discovered.length}`);
  discovered.forEach((m) => console.log(`  - ${m.displayName}${m.hasReview ? ' (review)' : ''}`));

  return discovered;
}

module.exports = { discoverMasters };
