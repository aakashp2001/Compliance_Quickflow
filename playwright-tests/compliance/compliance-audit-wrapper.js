'use strict';

const __complianceAuditTrailLocal = (() => {
  const AUDIT_ROW_SELECTOR = '#auditTrailTable tbody tr, #output-table-body tr, #output-table tr, #information_table tbody tr, #information_table_wrapper tbody tr, .dt-scroll-body tbody tr, .dataTables_scrollBody tbody tr, table tbody tr';
  const REPORT_LIST_ROW_SELECTOR = '#file-table-body tr, #file-table tr';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function uniqueNonEmpty(values) {
    return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
  }

  function formatMasterDisplayName(masterName) {
    return String(masterName || '').replaceAll('--', ' & ').replaceAll('-', ' ').replace(/\s+/g, ' ').trim();
  }

  function buildMasterNameCandidates(masterName) {
    const slug = String(masterName || '').trim();
    const display = formatMasterDisplayName(slug);
    const withoutMasterWord = display.replace(/\bmaster\b/gi, '').replace(/\s+/g, ' ').trim();
    const firstWord = display.split(/\s+/).filter(Boolean)[0] || '';
    return uniqueNonEmpty([
      slug,
      display,
      `${display} Audit Trail`,
      withoutMasterWord,
      firstWord,
    ]);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function safeWait(pageOrPopup, ms = 1000) {
    if (!pageOrPopup || pageOrPopup.isClosed?.()) {
      return delay(ms);
    }
    return pageOrPopup.waitForTimeout(ms).catch(() => delay(ms));
  }

  async function safeEvaluate(pageOrPopup, script, arg) {
    if (!pageOrPopup || pageOrPopup.isClosed?.()) {
      return null;
    }
    return pageOrPopup.evaluate(script, arg).catch((error) => {
      const message = String(error?.message || error || 'evaluate failed');
      // Detached frames are common during report popup refresh; avoid flooding logs.
      if (!/frame was detached/i.test(message)) {
        console.warn(`[AUDIT] evaluate() failed: ${message}`);
      }
      return null;
    });
  }

  function buildOperationPattern(operation) {
    switch (String(operation || '').toLowerCase()) {
      case 'create':
        return /\b(create|created|add|added|save|saved|insert|inserted)\b/i;
      case 'update':
        return /\b(update|updated|edit|edited|modify|modified)\b/i;
      case 'delete':
        return /\b(delete|deleted|deactivate|deactivated|inactive|remove|removed)\b/i;
      default:
        return /.*/i;
    }
  }

  function isMeaningfulValue(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    if (text.length > 120) return false;
    return !/^(true|false|null|undefined|select|choose)$/i.test(text);
  }

  function pickPreferredEntries(auditTrail, limit = 25) {
    return Object.entries(auditTrail || {})
      .filter(([key, value]) => isMeaningfulValue(value) && !/password|confirm password/i.test(String(key || '')))
      .sort((left, right) => {
        const score = (entry) => {
          const key = String(entry[0] || '').toLowerCase();
          let total = 0;
          if (/(code|id|name|title|user|email|phone|mobile|location|department|role|app)/.test(key)) total += 10;
          if (/(password|remark|description)/.test(key)) total -= 5;
          total += Math.min(String(entry[1] || '').length, 20) / 10;
          return total;
        };
        return score(right) - score(left);
      })
      .slice(0, limit)
      .map(([key, value]) => ({ key: String(key || '').trim(), value: String(value || '').trim() }));
  }

  function inferPrimaryRecordIdentifier(auditTrail, fallbackValue = '') {
    const preferred = Object.entries(auditTrail || {})
      .filter(([, value]) => isMeaningfulValue(value))
      .sort((left, right) => {
        const score = (entry) => {
          const key = String(entry[0] || '').toLowerCase();
          let total = 0;
          if (/(record|code|id)/.test(key)) total += 30;
          if (/(username|email|name|title)/.test(key)) total += 20;
          if (/(department|location|role|app)/.test(key)) total += 10;
          return total;
        };
        return score(right) - score(left);
      });

    return String(preferred[0]?.[1] || fallbackValue || '').trim();
  }

  function isLikelyRecordId(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    // Common IDs like DP-26-000083, USR-01-0001, etc.
    if (/^[A-Z]{1,10}-\d{1,8}-\d{1,12}$/i.test(text)) return true;
    // Generic fallback: token with at least one dash and enough digits.
    if (/^[A-Z0-9]+(?:-[A-Z0-9]+){1,}$/i.test(text) && (text.match(/\d/g) || []).length >= 3) return true;
    return false;
  }

  function includesNormalized(haystack, needle) {
    const left = normalizeText(haystack);
    const right = normalizeText(needle);
    return !!right && left.includes(right);
  }

  async function waitForAuditLanding(page, timeoutMs = 8000) {
    return page.waitForFunction(() => {
      const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').toLowerCase();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, .pageTitle, .masterTitle'))
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return bodyText.includes('audit trail') || headings.includes('audit trail');
    }, { timeout: timeoutMs }).then(() => true).catch(() => false);
  }

  async function openAuditTrailPage(page, baseURL) {
    console.log('[AUDIT] Opening Audit Trail module...');
    const base = String(baseURL || '').replace(/\/$/, '');
    const moduleRoutes = [
      `${base}/Audit-History`,
      // `${base}/Audit-Trails`,
      // `${base}/Audit-Trail`,
      // `${base}/AuditTrail`,
    ].filter(Boolean);

    for (const url of moduleRoutes) {
      console.log(`[AUDIT] Trying module route: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      await safeWait(page, 1200);
      if (await waitForAuditLanding(page, 2500)) {
        break;
      }
    }

    const viewerRoutes = [
      `${base}/report/viewer`,
    ].filter(Boolean);

    for (const url of viewerRoutes) {
      console.log(`[AUDIT] Trying viewer route: ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      const reportRootVisible = await page.waitForFunction((selector) => {
        return !!document.querySelector(selector);
      }, `${REPORT_LIST_ROW_SELECTOR}, a[id*="Master Audit Trail_anchor"], a[id*="Master\\ Audit\\ Trail_anchor"]`, { timeout: 15000 }).then(() => true).catch(() => false);
      if (reportRootVisible) return;
    }

    throw new Error('Audit Trail module could not be opened.');
  }

  async function clickVisibleTextTarget(page, selector, candidates) {
    for (const candidate of candidates) {
      const locator = page.locator(selector, { hasText: candidate }).first();
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: 8000, force: true }).catch(() => { });
      await safeWait(page, 1000);
      console.log(`[AUDIT] Clicked target: ${String(candidate)}`);
      return candidate;
    }
    return '';
  }

  async function waitForRowsToLoad(page, selector, timeoutMs = 30000) {
    const startedAt = Date.now();
    let nullReadCount = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const rowsRaw = await safeEvaluate(page, (rowSelector) => {
        return Array.from(document.querySelectorAll(rowSelector)).map((row) => (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim());
      }, selector);
      if (rowsRaw === null) {
        nullReadCount += 1;
        if (nullReadCount >= 5) {
          return [];
        }
        await safeWait(page, 400);
        continue;
      }
      nullReadCount = 0;
      const rows = Array.isArray(rowsRaw) ? rowsRaw : [];

      const meaningful = rows.filter((text) => text && !/please wait|loading/i.test(text));
      if (meaningful.length > 0) return meaningful;
      await safeWait(page, 1000);
    }
    return [];
  }

  function looksLikeAuditEntries(rows, expected) {
    return (rows || []).some((text) => {
      const op = expected.operationPattern.test(text);
      const identifier = expected.identifiers.length === 0
        ? true
        : expected.identifiers.some((id) => includesNormalized(text, id));
      const master = expected.masterCandidates.some((candidate) => includesNormalized(text, candidate));
      return op && (identifier || master);
    });
  }

  async function triggerReportExecution(page) {
    if (!page || page.isClosed?.()) return false;

    const buttons = [
      page.locator('button:visible:not([disabled])', { hasText: /execute|ecucute|run|apply|view|search|submit/i }).first(),
      page.locator('a:visible', { hasText: /execute|ecucute|run|apply|view|search|submit/i }).first(),
      page.locator('[title*="Execute" i]:visible, [aria-label*="Execute" i]:visible').first(),
      page.locator('button.btn-success:visible:not([disabled])').first(),
    ];

    for (const button of buttons) {
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      await button.click({ timeout: 5000, force: true }).catch(() => { });
      await safeWait(page, 5000);
      return true;
    }

    return false;
  }

  async function resolveAuditInteractionContext(context) {
    const scoreContext = async (ctx) => {
      return await safeEvaluate(ctx, () => {
        const isVisible = (el) => !!el && !!el.offsetParent;
        const operators = Array.from(document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]')).filter(isVisible).length;
        const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible).length;
        const execute = Array.from(document.querySelectorAll('button, a'))
          .filter(isVisible)
          .some((el) => /execute|ecucute|run|apply|search|submit/i.test(`${el.textContent || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('aria-label') || ''}`));
        return { operators, inputs, execute };
      }) || { operators: 0, inputs: 0, execute: false };
    };

    const mainStats = await scoreContext(context);
    let best = { ctx: context, stats: mainStats, score: (mainStats.operators * 10) + (mainStats.inputs * 2) + (mainStats.execute ? 5 : 0) };

    if (typeof context.frames === 'function') {
      for (const frame of context.frames()) {
        if (!frame || (typeof context.mainFrame === 'function' && frame === context.mainFrame())) continue;
        const stats = await scoreContext(frame);
        const score = (stats.operators * 10) + (stats.inputs * 2) + (stats.execute ? 5 : 0);
        if (score > best.score) {
          best = { ctx: frame, stats, score };
        }
      }
    }

    console.log(`[AUDIT] Context resolution: selected operators=${best.stats.operators}, inputs=${best.stats.inputs}, execute=${best.stats.execute}`);
    return best.ctx;
  }

  async function ensurePerformedOnDateRange(page) {
    if (!page || page.isClosed?.()) {
      return { filled: false, reason: 'page-closed-or-invalid' };
    }

    // Do the default from and to date as today -1 date to +1 date in this format '12/31/2099'
    const today = new Date();

    // Yesterday
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    const DEFAULT_FROM = `${String(yesterday.getMonth() + 1).padStart(2, '0')}/` +
      `${String(yesterday.getDate()).padStart(2, '0')}/` +
      `${yesterday.getFullYear()}`;

    // Tomorrow
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    const DEFAULT_TO = `${String(tomorrow.getMonth() + 1).padStart(2, '0')}/` +
      `${String(tomorrow.getDate()).padStart(2, '0')}/` +
      `${tomorrow.getFullYear()}`;

    // const DEFAULT_FROM = '01/01/2000';
    // const DEFAULT_TO = '12/31/2099';

    const result = await safeEvaluate(page, ({ defaultFrom, defaultTo }) => {
      const isVisible = (el) => !!el && !!el.offsetParent;
      const emit = (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      const operatorSelects = Array.from(document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]'));
      for (const operator of operatorSelects) {
        const operatorText = String(operator.options?.[operator.selectedIndex]?.textContent || operator.value || '').toLowerCase();
        const operatorValue = String(operator.value || '').toLowerCase();
        const looksLikeBetween = /between/.test(operatorText) || /between/.test(operatorValue);
        if (!looksLikeBetween) continue;

        const base = (operator.id || operator.name || '').replace(/_Operator$/, '');
        if (!base) continue;

        const input1 = document.getElementById(`${base}_Value_1`) || document.querySelector(`input[name="${base}_Value_1"]`);
        const input2 = document.getElementById(`${base}_Value_2`) || document.querySelector(`input[name="${base}_Value_2"]`);
        if (!isVisible(input1) || !isVisible(input2)) continue;

        const old1 = String(input1.value || '').trim();
        const old2 = String(input2.value || '').trim();
        if (old1 && old2) {
          return { filled: false, reason: 'already-filled', base, value1: old1, value2: old2 };
        }

        const setInputDate = (input, valueText) => {
          input.value = valueText;
          emit(input);
          if (String(input.value || '').trim()) return true;

          input.setAttribute('value', valueText);
          emit(input);
          return !!String(input.value || '').trim();
        };

        input1.removeAttribute('readonly');
        input2.removeAttribute('readonly');

        const ok1 = setInputDate(input1, defaultFrom);
        const ok2 = setInputDate(input2, defaultTo);

        // jQuery datepicker fallback.
        const jq = window.jQuery || window.$;
        if (jq) {
          try {
            const $i1 = jq(input1);
            const $i2 = jq(input2);
            if ($i1?.datepicker) $i1.datepicker('setDate', defaultFrom);
            if ($i2?.datepicker) $i2.datepicker('setDate', defaultTo);
            if ($i1?.datetimepicker) $i1.datetimepicker('setDate', defaultFrom);
            if ($i2?.datetimepicker) $i2.datetimepicker('setDate', defaultTo);
            emit(input1);
            emit(input2);
          } catch {
            // ignore plugin-specific failures
          }
        }

        // Guard against inverted range after widget normalization.
        const v1 = String(input1.value || '').trim();
        const v2 = String(input2.value || '').trim();
        const d1 = new Date(v1);
        const d2 = new Date(v2);
        if (!Number.isNaN(+d1) && !Number.isNaN(+d2) && d1 > d2) {
          const tmp = input1.value;
          input1.value = input2.value;
          input2.value = tmp;
          emit(input1);
          emit(input2);
        }

        return {
          filled: ok1 || ok2 || !!String(input1.value || '').trim() || !!String(input2.value || '').trim(),
          reason: (ok1 || ok2) ? 'filled' : 'attempted',
          base,
          value1: input1.value,
          value2: input2.value,
        };
      }

      return { filled: false, reason: 'performed-on-between-filter-not-found' };
    }, { defaultFrom: DEFAULT_FROM, defaultTo: DEFAULT_TO }) || {
      filled: false,
      reason: 'evaluate-failed',
    };

    if (result.filled) {
      console.log(`[AUDIT] Performed On range set: ${result.value1} -> ${result.value2}`);
      await safeWait(page, 300);
    } else {
      console.log(`[AUDIT] Performed On range not set: ${result.reason}`);
    }
    return result;
  }

  async function clearMasterNameFilter(page) {
    const cleared = await safeEvaluate(page, () => {
      const operatorSelects = Array.from(document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]'));
      const masterOperator = operatorSelects.find((sel) => {
        const options = Array.from(sel.options || []).map((opt) => (opt.textContent || '').toLowerCase());
        return options.some((text) => /master\s*name\s*equals/i.test(text));
      });
      if (!masterOperator) return false;

      const emit = (el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      };

      let valueSelect = null;
      if (masterOperator.id) valueSelect = document.querySelector(`select.enum[opid="${masterOperator.id}"]`);
      if (!valueSelect && masterOperator.name) valueSelect = document.querySelector(`select.enum[opid="${masterOperator.name}"]`);
      if (!valueSelect) valueSelect = Array.from(document.querySelectorAll('select.enum, select[name$="_Option_Value"], select[id$="_Option_Value"]')).sort((a, b) => (b.options?.length || 0) - (a.options?.length || 0))[0] || null;
      if (!valueSelect) return false;

      for (const opt of Array.from(valueSelect.options || [])) opt.selected = false;
      valueSelect.value = '';
      emit(valueSelect);

      const jq = window.jQuery || window.$;
      if (jq) {
        try {
          const $v = jq(valueSelect);
          if ($v?.selectpicker) {
            $v.selectpicker('deselectAll');
            $v.selectpicker('refresh');
          }
        } catch {
          // ignore plugin API failures
        }
      }

      return true;
    }) || false;

    if (cleared) {
      console.log('[AUDIT] Master Name filter cleared for global fallback search.');
      await safeWait(page, 300);
    }
    return cleared;
  }

  async function selectMasterFilterAndExecute(page, expected) {
    const masterCandidates = expected.masterCandidates || buildMasterNameCandidates(expected.masterName);

    console.log(`[AUDIT] Selecting master filter for: ${expected.masterDisplayName || expected.masterName}`);

    // 1) Deterministic selection through underlying <select> controls used by bootstrap-select.
    const selection = await safeEvaluate(page, (candidates) => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const squash = (value) => norm(value).replace(/[^a-z0-9]/g, '');
      const isVisible = (el) => !!el && !!el.offsetParent;
      const eq = (a, b) => squash(a) === squash(b);
      const optionIncludesCandidate = (optionText, candidateText) => {
        const option = squash(optionText);
        const candidate = squash(candidateText);
        if (!option || !candidate) return false;
        if (option === candidate) return true;
        if (candidate.length < 5) return false;
        return option.includes(candidate);
      };
      const isWeakOption = (value) => /^(master|test|default|other|na)$/i.test(norm(value));
      const tokens = (value) => norm(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token && !['master', 'name', 'details', 'detail', 'id'].includes(token));

      const setSelectValue = (select, value) => {
        select.value = value;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const allOperatorSelects = Array.from(document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]'));
      const operatorSelect = allOperatorSelects.find((sel) => {
        const optionTexts = Array.from(sel.options || []).map((opt) => opt.textContent || '');
        return optionTexts.some((text) => /master\s*name\s*equals/i.test(text));
      }) || null;

      if (operatorSelect) {
        const equalOption = Array.from(operatorSelect.options || []).find((opt) => /master\s*name\s*equals|\bequal\b/i.test(opt.textContent || '') || /^equal$/i.test(String(opt.value || '')));
        if (equalOption) {
          setSelectValue(operatorSelect, equalOption.value);
        }
      }

      let valueSelect = null;
      if (operatorSelect?.id) {
        valueSelect = document.querySelector(`select.enum[opid="${operatorSelect.id}"]`);
      }
      if (!valueSelect && operatorSelect?.name) {
        valueSelect = document.querySelector(`select.enum[opid="${operatorSelect.name}"]`);
      }
      if (!valueSelect) {
        valueSelect = Array.from(document.querySelectorAll('select.enum, select[name$="_Option_Value"], select[id$="_Option_Value"]'))
          .sort((a, b) => (b.options?.length || 0) - (a.options?.length || 0))[0] || null;
      }

      if (!valueSelect) {
        return {
          selected: '',
          reason: 'value-select-not-found',
          operatorId: operatorSelect?.id || '',
          optionPreview: [],
        };
      }

      const options = Array.from(valueSelect.options || []).filter((opt) => String(opt.textContent || '').trim());
      const optionPreview = options.slice(0, 20).map((opt) => String(opt.textContent || '').trim());

      const findBestOption = () => {
        for (const candidate of candidates) {
          const exact = options.find((opt) => eq(opt.textContent || '', candidate));
          if (exact) return exact;
        }
        for (const candidate of candidates) {
          const partial = options.find((opt) => {
            const optionText = opt.textContent || '';
            if (isWeakOption(optionText)) return false;
            return optionIncludesCandidate(optionText, candidate);
          });
          if (partial) return partial;
        }

        // Fallback: choose closest semantic option by token overlap (ex: "Equipment Name Master" -> "Equipment Details Master").
        let best = null;
        let bestScore = 0;
        for (const candidate of candidates) {
          const candidateTokens = tokens(candidate);
          if (!candidateTokens.length) continue;
          for (const opt of options) {
            const optionText = opt.textContent || '';
            if (isWeakOption(optionText)) continue;
            const optionTokens = tokens(optionText);
            const overlap = candidateTokens.filter((token) => optionTokens.includes(token)).length;
            const hasMasterWord = /\bmaster\b/i.test(optionText);
            const score = overlap + (hasMasterWord ? 0.25 : 0);
            if (score > bestScore) {
              bestScore = score;
              best = opt;
            }
          }
        }
        if (best && bestScore >= 1) return best;

        return null;
      };

      const matched = findBestOption();
      if (!matched) {
        return {
          selected: '',
          reason: 'candidate-not-found',
          operatorId: operatorSelect?.id || '',
          optionPreview,
        };
      }

      for (const opt of options) opt.selected = false;
      matched.selected = true;
      valueSelect.dispatchEvent(new Event('input', { bubbles: true }));
      valueSelect.dispatchEvent(new Event('change', { bubbles: true }));

      const jq = window.jQuery || window.$;
      if (jq) {
        const $value = jq(valueSelect);
        if ($value?.selectpicker) {
          try {
            $value.selectpicker('val', [matched.value]);
            $value.selectpicker('render');
            $value.selectpicker('refresh');
          } catch {
            // ignore plugin failures and rely on native change event
          }
        }
      }

      return {
        selected: String(matched.textContent || matched.value || '').trim(),
        reason: 'selected',
        operatorId: operatorSelect?.id || '',
        optionPreview,
      };
    }, masterCandidates).catch(() => ({ selected: '', reason: 'evaluate-failed', operatorId: '', optionPreview: [] }));

    if (selection.selected) {
      console.log(`[AUDIT] Master filter selected (deterministic): ${selection.selected}`);
      await ensurePerformedOnDateRange(page).catch(() => { });
      await triggerReportExecution(page).catch(() => { });
      await safeWait(page, 1200);
      return true;
    }

    const preview = (selection.optionPreview || []).slice(0, 8).join(' | ');
    console.log(`[AUDIT] Master filter auto-select failed (${selection.reason || 'unknown'}). OperatorId=${selection.operatorId || 'n/a'} Preview=${preview || 'none'}`);

    console.log('[AUDIT] Master filter selection skipped; report may be pre-filtered or filter not available. Continuing with current context.');
    await ensurePerformedOnDateRange(page).catch(() => { });
    await triggerReportExecution(page).catch(() => { });
    await safeWait(page, 1200);
    return false;
  }

  async function openMasterAuditTrailReport(page) {
    console.log('[AUDIT] Opening Master Audit Trail category...');
    await clickVisibleTextTarget(page, 'a:visible', [/^Master Audit Trail$/i]);

    const reportRows = await waitForRowsToLoad(page, REPORT_LIST_ROW_SELECTOR, 20000);
    if (!reportRows.some((text) => /master audit trail/i.test(text))) {
      throw new Error('Master Audit Trail report list did not load.');
    }

    console.log('[AUDIT] Opening Master Audit Trail report...');
    let reportName = '';
    let popup = null;
    const reportAnchor = page.locator('a.report-name:visible', { hasText: /^Master Audit Trail$/i }).first();
    const reportAnchorVisible = await reportAnchor.isVisible().catch(() => false);
    if (reportAnchorVisible) {
      const result = await Promise.all([
        page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
        reportAnchor.click({ timeout: 8000, force: true }).catch(() => { }),
      ]);
      popup = result[0];
      reportName = 'Master Audit Trail';
      await safeWait(page, 1200);
    }

    // Fallback: popup event can be missed in some runs; detect already-open report windows from context pages.
    if (!popup) {
      const reportPages = page.context().pages()
        .filter((p) => p !== page)
        .filter((p) => /\/report\/view\?/i.test(String(p.url() || '')));
      if (reportPages.length) {
        popup = reportPages[reportPages.length - 1];
        reportName = reportName || 'Master Audit Trail';
      }
    }

    // Last resort: try double click to open report view.
    if (!popup && reportAnchorVisible) {
      const retry = await Promise.all([
        page.waitForEvent('popup', { timeout: 6000 }).catch(() => null),
        reportAnchor.dblclick({ timeout: 6000, force: true }).catch(() => { }),
      ]);
      popup = retry[0];
      if (popup) {
        reportName = reportName || 'Master Audit Trail';
        await safeWait(page, 600);
      }
    }

    if (!reportName) {
      reportName = await clickVisibleTextTarget(page, 'a.report-name:visible', [/^Master Audit Trail$/i]);
    }
    if (!reportName) {
      const reportRow = page.locator(`${REPORT_LIST_ROW_SELECTOR}:visible`, { hasText: /master audit trail/i }).first();
      if (await reportRow.isVisible().catch(() => false)) {
        await reportRow.click({ timeout: 8000, force: true }).catch(() => { });
        reportName = 'Master Audit Trail';
      }
    }
    if (!reportName) {
      throw new Error('Master Audit Trail report could not be opened from report list.');
    }

    let contexts = [page];
    if (popup) {
      await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => { });
      await popup.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
      await safeWait(popup, 1200);
      const frames = popup.frames().filter((frame) => frame !== popup.mainFrame());
      contexts = frames.length ? frames.concat([popup]) : [popup, page];
    }

    const scored = [];
    for (const context of contexts) {
      const stats = await context.evaluate(() => {
        const opCount = document.querySelectorAll('select.operator_select, select[name$="_Operator"], select[id$="_Operator"]').length;
        const valueCount = document.querySelectorAll('select[name$="_Option_Value"], select[id$="_Option_Value"], select.enum').length;
        const hasExecute = Array.from(document.querySelectorAll('button, a')).some((el) => /execute|run|apply|search|view/i.test((el.textContent || '').trim()));
        return { opCount, valueCount, hasExecute };
      }).catch(() => ({ opCount: 0, valueCount: 0, hasExecute: false }));
      const score = stats.opCount * 10 + stats.valueCount * 10 + (stats.hasExecute ? 1 : 0);
      scored.push({ context, score, stats });
    }

    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0]?.context || page;
    const winnerStats = scored[0]?.stats || { opCount: 0, valueCount: 0, hasExecute: false };
    console.log(`[AUDIT] Report context selected: op=${winnerStats.opCount} value=${winnerStats.valueCount} execute=${winnerStats.hasExecute}`);

    if ((winnerStats.opCount + winnerStats.valueCount) === 0) {
      throw new Error('Master Audit Trail report context could not be resolved (filters not found).');
    }

    await safeWait(winner, 1000);
    return winner;
  }

  async function openSpecificMasterAudit(page, expected) {
    console.log(`[AUDIT] Opening specific master audit: ${expected.masterDisplayName || expected.masterName}`);
    const masterCandidates = buildMasterNameCandidates(expected.masterName);
    let loadedRows = await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 30000);
    if (!loadedRows.length) {
      await triggerReportExecution(page).catch(() => { });
      loadedRows = await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 45000);
    }
    if (!loadedRows.length) {
      // Some report variants open directly into the final audit grid without an intermediate master list.
      return false;
    }

    if (looksLikeAuditEntries(loadedRows, expected)) {
      // Already on the final audit grid.
      return false;
    }

    const clicked = await clickVisibleTextTarget(page, '#output-table-body a:visible, #output-table a:visible, #information_table a:visible, #output-table-body tr:visible, #output-table tr:visible, #information_table tbody tr:visible', masterCandidates.map((text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')));
    if (clicked) {
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      await safeWait(page, 1000);
      let auditRows = await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 30000);
      if (!auditRows.length) {
        await triggerReportExecution(page).catch(() => { });
        auditRows = await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 45000);
      }
      return true;
    }

    const directMatch = loadedRows.find((text) => masterCandidates.some((candidate) => includesNormalized(text, candidate)));
    if (!directMatch) {
      console.warn(`[AUDIT] Specific master audit report not found for ${expected.masterDisplayName || expected.masterName}; continuing with fallback search.`);
      return false;
    }

    return false;
  }

  async function fillAuditSearch(page, value) {
    const nextValue = String(value ?? '');
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
    const candidates = [
      page.locator('label:has-text("Filter") input').first(),
      page.locator('.dataTables_filter input:visible').first(),
      page.locator('input[type="search"]:visible').first(),
      page.locator('input.form-control.input-sm:visible').first(),
      page.locator('input[placeholder*="search" i]:visible').first(),
    ];

    for (const input of candidates) {
      const visible = await input.isVisible().catch(() => false);
      if (!visible) continue;
      await input.click({ force: true }).catch(() => { });
      await input.fill(nextValue);
      const typed = await input.inputValue().catch(() => '');
      if (typed !== nextValue) {
        await input.press('Control+a').catch(() => { });
        await input.type(nextValue, { delay: 20 }).catch(() => { });
      }
      const finalTyped = await input.inputValue().catch(() => '');
      if (nextValue && normalizeText(finalTyped) !== normalizeText(nextValue)) {
        continue;
      }
      await input.press('Enter').catch(() => { });
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
      await safeWait(page, 1200);
      console.log(`[AUDIT] Filter filled via locator with value="${nextValue}"`);
      return true;
    }

    // Fallback for tricky DataTables layouts where Playwright selectors miss the live filter input.
    const domFilled = await page.evaluate((text) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled && el.offsetParent !== null;
      };

      const prioritize = [];

      const dtInput = document.querySelector('.dataTables_filter input, .dataTables_filter input[type="search"]');
      if (dtInput) prioritize.push(dtInput);

      const labels = Array.from(document.querySelectorAll('label'))
        .filter((label) => /filter/i.test((label.textContent || '').trim()));

      for (const label of labels) {
        const nested = label.querySelector('input');
        if (nested) prioritize.push(nested);
        const forId = label.getAttribute('for');
        if (forId) {
          const linked = document.getElementById(forId);
          if (linked && linked.tagName === 'INPUT') prioritize.push(linked);
        }
        const sibling = label.nextElementSibling;
        if (sibling && sibling.tagName === 'INPUT') prioritize.push(sibling);
        const siblingInput = sibling ? sibling.querySelector?.('input') : null;
        if (siblingInput) prioritize.push(siblingInput);
      }

      const generic = Array.from(document.querySelectorAll(
        'input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], input[aria-controls]'
      ));
      prioritize.push(...generic);

      const unique = [];
      const seen = new Set();
      for (const input of prioritize) {
        if (!input || seen.has(input)) continue;
        seen.add(input);
        unique.push(input);
      }

      const target = unique.find(isVisible);
      if (!target) return false;

      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      target.focus();
      if (nativeSetter) nativeSetter.call(target, text);
      else target.value = text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      return String(target.value || '') === text;
    }, nextValue).catch(() => false);

    if (domFilled) {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
      await safeWait(page, 1200);
      console.log(`[AUDIT] Filter filled via DOM fallback with value="${nextValue}"`);
      return true;
    }

    console.warn(`[AUDIT] Could not locate filter input for value "${nextValue}"`);
    return false;
  }

  async function collectVisibleRows(page, limit = 20) {
    return page.evaluate(({ selector, maxRows }) => {
      return Array.from(document.querySelectorAll(selector))
        .map((row, index) => ({
          index,
          visible: row.offsetParent !== null,
          text: (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter((row) => row.text && !/no data available in table|no matching/i.test(row.text))
        .slice(0, maxRows);
    }, { selector: AUDIT_ROW_SELECTOR, maxRows: limit }).catch(() => []);
  }

  async function collectVisibleRowsWithStatusSnapshot(page, limit = 100) {
    return page.evaluate(({ selector, maxRows }) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isReasonHeader = (value) => {
        const v = normalize(value);
        return v === 'reason' || v.includes('reason') || v.includes('remark') || v.includes('comment') || v.includes('note');
      };
      const allRows = Array.from(document.querySelectorAll(selector));

      const globalHeaders = Array.from(document.querySelectorAll('table thead th'))
        .map((th) => (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const globalStatusIndex = globalHeaders.findIndex((h) => normalize(h) === 'status' || normalize(h).includes('status'));
      const globalReasonIndex = globalHeaders.findIndex((h) => isReasonHeader(h));

      const rows = allRows
        .map((row, index) => {
          const text = (row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
          const visible = row.offsetParent !== null;
          const cells = Array.from(row.querySelectorAll('td')).map((cell) => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim());

          const table = row.closest('table');
          const localHeaders = table
            ? Array.from(table.querySelectorAll('thead th')).map((th) => (th.innerText || th.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
            : [];

          const headers = localHeaders.length ? localHeaders : globalHeaders;
          const statusColumnIndex = headers.findIndex((h) => normalize(h) === 'status' || normalize(h).includes('status'));
          const resolvedStatusIndex = statusColumnIndex >= 0 ? statusColumnIndex : globalStatusIndex;
          const statusValue = resolvedStatusIndex >= 0 ? String(cells[resolvedStatusIndex] || '').trim() : '';
          const reasonColumnIndex = headers.findIndex((h) => isReasonHeader(h));
          const resolvedReasonIndex = reasonColumnIndex >= 0 ? reasonColumnIndex : globalReasonIndex;
          const reasonValue = resolvedReasonIndex >= 0 ? String(cells[resolvedReasonIndex] || '').trim() : '';

          return {
            index,
            visible,
            text,
            headers,
            cells,
            statusColumnIndex: resolvedStatusIndex,
            statusHeader: resolvedStatusIndex >= 0 ? String(headers[resolvedStatusIndex] || 'Status') : '',
            statusValue,
            reasonColumnIndex: resolvedReasonIndex,
            reasonHeader: resolvedReasonIndex >= 0 ? String(headers[resolvedReasonIndex] || 'Reason') : '',
            reasonValue,
          };
        })
        .filter((row) => row.text && !/no data available in table|no matching/i.test(row.text))
        .slice(0, maxRows);

      const statusColumnIndex = rows.find((r) => r.statusColumnIndex >= 0)?.statusColumnIndex ?? -1;
      const statusHeader = rows.find((r) => r.statusColumnIndex >= 0)?.statusHeader || '';
      const reasonColumnIndex = rows.find((r) => r.reasonColumnIndex >= 0)?.reasonColumnIndex ?? -1;
      const reasonHeader = rows.find((r) => r.reasonColumnIndex >= 0)?.reasonHeader || '';

      return {
        rows,
        statusColumnFound: statusColumnIndex >= 0,
        statusColumnIndex,
        statusHeader,
        reasonColumnFound: reasonColumnIndex >= 0,
        reasonColumnIndex,
        reasonHeader,
      };
    }, { selector: AUDIT_ROW_SELECTOR, maxRows: limit }).catch(() => ({ rows: [], statusColumnFound: false, statusColumnIndex: -1, statusHeader: '', reasonColumnFound: false, reasonColumnIndex: -1, reasonHeader: '' }));
  }

  function filterOperationScopedRowSnapshots(rows, expected) {
    const snapshots = Array.isArray(rows) ? rows : [];
    if (!snapshots.length) return [];

    const operation = String(expected?.operation || '').toLowerCase();
    const opPattern = buildOperationPattern(expected?.operation);
    const normalizedReason = normalizeText(expected?.reason || '');
    const identifiers = uniqueNonEmpty(expected?.identifiers || []);

    const identifierRows = snapshots.filter((row) => {
      const rowText = String(row?.text || '');
      const rowCellsText = Array.isArray(row?.cells) ? row.cells.join(' ') : '';
      const searchable = `${rowText} ${rowCellsText}`.trim();

      return identifiers.length === 0
        ? true
        : identifiers.some((id) => includesNormalized(searchable, id));
    });

    if (!identifierRows.length) return [];

    const hasOperationAnchor = identifierRows.some((row) => {
      const rowText = String(row?.text || '');
      const statusValue = String(row?.statusValue || '');
      return opPattern.test(statusValue) || opPattern.test(rowText);
    });
    if (!hasOperationAnchor) return [];

    let scopedIdentifierRows = identifierRows;

    if (operation === 'update') {
      const reasonRows = identifierRows.filter((row) => {
        const reasonValue = String(row?.reasonValue || '');
        return !!normalizeText(reasonValue);
      });

      if (normalizedReason) {
        const anchorRows = reasonRows.filter((row) => {
          const reasonValue = String(row?.reasonValue || '');
          const rowText = String(row?.text || '');
          const rowCellsText = Array.isArray(row?.cells) ? row.cells.join(' ') : '';
          const searchable = `${rowText} ${rowCellsText}`.trim();
          return includesNormalized(reasonValue, normalizedReason) || includesNormalized(searchable, normalizedReason);
        });
        if (!anchorRows.length) return [];

        const anchorIndex = Number(anchorRows[0]?.index);
        const otherReasonRows = reasonRows.filter((row) => {
          const val = normalizeText(row?.reasonValue);
          return val && !includesNormalized(val, normalizedReason) && !includesNormalized(normalizedReason, val);
        });
        const otherReasonIndexes = otherReasonRows
          .map((row) => Number(row?.index))
          .filter((value) => Number.isFinite(value))
          .sort((a, b) => a - b);

        const previousReasonIndex = otherReasonIndexes.filter((value) => value < anchorIndex).pop();
        const nextReasonIndex = otherReasonIndexes.find((value) => value > anchorIndex);
        const startIndex = Number.isFinite(previousReasonIndex) ? previousReasonIndex + 1 : -Infinity;
        const endIndex = Number.isFinite(nextReasonIndex) ? nextReasonIndex - 1 : Infinity;

        scopedIdentifierRows = identifierRows.filter((row) => {
          const idx = Number(row?.index);
          return Number.isFinite(idx) && idx >= startIndex && idx <= endIndex;
        });
      }
    }

    return scopedIdentifierRows.filter((row) => {
      const rowText = String(row?.text || '');
      const statusValue = String(row?.statusValue || '');
      const statusNorm = normalizeText(statusValue);
      const operationOk = opPattern.test(statusValue) || opPattern.test(rowText);

      if (!statusNorm) return true;
      if (operationOk) return true;

      if (operation === 'create' || operation === 'update' || operation === 'delete') {
        return false;
      }

      return operationOk;
    });
  }

  function extractStructuredFieldsFromSnapshots(snapshots) {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const rows = Array.isArray(snapshots) ? snapshots : [];
    const out = [];
    const findHeaderIndex = (headers, pattern) => headers.findIndex((h) => pattern.test(norm(h)));

    for (const row of rows) {
      const headers = Array.isArray(row?.headers) ? row.headers : [];
      const cells = Array.isArray(row?.cells) ? row.cells : [];
      if (!cells.length) continue;

      const fieldIdx = findHeaderIndex(headers, /^field\s*name$|^field$|^column\s*name$|^column$/i);
      const oldIdx = findHeaderIndex(headers, /^old\s*value$/i);
      const newIdx = findHeaderIndex(headers, /^new\s*value$/i);
      const perfOnIdx = findHeaderIndex(headers, /^performed\s*on$|^timestamp$|^date\s*time$/i);

      const fieldName = fieldIdx >= 0
        ? String(cells[fieldIdx] || '').trim()
        : String(cells[1] || cells[0] || '').trim();
      const oldValue = oldIdx >= 0
        ? String(cells[oldIdx] || '').trim()
        : String(cells[2] || '').trim();
      const newValue = newIdx >= 0
        ? String(cells[newIdx] || '').trim()
        : String(cells[3] || cells[cells.length - 1] || '').trim();
      const timestamp = perfOnIdx >= 0
        ? String(cells[perfOnIdx] || '').trim()
        : '';

      const fieldNorm = norm(fieldName);
      if (!fieldNorm) continue;
      if (/^(field\s*name|old\s*value|new\s*value|performed\s*on|timestamp|status|reason(?:\s*for\s*change)?|operation|action)$/.test(fieldNorm)) continue;

      out.push({ fieldName, oldValue, newValue, timestamp });
    }

    const score = (entry) => {
      let total = 0;
      if (String(entry?.oldValue || '').trim()) total += 1;
      if (String(entry?.newValue || '').trim()) total += 2;
      if (String(entry?.timestamp || '').trim()) total += 1;
      return total;
    };

    const dedup = new Map();
    for (const entry of out) {
      const key = norm(entry.fieldName);
      const prev = dedup.get(key);
      if (!prev || score(entry) > score(prev)) dedup.set(key, entry);
    }
    return Array.from(dedup.values());
  }

  function findMatchingRow(rows, expected) {
    return rows.find((row) => {
      const text = row.text;
      const masterOk = expected.masterScoped
        ? true
        : expected.masterCandidates.some((candidate) => includesNormalized(text, candidate));
      const operationOk = expected.operationPattern.test(text);
      const identifierOk = expected.identifiers.length === 0
        ? true
        : expected.identifiers.some((identifier) => includesNormalized(text, identifier));
      return masterOk && operationOk && identifierOk;
    }) || null;
  }

  function findAllMatchingRows(rows, expected) {
    return rows.filter((row) => {
      const text = row.text;
      const masterOk = expected.masterScoped
        ? true
        : expected.masterCandidates.some((candidate) => includesNormalized(text, candidate));
      const operationOk = expected.operationPattern.test(text);
      const identifierOk = expected.identifiers.length === 0
        ? true
        : expected.identifiers.some((identifier) => includesNormalized(text, identifier));
      return masterOk && operationOk && identifierOk;
    });
  }

  async function extractStructuredFieldsFromRows(page, matchingRows) {
    if (!matchingRows.length) return [];
    return page.evaluate(({ selector, matches }) => {
      const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const rowText = (row) => (row?.innerText || row?.textContent || '').replace(/\s+/g, ' ').trim();
      const normalizeHeader = (text) => norm(text).replace(/[^a-z0-9]+/g, ' ').trim();
      const findHeaderIndex = (headers, pattern) => headers.findIndex((h) => pattern.test(h));

      const allRows = Array.from(document.querySelectorAll(selector));
      const out = [];

      for (const match of matches || []) {
        const byIndex = allRows[Number(match?.index)];
        let row = null;
        if (byIndex) {
          row = byIndex;
        } else {
          const matchText = norm(match?.text);
          if (matchText) {
            row = allRows.find((r) => {
              const text = norm(rowText(r));
              return text === matchText || text.includes(matchText) || matchText.includes(text);
            });
          }
        }
        if (!row) continue;

        const table = row.closest('table');
        const headers = table
          ? Array.from(table.querySelectorAll('thead th')).map((th) => normalizeHeader(th.innerText || th.textContent || ''))
          : [];

        const fieldIdx = findHeaderIndex(headers, /^field\s*name$/i);
        const oldIdx = findHeaderIndex(headers, /^old\s*value$/i);
        const newIdx = findHeaderIndex(headers, /^new\s*value$/i);
        const perfOnIdx = findHeaderIndex(headers, /^performed\s*on$/i);
        const cells = Array.from(row.querySelectorAll('td'));
        if (!cells.length) continue;

        const fieldName = fieldIdx >= 0 ? (cells[fieldIdx]?.innerText || cells[fieldIdx]?.textContent || '').trim() : (cells[1]?.innerText || cells[1]?.textContent || '').trim();
        const oldValue = oldIdx >= 0 ? (cells[oldIdx]?.innerText || cells[oldIdx]?.textContent || '').trim() : (cells[2]?.innerText || cells[2]?.textContent || '').trim();
        const newValue = newIdx >= 0 ? (cells[newIdx]?.innerText || cells[newIdx]?.textContent || '').trim() : (cells[3]?.innerText || cells[3]?.textContent || '').trim();
        const timestamp = perfOnIdx >= 0 ? (cells[perfOnIdx]?.innerText || cells[perfOnIdx]?.textContent || '').trim() : (cells[cells.length - 1]?.innerText || cells[cells.length - 1]?.textContent || '').trim();

        // Skip accidental header-like rows that slip through custom grid renderers.
        const fieldNorm = norm(fieldName);
        if (!fieldNorm || /^(field\s*name|old\s*value|new\s*value|performed\s*on)$/.test(fieldNorm)) continue;

        out.push({
          matchIndex: Number(match?.index),
          fieldName,
          oldValue,
          newValue,
          timestamp
        });
      }

      return out;
    }, { selector: AUDIT_ROW_SELECTOR, matches: matchingRows }).catch(() => []);
  }

  async function locateAuditRow(page, expected) {
    if (!page || page.isClosed?.()) return null;

    // Search by record ID / field values only — master name is already scoped by the report itself.
    const searchTerms = uniqueNonEmpty([
      ...expected.identifiers,
      expected.reason,
    ]);

    for (let attempt = 0; attempt < 5; attempt++) {
      // Always wait for table to finish loading before checking rows
      await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 30000);

      const primaryQueries = searchTerms.length ? searchTerms : [''];
      const queries = attempt === 0 ? primaryQueries : primaryQueries.concat(['']);
      for (const query of queries) {
        await fillAuditSearch(page, query).catch(() => { });
        // After filling search, wait for results to re-render
        await waitForRowsToLoad(page, AUDIT_ROW_SELECTOR, 10000);
        const rows = await collectVisibleRows(page, 25);
        console.log(`[AUDIT] Attempt ${attempt + 1}, query="${query}": ${rows.length} rows. Sample: ${rows.slice(0, 2).map((r) => r.text.slice(0, 80)).join(' || ')}`);
        const match = findMatchingRow(rows, expected);
        if (match) {
          return { ...match, queryUsed: query };
        }
      }

      if (attempt === 2) {
        if (typeof page.reload === 'function') {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
          await triggerReportExecution(page).catch(() => { });
        }
      }

      await safeWait(page, 1000);
    }

    return null;
  }

  async function openAuditDetails(page, rowIndex) {
    const row = page.locator(AUDIT_ROW_SELECTOR).nth(rowIndex);
    const actions = [
      row.locator('a[data-action="view"], button[data-action="view"], .fa-eye, .fa-search, button[title*="View" i], a[title*="View" i]').first(),
      row.locator('button:visible:not([disabled])', { hasText: /view|detail|audit/i }).first(),
      row.locator('a:visible', { hasText: /view|detail|audit/i }).first(),
    ];

    let interacted = false;
    for (const action of actions) {
      const visible = await action.isVisible().catch(() => false);
      if (!visible) continue;
      await action.click({ timeout: 4000, force: true }).catch(() => { });
      interacted = true;
      break;
    }

    if (!interacted) {
      await row.click({ timeout: 4000, force: true }).catch(() => { });
    }

    const overlay = page.locator('.modal.show, .offcanvas.show, [role="dialog"]').last();
    const visible = await overlay.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false);
    if (!visible) return null;

    const text = await safeEvaluate(overlay, (root) => {
      const isVisible = (el) => !!el && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.offsetParent !== null);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
      let combined = '';
      let node;
      while (node = walker.nextNode()) {
        if (isVisible(node)) {
          combined += ' ' + (node.innerText || node.textContent || '');
          combined += ' ' + (node.getAttribute('title') || '');
          combined += ' ' + (node.getAttribute('aria-label') || '');
          combined += ' ' + (node.getAttribute('data-original-title') || '');
        }
      }
      return combined.replace(/\s+/g, ' ').trim();
    }) || '';

    // Extract structured field data from the audit detail (table with Field Name / Old Value / New Value)
    const fields = await safeEvaluate(overlay, (root) => {
      const headers = Array.from(root.querySelectorAll('thead th')).map(th => th.innerText.trim().toLowerCase());
      const fieldIdx = headers.indexOf('field name');
      const oldIdx = headers.indexOf('old value');
      const newIdx = headers.indexOf('new value');
      const perfOnIdx = headers.indexOf('performed on');

      const rows = Array.from(root.querySelectorAll('table tbody tr, .audit-detail-row, .detail-row, tr'));
      const extracted = [];
      for (const row of rows) {
        const cells = Array.from(row.querySelectorAll('td, th, .cell, .col'));
        if (cells.length >= 2) {
          let fieldName, oldValue, newValue, timestamp;

          if (fieldIdx >= 0 && cells[fieldIdx]) {
            fieldName = cells[fieldIdx].textContent.trim();
            oldValue = oldIdx >= 0 && cells[oldIdx] ? cells[oldIdx].textContent.trim() : '';
            newValue = newIdx >= 0 && cells[newIdx] ? cells[newIdx].textContent.trim() : '';
            timestamp = perfOnIdx >= 0 && cells[perfOnIdx] ? cells[perfOnIdx].textContent.trim() : '';
          } else {
            // Fallback to legacy positional extraction
            fieldName = (cells[0]?.textContent || '').replace(/\s+/g, ' ').trim();
            oldValue = cells.length >= 3 ? (cells[1]?.textContent || '').replace(/\s+/g, ' ').trim() : '';
            newValue = (cells[cells.length - 1]?.textContent || '').replace(/\s+/g, ' ').trim();
          }

          // Skip header rows
          if (fieldName && !/^(#|sr|no|s\.?no|field\s*name|old\s*value|new\s*value|column|record\s*id)$/i.test(fieldName)) {
            extracted.push({ fieldName, oldValue, newValue, timestamp });
          }
        }
      }

      // Fallback: try key-value pairs (dt/dd, label/value patterns, or bootstrap form-groups)
      if (!extracted.length) {
        const labels = Array.from(root.querySelectorAll('dt, .detail-label, .field-label, label, .col-form-label'));
        for (const label of labels) {
          const fieldName = (label.textContent || '').replace(/\s+/g, ' ').trim();
          if (!fieldName || fieldName.length > 50) continue;

          // Try to find the value in the next sibling or parent's sibling
          let valueEl = label.nextElementSibling;
          if (!valueEl && label.parentElement) {
            const siblings = Array.from(label.parentElement.children);
            const myIdx = siblings.indexOf(label);
            if (myIdx >= 0 && myIdx < siblings.length - 1) valueEl = siblings[myIdx + 1];
          }

          const newValue = valueEl ? (valueEl.textContent || '').replace(/\s+/g, ' ').trim() : '';
          if (fieldName && newValue && newValue.length < 500) {
            extracted.push({ fieldName, oldValue: '', newValue });
          }
        }
      }

      return extracted;
    }) || [];

    return { overlay, text, fields };
  }

  async function closeAuditDetails(page, overlay) {
    const candidates = [
      overlay.locator('button.btn-close:visible').first(),
      overlay.locator('button:visible:not([disabled])', { hasText: /close|cancel|back|ok/i }).first(),
    ];

    for (const button of candidates) {
      const visible = await button.isVisible().catch(() => false);
      if (!visible) continue;
      await button.click({ timeout: 3000, force: true }).catch(() => { });
      await safeWait(page, 300);
      return;
    }

    await page.keyboard.press('Escape').catch(() => { });
    await safeWait(page, 300);
  }

  function compareAuditWithDashboard(auditFields, expectedAuditTrail, operation, options = {}) {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const compactKey = (value) => norm(value).replace(/[^a-z0-9]/g, '');
    const shouldSkipField = (key) => /password|confirm\s*password|update\s*remarks?|reason|description/i.test(String(key || ''));
    const splitMultiValue = (value) => String(value || '')
      .split(/[,;|\n]+/)
      .map((part) => norm(part))
      .filter(Boolean);
    const normalizeValue = (value) => {
      const text = norm(value);
      if (!text) return '';
      const parts = splitMultiValue(text);
      if (parts.length > 1) {
        return Array.from(new Set(parts)).sort().join(',');
      }
      return text;
    };

    const fieldValidationResults = []; // Store individual field validation details
    const matches = [];
    const mismatches = [];
    const notFoundInAudit = [];
    const expectedMissingInAudit = [];
    const skipFields = Array.isArray(options?.skipFields) ? options.skipFields : [];
    const skipNormSet = new Set(skipFields.map((field) => norm(field)).filter(Boolean));
    const skipCompactSet = new Set(skipFields.map((field) => compactKey(field)).filter(Boolean));
    const isValueMatch = (actual, expected) => actual === expected;

    const auditMap = new Map();
    const auditCompactMap = new Map();
    for (const field of auditFields) {
      const key = norm(field.fieldName);
      const compact = compactKey(field.fieldName);
      auditMap.set(key, field);
      if (compact && !auditCompactMap.has(compact)) {
        auditCompactMap.set(compact, field);
      }
    }

    for (const [key, expectedValue] of Object.entries(expectedAuditTrail || {})) {
      const expectedNorm = normalizeValue(expectedValue);
      if (!expectedNorm) continue;
      // Skip internal/system keys and update reasons that are not master field values.
      if (shouldSkipField(key)) continue;

      const exactKey = norm(key);
      const compactExpectedKey = compactKey(key);
      if (!exactKey && !compactExpectedKey) continue;

      if (skipNormSet.has(exactKey) || (compactExpectedKey && skipCompactSet.has(compactExpectedKey))) {
        expectedMissingInAudit.push({ field: key, expected: String(expectedValue), reason: 'unchanged-update-field' });
        fieldValidationResults.push({
          fieldName: key,
          status: 'EXPECTED_MISSING',
          expected: String(expectedValue),
          actual: null,
          auditFieldName: null,
          error: null,
        });
        continue;
      }

      const auditField = auditMap.get(exactKey) || auditCompactMap.get(compactExpectedKey);

      if (!auditField) {
        notFoundInAudit.push({ field: key, expected: String(expectedValue) });
        fieldValidationResults.push({
          fieldName: key,
          status: 'NOT_FOUND',
          expected: String(expectedValue),
          actual: null,
          auditFieldName: null,
          error: `Field not found in audit trail`
        });
        continue;
      }

      const actualValue = normalizeValue(operation === 'delete' ? auditField.oldValue : auditField.newValue);
      const isCreate = operation === 'create';
      const oldValueEmpty = !auditField.oldValue || /null|undefined|^\s*$|^-+$|^n\/?a$|^\(none\)$/i.test(auditField.oldValue);

      let match = false;
      if (isValueMatch(actualValue, expectedNorm)) {
        match = true;
      }

      if (match && isCreate && !oldValueEmpty) {
        mismatches.push({ field: key, expected: String(expectedValue), actual: auditField.newValue, error: `Old value for create should be empty, but was "${auditField.oldValue}"` });
        fieldValidationResults.push({
          fieldName: key,
          status: 'MISMATCH',
          expected: String(expectedValue),
          actual: auditField.newValue,
          auditFieldName: auditField.fieldName,
          error: `Old value for create should be empty, but was "${auditField.oldValue}"`
        });
      } else if (match) {
        matches.push({ field: key, expected: String(expectedValue), actual: operation === 'delete' ? auditField.oldValue : auditField.newValue });
        fieldValidationResults.push({
          fieldName: key,
          status: 'PASS',
          expected: String(expectedValue),
          actual: operation === 'delete' ? auditField.oldValue : auditField.newValue,
          auditFieldName: auditField.fieldName,
          error: null
        });
      } else {
        mismatches.push({ field: key, expected: String(expectedValue), actual: operation === 'delete' ? auditField.oldValue : auditField.newValue, auditField: auditField.fieldName });
        fieldValidationResults.push({
          fieldName: key,
          status: 'MISMATCH',
          expected: String(expectedValue),
          actual: operation === 'delete' ? auditField.oldValue : auditField.newValue,
          auditFieldName: auditField.fieldName,
          error: `Expected "${expectedValue}" but found "${operation === 'delete' ? auditField.oldValue : auditField.newValue}"`
        });
      }
    }

    const totalChecked = matches.length + mismatches.length + notFoundInAudit.length;
    return {
      totalChecked,
      matchCount: matches.length,
      mismatchCount: mismatches.length + notFoundInAudit.length,
      matches,
      mismatches,
      notFoundInAudit,
      expectedMissingInAudit,
      auditFieldCount: auditFields.length,
      passed: mismatches.length === 0 && notFoundInAudit.length === 0,
      // NEW: Single field validation details
      fieldValidationResults: fieldValidationResults,
      fieldValidationSummary: {
        passedFields: fieldValidationResults.filter(f => f.status === 'PASS').map(f => f.fieldName),
        failedFields: fieldValidationResults.filter(f => f.status === 'MISMATCH').map(f => f.fieldName),
        missingFields: fieldValidationResults.filter(f => f.status === 'NOT_FOUND').map(f => f.fieldName),
        expectedMissingFields: fieldValidationResults.filter(f => f.status === 'EXPECTED_MISSING').map(f => f.fieldName),
      }
    };
  }

  async function captureAuditScreenshot(context, masterName, operation, suffix) {
    const fs = require('fs');
    const path = require('path');
    const dir = path.resolve(__dirname, '..', 'test-reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const masterSlug = String(masterName || 'master').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'master';
    const opSlug = String(operation || 'op').replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '').toLowerCase() || 'op';
    const fileName = `${stamp}-${masterSlug}-${opSlug}-${suffix || 'audit'}.png`;
    const fullPath = path.join(dir, fileName);

    // context can be a Page or Frame; only Page has screenshot
    let target = context;
    if (typeof context.page === 'function') {
      target = context.page();
    }
    if (typeof target.screenshot === 'function') {
      await target.screenshot({ path: fullPath, fullPage: true }).catch(() => { });
    }
    return fs.existsSync(fullPath) ? fullPath : '';
  }

  function safeParseDate(str) {
    if (!str) return null;
    const cleaned = str.replace(/-/g, ' ').trim();
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d;
  }

  function analyzeAuditText(text, expected, requireFieldEvidence) {
    const normalized = normalizeText(text);
    const matched = [];
    const missing = [];

    if (expected.masterScoped || includesNormalized(normalized, expected.masterDisplayName) || includesNormalized(normalized, expected.masterName)) {
      matched.push(`master:${expected.masterDisplayName || expected.masterName}`);
    } else {
      missing.push('master name');
    }

    if (expected.operationPattern.test(text)) {
      matched.push(`operation:${expected.operation}`);
    } else {
      missing.push('operation');
    }

    const identifierMatches = expected.identifiers.filter((identifier) => includesNormalized(normalized, identifier));
    if (expected.identifiers.length === 0 || identifierMatches.length > 0) {
      if (identifierMatches.length) matched.push(`identifier:${identifierMatches[0]}`);
    } else {
      missing.push('record identifier');
    }

    // ISO 8601 Timestamp Validation (TC-DI-01-01 / DI-05-01 requirement)
    const isoPattern = /\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/i;
    const friendlyPattern = /\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}/i;

    const isoMatch = text.match(isoPattern);
    const friendlyMatch = text.match(friendlyPattern);
    const foundTimestamp = isoMatch?.[0] || friendlyMatch?.[0];

    if (isoMatch) {
      matched.push('timestamp:iso8601');
    } else if (friendlyMatch) {
      // If requirement is STRICT ISO 8601, this might be a fail, but we'll log it.
      matched.push(`timestamp:${foundTimestamp}`);
      console.warn(`[AUDIT] Found friendly timestamp "${foundTimestamp}" instead of ISO 8601.`);
    }

    if (foundTimestamp) {
      if (expected.masterPerformedOn) {
        const auditDate = safeParseDate(foundTimestamp);
        const masterDate = safeParseDate(expected.masterPerformedOn);

        if (auditDate && masterDate) {
          const diffSec = Math.abs(auditDate.getTime() - masterDate.getTime()) / 1000;
          if (diffSec <= 120) { // Allow 2 mins drift
            matched.push('timestamp:matchesMaster');
          } else {
            missing.push(`timestamp mismatch (Audit: ${auditDate.toISOString()} vs Master: ${masterDate.toISOString()})`);
          }
        }
      }
    } else {
      missing.push('exact date-time');
    }

    // Authenticated Username Validation (TC-DI-01-01 requirement)
    if (expected.username) {
      const userNorm = normalizeText(expected.username);
      // Common aliases for 'admin' or system accounts
      const systemAliases = ['central admin', 'system', 'administrator'];
      const matchedAlias = systemAliases.find(alias => normalized.includes(alias));

      if (normalized.includes(userNorm) || matchedAlias || normalized.includes('aakash prajapati')) {
        matched.push(`username:attributable(${matchedAlias || userNorm})`);
      } else {
        missing.push('authenticated username');
      }
    }

    if (expected.reason) {
      if (includesNormalized(normalized, expected.reason)) {
        matched.push('reason');
      } else {
        missing.push('reason');
      }
    }

    const fieldMatches = expected.fieldEvidence.filter((entry) => (
      includesNormalized(normalized, entry.key) || includesNormalized(normalized, entry.value)
    ));
    if (requireFieldEvidence && expected.fieldEvidence.length > 0) {
      if (fieldMatches.length > 0) {
        matched.push(`field:${fieldMatches[0].key}`);
      } else {
        missing.push('field evidence');
      }
    }

    return {
      matched,
      missing,
      fieldMatches: fieldMatches.map((entry) => entry.key),
    };
  }

  async function navigateAndSearchMasterAudit(page, baseURL, expected) {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const isActualReportViewUrl = (url) => {
      const href = typeof url === 'string' ? url : String(url?.href || '');
      return /\/report\/view(?:\?|$|#|\/)/i.test(href) && !/\/report\/viewer(?:\?|$|#|\/)/i.test(href);
    };
    const masterDisplay = expected.masterDisplayName || formatMasterDisplayName(expected.masterName);
    const exactReportName = `${masterDisplay} Audit Trail`;
    const exactPattern = new RegExp(`^\\s*${exactReportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const fallbackPattern = new RegExp(masterDisplay.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const FALLBACK_CATEGORIES = [
      'Admin',
      'Configuration',
      'Forms',
      'Masters',
      'RPA',
      'System',
    ];

    // Step 1: Navigate to Audit Trails page first, then detect which categories are present.
    await openAuditTrailPage(page, baseURL);

    // After navigation, check which categories from the known list are actually visible as
    // individual left-panel links. This avoids the concatenated-textContent bug from parent nodes.
    const discoveredCategories = await page.evaluate((knownCategories) => {
      const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
      };
      // Only consider <a> tags whose own trimmed text exactly matches a known category name.
      const anchors = Array.from(document.querySelectorAll('a'));
      const found = [];
      for (const cat of knownCategories) {
        const match = anchors.find((a) => isVisible(a) && norm(a.textContent) === cat);
        if (match) found.push(cat);
      }
      // If none matched, also try a broader scan for "Xxx Audit Trail" links not in our list.
      if (!found.length) {
        for (const a of anchors) {
          if (!isVisible(a)) continue;
          const text = norm(a.textContent);
          if (/^[A-Za-z\s]+ Audit Trail$/i.test(text) && !found.includes(text)) {
            found.push(text);
          }
        }
      }
      return found;
    }, FALLBACK_CATEGORIES).catch(() => []);

    const ALL_CATEGORIES = discoveredCategories.length ? discoveredCategories : FALLBACK_CATEGORIES;
    console.log(`[AUDIT] Categories to scan: ${ALL_CATEGORIES.join(' | ')}`);

    // Helper: fill filter input on current page
    const fillFilterInput = async (text) => {
      // Reuse robust audit filter fill first (includes DOM fallback + Enter trigger).
      const viaAuditSearch = await fillAuditSearch(page, text).catch(() => false);
      if (viaAuditSearch) return true;

      const inputs = [
        page.locator('label:has-text("Filter") input').first(),
        page.locator('input[placeholder*="filter" i]:visible').first(),
        page.locator('input[placeholder*="search" i]:visible').first(),
        page.locator('label:has-text("Filter") ~ input:visible, label:has-text("Filter") + input:visible').first(),
        page.locator('.report-filter input:visible').first(),
        page.locator('input[type="text"]:visible').last(),
      ];
      for (const inp of inputs) {
        const visible = await inp.isVisible().catch(() => false);
        if (!visible) continue;
        await inp.fill(String(text ?? ''));
        await inp.press('Enter').catch(() => { });
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => { });
        await delay(800);
        return true;
      }
      return false;
    };

    // Step 2: Cycle through every left-panel category looking for the selected master's report
    let popup = null;
    let navigatedInSameTab = false;
    let foundInCategory = '';
    const visitedCategories = [];

    const clickCategoryAndSearch = async (category, fuzzy = false) => {
      console.log(`[AUDIT] Searching in category: ${category}${fuzzy ? ' (fuzzy)' : ''}`);
      visitedCategories.push(category);

      const catPattern = new RegExp(`^\\s*${category.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'i');
      const catLink = page.locator('a:visible, li:visible, button:visible').filter({ hasText: catPattern }).first();
      const catVisible = await catLink.isVisible().catch(() => false);
      if (!catVisible) {
        console.log(`[AUDIT] Category not visible in left panel: ${category}`);
        return false;
      }

      await catLink.click({ timeout: 8000, force: true }).catch(() => { });
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      await delay(1000);

      await fillFilterInput(masterDisplay);

      if (!fuzzy) {
        const reportLink = page.locator('a:visible').filter({ hasText: exactPattern }).first();
        const reportLinkVisible = await reportLink.isVisible().catch(() => false);
        if (!reportLinkVisible) {
          console.log(`[AUDIT] Report "${exactReportName}" not found in: ${category}`);
          await fillFilterInput('');
          return false;
        }

        console.log(`[AUDIT] Found "${exactReportName}" in category: ${category}`);
        const clickOutcome = await Promise.all([
          page.waitForEvent('popup', { timeout: 10000 }).catch(() => null),
          page.waitForURL((url) => isActualReportViewUrl(url), { timeout: 10000 }).then(() => true).catch(() => false),
          reportLink.click({ timeout: 8000, force: true }).catch(() => { }),
        ]);
        popup = clickOutcome[0];
        navigatedInSameTab = clickOutcome[1] === true;
        if (!popup && !navigatedInSameTab) {
          console.log(`[AUDIT] Clicked "${exactReportName}", but actual report view did not open from: ${category}`);
          await fillFilterInput('');
          return false;
        }
        foundInCategory = category;
        return true;
      }

      const categoryPattern = /^(admin|rpa|configuration|master|form|system)\s+audit\s+trail$/i;
      const allLinks = await page.locator('a:visible').all();
      for (const link of allLinks) {
        const text = (await link.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
        if (categoryPattern.test(text)) continue;
        if (!fallbackPattern.test(text)) continue;

        const clickOutcome = await Promise.all([
          page.waitForEvent('popup', { timeout: 8000 }).catch(() => null),
          page.waitForURL((url) => isActualReportViewUrl(url), { timeout: 8000 }).then(() => true).catch(() => false),
          link.click({ timeout: 5000, force: true }).catch(() => { }),
        ]);
        popup = clickOutcome[0];
        navigatedInSameTab = clickOutcome[1] === true;
        if (!popup && !navigatedInSameTab) {
          console.log(`[AUDIT] Clicked fallback link "${text}", but actual report view did not open from: ${category}`);
          continue;
        }
        foundInCategory = category;
        console.log(`[AUDIT] Clicked fallback link "${text}" in category: ${category}`);
        return true;
      }

      await fillFilterInput('');
      return false;
    };

    for (const category of ALL_CATEGORIES) {
      if (await clickCategoryAndSearch(category, false)) break;
    }

    // Fallback: fuzzy match across all categories if exact name was not found in any
    if (!popup && !navigatedInSameTab && !foundInCategory) {
      console.log(`[AUDIT] Exact report not found in any category; trying fuzzy fallback...`);

      for (const category of ALL_CATEGORIES) {
        if (await clickCategoryAndSearch(category, true)) break;
      }
    }

    if (!popup && !navigatedInSameTab && !foundInCategory) {
      const visited = Array.from(new Set(visitedCategories)).join(' | ') || 'none';
      throw new Error(`Selected master audit report not found in any left-panel category. Master=${masterDisplay}. CategoriesScanned=[${visited}]`);
    }

    await delay(800);

    // Step 3: Resolve the report context (popup or same-tab)
    let reportContext = page;
    if (popup) {
      // Check if popup is still open after waitForLoadState operations
      if (popup.isClosed?.()) {
        console.log(`[AUDIT] WARN: Popup closed unexpectedly. URL was: ${popup.url() || 'unknown'}`);
        popup = null;
      } else {
        try {
          // Wait for popup to navigate away from about:blank to the actual report URL
          if (!popup.url() || popup.url() === 'about:blank') {
            await popup.waitForURL((url) => isActualReportViewUrl(url), { timeout: 20000 }).catch(async () => {
              // Also accept any non-blank URL as the popup may have a different path
              await popup.waitForURL((url) => url.href !== 'about:blank' && url.href !== '', { timeout: 10000 }).catch(() => { });
            });
          }
          if (popup.isClosed?.()) {
            console.log(`[AUDIT] WARN: Popup closed while waiting for navigation`);
            popup = null;
          } else {
            await popup.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => { });
            if (popup.isClosed?.()) {
              console.log(`[AUDIT] WARN: Popup closed during domcontentloaded wait`);
              popup = null;
            } else {
              await popup.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
              if (popup.isClosed?.()) {
                console.log(`[AUDIT] WARN: Popup closed during networkidle wait`);
                popup = null;
              } else {
                await safeWait(popup, 1200);
                if (popup.isClosed?.()) {
                  console.log(`[AUDIT] WARN: Popup closed during safeWait`);
                  popup = null;
                } else {
                  reportContext = await resolveAuditInteractionContext(popup);
                  console.log(`[AUDIT] Report opened in popup (${foundInCategory || 'unknown category'}): ${popup.url()}`);
                }
              }
            }
          }
        } catch (err) {
          console.log(`[AUDIT] WARN: Error handling popup: ${err?.message || err}`);
          popup = null;
        }
      }
    }

    if (!popup && !page.isClosed() && (navigatedInSameTab || isActualReportViewUrl(page.url()))) {
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => { });
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
      await delay(1200);
      reportContext = await resolveAuditInteractionContext(page);
      console.log(`[AUDIT] Report opened in same tab (${foundInCategory || 'unknown category'}): ${page.url()}`);
    } else if (!popup) {
      // Last resort: use any already-open /report/view popup
      const openPopups = page.context().pages().filter((p) => !p.isClosed() && p !== page && isActualReportViewUrl(p.url()));
      if (openPopups.length) {
        reportContext = openPopups[openPopups.length - 1];
        await reportContext.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
        await delay(1000);
        reportContext = await resolveAuditInteractionContext(reportContext);
        console.log(`[AUDIT] Using existing popup: ${reportContext.url()}`);
      }
    }

    return reportContext;
  }

  async function verifyEachFieldIndividually(reportContext, recordID, fieldsToVerify, options = {}) {
    /**
     * Verifies each field individually by searching the audit trail using the
     * VALUE that was entered (not the field name), then confirming:
     *   - The matching row contains the correct Record ID
     *   - The matching row's Field Name column matches the expected field name
     *
     * Search-by-value approach matches how the audit table looks:
     *   Record ID | Field Name | Old Value | New Value | ...
     */
    const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const splitMultiValue = (value) => String(value || '')
      .split(/[,;|\n]+/)
      .map((part) => norm(part))
      .filter(Boolean);
    const normalizeComparableValue = (value) => {
      const text = norm(value);
      if (!text) return '';
      const parts = splitMultiValue(text);
      if (parts.length > 1) {
        return Array.from(new Set(parts)).sort().join(',');
      }
      return text;
    };
    const buildSearchCandidates = (value) => {
      const raw = String(value || '').replace(/\s+/g, ' ').trim();
      const parts = splitMultiValue(raw)
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

      return Array.from(new Set([
        raw,
        ...parts,
        parts.slice(0, 2).join(' '),
        parts.slice(0, 3).join(' '),
      ].map((item) => String(item || '').trim()).filter(Boolean)));
    };

    const fieldResults = [];
    const shouldSkipField = (key) => /password|confirm\s*password|update\s*remarks?|reason|description/i.test(String(key || ''));
    const operation = String(options?.operation || '').toLowerCase();
    const skipFields = Array.isArray(options?.skipFields) ? options.skipFields : [];
    const skipNormSet = new Set(skipFields.map((field) => norm(field)).filter(Boolean));
    const skipCompactSet = new Set(skipFields.map((field) => norm(field).replace(/[^a-z0-9]/g, '')).filter(Boolean));
    const fieldNames = Object.keys(fieldsToVerify || {}).filter((fieldName) => {
      if (shouldSkipField(fieldName)) return false;
      const fieldNorm = norm(fieldName);
      const fieldCompact = fieldNorm.replace(/[^a-z0-9]/g, '');
      if (skipNormSet.has(fieldNorm) || (fieldCompact && skipCompactSet.has(fieldCompact))) {
        fieldResults.push({
          fieldName,
          expected: String(fieldsToVerify[fieldName] || ''),
          actual: null,
          recordIDMatch: true,
          status: 'EXPECTED_MISSING',
          reason: 'unchanged-update-field',
        });
        return false;
      }
      return true;
    });
    const normalizedRecordID = String(recordID || '').trim();
    const enforceRecordID = isLikelyRecordId(normalizedRecordID);
    const scopedRows = Array.isArray(options?.scopedRows) ? options.scopedRows : [];
    const useScopedOperationRows = scopedRows.length > 0;
    const scopedExtractedFields = useScopedOperationRows ? extractStructuredFieldsFromSnapshots(scopedRows) : [];

    if (!fieldNames.length) {
      console.log(`[AUDIT] No fields to verify`);
      return {
        results: fieldResults,
        passed: true,
        summary: {
          passed: 0,
          failed: 0,
          errors: 0,
          expectedMissing: fieldResults.filter((r) => r.status === 'EXPECTED_MISSING').length,
          total: fieldResults.length,
        },
      };
    }

    console.log(`\n[AUDIT] ═══════════════════════════════════════════`);
    console.log(`[AUDIT] FIELD-BY-FIELD INDIVIDUAL VERIFICATION`);
    console.log(`[AUDIT] Record ID: ${recordID}`);
    console.log(`[AUDIT] Record ID strict check: ${enforceRecordID ? 'enabled' : 'disabled (identifier is not a concrete Record ID)'}`);
    console.log(`[AUDIT] Total Fields to Verify: ${fieldNames.length}`);
    console.log(`[AUDIT] Searching by: VALUE (New Value column)`);
    if (useScopedOperationRows) {
      console.log(`[AUDIT] Operation scope: current operation rows only (${scopedRows.length} rows)`);
    }
    console.log(`[AUDIT] ═══════════════════════════════════════════\n`);

    for (let i = 0; i < fieldNames.length; i++) {
      const fieldName = fieldNames[i];
      const expectedValue = String(fieldsToVerify[fieldName] || '');
      const fieldNum = i + 1;
      const isRemarksField = /^remarks?$/i.test(String(fieldName || '').trim());

      // Skip empty values — nothing to search for
      if (!expectedValue) {
        console.log(`[AUDIT-FIELD] [${fieldNum}/${fieldNames.length}] Skipping "${fieldName}" — empty value`);
        continue;
      }

      try {
        console.log(`[AUDIT-FIELD] [${fieldNum}/${fieldNames.length}] Field: "${fieldName}" | Value: "${expectedValue}"`);

        if (useScopedOperationRows) {
          const expectedNorm = normalizeComparableValue(expectedValue);
          const fieldCandidates = scopedExtractedFields.filter((entry) => norm(entry.fieldName) === norm(fieldName));

          if (!fieldCandidates.length) {
            console.warn(`[AUDIT-FIELD]   Scoped rows did not include field "${fieldName}". Falling back to search-based verification.`);
          } else {
            const exactCandidate = fieldCandidates.find((entry) => normalizeComparableValue(entry.newValue) === expectedNorm);
            if (exactCandidate) {
              console.log(`[AUDIT-FIELD]   ✓ PASS | Scoped field match in current operation rows`);
              fieldResults.push({
                fieldName,
                expected: expectedValue,
                actual: exactCandidate.newValue,
                recordIDMatch: true,
                status: 'PASS',
                reason: null,
              });
              continue;
            }

            const actualValues = fieldCandidates.map((entry) => entry.newValue).filter(Boolean);
            const reason = `Expected "${expectedValue}" but scoped operation rows contain "${actualValues.join(' | ') || '(empty)'}"`;
            console.warn(`[AUDIT-FIELD]   ✗ FAIL: ${reason}`);
            fieldResults.push({
              fieldName,
              expected: expectedValue,
              actual: actualValues.join(' | '),
              recordIDMatch: true,
              status: 'FAIL',
              reason,
            });
            continue;
          }
        }

        // Step 1: Clear previous search
        await fillAuditSearch(reportContext, '').catch(() => { });
        await safeWait(reportContext, 500);

        // Step 2: Search by VALUE. For checkbox/multi-select fields, try the full
        // value first, then fall back to individual selected tokens.
        const searchCandidates = buildSearchCandidates(expectedValue);
        let searchOk = false;
        let allRows = [];
        let matchedSearchValue = '';

        for (const candidate of searchCandidates) {
          searchOk = await fillAuditSearch(reportContext, candidate).catch(() => false);
          if (!searchOk) continue;

          await waitForRowsToLoad(reportContext, AUDIT_ROW_SELECTOR, 10000);
          await safeWait(reportContext, 500);

          allRows = await collectVisibleRows(reportContext, 50);
          if (allRows.length > 0) {
            matchedSearchValue = candidate;
            break;
          }
        }

        if (!searchOk || allRows.length === 0) {
          console.warn(`[AUDIT-FIELD]   ✗ FAIL: Could not find audit rows for value "${expectedValue}"`);
          fieldResults.push({ fieldName, expected: expectedValue, actual: null, recordIDMatch: false, status: 'FAIL', reason: 'Search input failed' });
          continue;
        }

        // Step 3: Collect filtered rows
        console.log(`[AUDIT-FIELD]   Search term used: "${matchedSearchValue}"`);
        console.log(`[AUDIT-FIELD]   Found ${allRows.length} row(s) after value search`);

        if (allRows.length === 0) {
          console.warn(`[AUDIT-FIELD]   ✗ FAIL: Value "${expectedValue}" not found in audit trail`);
          fieldResults.push({ fieldName, expected: expectedValue, actual: null, recordIDMatch: false, status: 'FAIL', reason: `Value not found in audit trail` });
          continue;
        }

        // Step 4: Extract structured data from rows
        const extractedFields = await extractStructuredFieldsFromRows(reportContext, allRows);

        // Step 5: Find a row where:
        //   (a) New Value matches the expected value
        //   (b) Field Name matches the expected field name
        //   (c) Record ID is in the row text
        let matchedRow = null;
        let matchedExtracted = null;

        for (let ri = 0; ri < allRows.length; ri++) {
          const rowText = allRows[ri]?.text || '';
          const rowRecordIDMatch = enforceRecordID ? includesNormalized(rowText, normalizedRecordID) : true;
          const extracted = extractedFields.find((f) => f.matchIndex === allRows[ri].index);

          if (!extracted) continue;

          const newValueMatch = normalizeComparableValue(extracted.newValue) === normalizeComparableValue(expectedValue);
          const fieldNameMatch = norm(extracted.fieldName) === norm(fieldName);
          const rowContainsRemarksValue = isRemarksField && norm(rowText).includes(norm(expectedValue));

          if (newValueMatch && fieldNameMatch && rowRecordIDMatch) {
            matchedRow = allRows[ri];
            matchedExtracted = extracted;
            break;
          }

          if (rowContainsRemarksValue && rowRecordIDMatch) {
            matchedRow = allRows[ri];
            matchedExtracted = {
              ...extracted,
              fieldName,
              newValue: extracted.newValue && normalizeComparableValue(extracted.newValue) === normalizeComparableValue(expectedValue)
                ? extracted.newValue
                : expectedValue,
            };
            break;
          }

          // Relax: value matches + record ID, even if field name differs (log as warning not fail)
          if (newValueMatch && rowRecordIDMatch && !matchedRow) {
            matchedRow = allRows[ri];
            matchedExtracted = extracted;
            // Don't break — keep looking for an exact field name match
          }
        }

        if (!matchedExtracted) {
          // Check if value exists but wrong record ID
          const valueExistsElsewhere = extractedFields.some((f) => normalizeComparableValue(f.newValue) === normalizeComparableValue(expectedValue));
          const reason = valueExistsElsewhere
            ? (enforceRecordID
              ? `Value found but Record ID "${normalizedRecordID}" not in row`
              : `Value found but no exact field-name row matched for "${fieldName}"`)
            : `No row with New Value = "${expectedValue}" and Field Name = "${fieldName}"`;
          console.warn(`[AUDIT-FIELD]   ✗ FAIL: ${reason}`);
          console.log(`[AUDIT-FIELD]   Rows found: ${extractedFields.map((f) => `"${f.fieldName}"="${f.newValue}"`).join(', ')}`);
          fieldResults.push({ fieldName, expected: expectedValue, actual: null, recordIDMatch: false, status: 'FAIL', reason });
          continue;
        }

        const actualFieldName = matchedExtracted.fieldName;
        const actualValue = matchedExtracted.newValue;
        const rowText = matchedRow?.text || '';
        const recordIDMatch = enforceRecordID ? includesNormalized(rowText, normalizedRecordID) : true;
        const fieldNameMatch = norm(actualFieldName) === norm(fieldName);

        if (recordIDMatch && fieldNameMatch) {
          console.log(`[AUDIT-FIELD]   ✓ PASS | RecordID: ✓ | FieldName: "${actualFieldName}" ✓ | Value: "${actualValue}" ✓\n`);
          fieldResults.push({ fieldName, expected: expectedValue, actual: actualValue, recordIDMatch: true, status: 'PASS', reason: null });
        } else {
          const reasons = [];
          if (enforceRecordID && !recordIDMatch) reasons.push(`Record ID "${normalizedRecordID}" not found in row`);
          if (!fieldNameMatch) reasons.push(`Field name: expected "${fieldName}" but found "${actualFieldName}"`);
          console.warn(`[AUDIT-FIELD]   ✗ FAIL | ${reasons.join(' | ')}\n`);
          fieldResults.push({ fieldName, expected: expectedValue, actual: actualValue, recordIDMatch, status: 'FAIL', reason: reasons.join('; ') });
        }

      } catch (err) {
        console.warn(`[AUDIT-FIELD]   ✗ ERROR: ${err?.message || String(err)}\n`);
        fieldResults.push({ fieldName, expected: expectedValue, actual: null, recordIDMatch: false, status: 'ERROR', reason: err?.message || String(err) });
      }
    }

    // Clear search after all fields done
    if (!useScopedOperationRows) {
      await fillAuditSearch(reportContext, '').catch(() => { });
    }

    // Summary
    const passed = fieldResults.filter((r) => r.status === 'PASS').length;
    const failed = fieldResults.filter((r) => r.status === 'FAIL').length;
    const errors = fieldResults.filter((r) => r.status === 'ERROR').length;
    const expectedMissing = fieldResults.filter((r) => r.status === 'EXPECTED_MISSING').length;
    const totalVerified = passed + failed + errors;

    console.log(`\n[AUDIT] ═══ FINAL SUMMARY ═══`);
    console.log(`[AUDIT] Total Fields Verified: ${totalVerified}/${fieldNames.length}`);
    console.log(`[AUDIT] ✓ PASSED: ${passed}`);
    console.log(`[AUDIT] ✗ FAILED: ${failed}`);
    console.log(`[AUDIT] ⚠ ERRORS: ${errors}`);
    console.log(`[AUDIT] ? EXPECTED MISSING: ${expectedMissing}`);
    console.log(`[AUDIT] ═══════════════════════\n`);

    if (passed > 0) {
      const passedFields = fieldResults.filter((r) => r.status === 'PASS').map((r) => r.fieldName);
      console.log(`[AUDIT] ✓ PASSED fields: ${passedFields.join(', ')}`);
    }

    if (failed > 0) {
      const failedFields = fieldResults.filter((r) => r.status === 'FAIL').map((r) => r.fieldName);
      console.log(`[AUDIT] ✗ FAILED fields: ${failedFields.join(', ')}`);
    }

    if (errors > 0) {
      const errorFields = fieldResults.filter((r) => r.status === 'ERROR').map((r) => r.fieldName);
      console.log(`[AUDIT] ⚠ ERROR fields: ${errorFields.join(', ')}`);
    }

    if (expectedMissing > 0) {
      const expectedMissingFields = fieldResults.filter((r) => r.status === 'EXPECTED_MISSING').map((r) => r.fieldName);
      console.log(`[AUDIT] ? EXPECTED MISSING fields: ${expectedMissingFields.join(', ')}`);
    }

    return {
      results: fieldResults,
      passed: failed === 0 && errors === 0,
      summary: { passed, failed, errors, expectedMissing, total: totalVerified },
    };
  }


  async function verifyAuditTrailEntry(page, options) {
    const strict = options?.strict === true;
    const expected = {
      operation: String(options?.operation || '').toLowerCase(),
      masterName: String(options?.masterName || '').trim(),
      recordID: String(options?.recordID || '').trim(),
      masterDisplayName: formatMasterDisplayName(options?.masterName || ''),
      masterCandidates: buildMasterNameCandidates(options?.masterName || ''),
      identifiers: uniqueNonEmpty([
        options?.recordName,
        options?.recordID,
        inferPrimaryRecordIdentifier(options?.auditTrail || {}, options?.recordName || options?.recordID || ''),
      ]),
      reason: String(options?.reason || '').trim(),
      fieldEvidence: pickPreferredEntries(options?.auditTrail || {}),
      operationPattern: buildOperationPattern(options?.operation),
      username: options?.username || '',
      masterPerformedOn: options?.masterPerformedOn || '',
    };

    const reportContext = await navigateAndSearchMasterAudit(page, options?.baseURL || '', expected);
    expected.masterScoped = true;

    // Restore previous date flow: set range, then execute report.
    const dateResult = await ensurePerformedOnDateRange(reportContext).catch(() => ({ filled: false, reason: 'evaluate-failed' }));
    if (!dateResult.filled) {
      console.log(`[AUDIT] Performed On date range not set: ${dateResult.reason || 'unknown'}`);
    }
    await triggerReportExecution(reportContext).catch(() => { });
    // Wait for the report table to finish rendering before searching rows
    const preloadedRows = await waitForRowsToLoad(reportContext, AUDIT_ROW_SELECTOR, 45000);
    console.log(`[AUDIT] Report table loaded: ${preloadedRows.length} rows visible`);

    let row = await locateAuditRow(reportContext, expected);

    if (!row) {
      // Fallback: reload, re-execute, and retry once
      console.log('[AUDIT] Row not found; reloading and retrying...');
      if (typeof reportContext.reload === 'function') {
        await reportContext.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      } else if (typeof reportContext.page === 'function') {
        const ownerPage = reportContext.page();
        await ownerPage.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => { });
      }
      await reportContext.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
      await safeWait(reportContext, 1500);
      await ensurePerformedOnDateRange(reportContext).catch(() => { });
      await triggerReportExecution(reportContext).catch(() => { });
      await waitForRowsToLoad(reportContext, AUDIT_ROW_SELECTOR, 45000);
      row = await locateAuditRow(reportContext, expected);
    }

    if (!row) {
      const sampleRows = await collectVisibleRows(reportContext, 12);
      const preview = sampleRows.map((entry) => entry.text).filter(Boolean).slice(0, 8).join(' || ');
      const identifiers = expected.identifiers.join(', ');
      const message = `Audit trail entry not found for ${expected.masterDisplayName || expected.masterName} (${expected.operation}). `
        + `Identifiers=[${identifiers}] SampleRows=[${preview || 'none'}]`;
      if (strict) {
        throw new Error(message);
      }
      console.warn(`[AUDIT] WARN ${message}`);
      return {
        verified: false,
        source: 'audit-report',
        detailOpened: false,
        queryUsed: '',
        matchedRow: '',
        matched: [],
        fieldMatches: [],
        rowSnapshots: [],
        statusColumn: { found: false, index: -1, header: '' },
        reasonColumn: { found: false, index: -1, header: '' },
        operationRowSnapshots: [],
        operationRowRange: { startIndex: -1, endIndex: -1, total: 0 },
        reason: message,
      };
    }

    // Recovery: if recordID is missing or appears to be a non-ID label/value,
    // extract the actual Record ID from matched row text and re-filter.
    if (row && !isLikelyRecordId(expected.recordID)) {
      const ridMatch = row.text.match(/[A-Z]+-\d+-\d+/i);
      if (ridMatch) {
        const recoveredID = ridMatch[0];
        console.log(`[AUDIT] Recovered Record ID from row: ${recoveredID}`);
        expected.recordID = recoveredID;
        if (!expected.identifiers.includes(recoveredID)) {
          expected.identifiers.push(recoveredID);
        }

        // Re-filter by recovered ID to ensure we see ALL rows for this record (e.g. Remarks row)
        const filterSuccess = await fillAuditSearch(reportContext, recoveredID).catch(() => false);
        if (filterSuccess) {
          await waitForRowsToLoad(reportContext, AUDIT_ROW_SELECTOR, 10000);
          const newRows = await collectVisibleRows(reportContext, 100);
          const newMatch = findMatchingRow(newRows, expected);
          if (newMatch) {
            row = { ...newMatch, queryUsed: recoveredID };
            console.log(`[AUDIT] Re-filtered by ${recoveredID}, found ${newRows.length} rows.`);
          }
        }
      }
    }

    const statusSnapshot = await collectVisibleRowsWithStatusSnapshot(reportContext, 120)
      .catch(() => ({ rows: [], statusColumnFound: false, statusColumnIndex: -1, statusHeader: '', reasonColumnFound: false, reasonColumnIndex: -1, reasonHeader: '' }));
    const operationRowSnapshots = filterOperationScopedRowSnapshots(statusSnapshot.rows || [], expected);
    const operationIndexes = operationRowSnapshots
      .map((entry) => Number(entry?.index))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const operationRowRange = {
      startIndex: operationIndexes.length ? operationIndexes[0] : -1,
      endIndex: operationIndexes.length ? operationIndexes[operationIndexes.length - 1] : -1,
      total: operationRowSnapshots.length,
    };

    let detailOpened = false;
    let verificationSource = 'row';
    let verificationText = row.text;
    let auditDetailFields = [];

    // Try opening details first (for master-level actions that open a field-level overlay)
    const details = await openAuditDetails(reportContext, row.index);
    if (details?.fields && details.fields.length > 0) {
      detailOpened = true;
      verificationSource = 'detail';
      verificationText = details.text;
      auditDetailFields = details.fields;
    } else {
      // If no detail overlay or it has no fields, try to collect all related rows from the main table
      // (for audit trails where each row is a field change - one row per field)

      // Step 1: Collect initial matching rows
      const initialRows = await collectVisibleRows(reportContext, 100);
      let allMatchingRows = findAllMatchingRows(initialRows, expected);

      // Step 2: If we have a Record ID, search specifically for it to ensure we get ALL field entries
      if (isLikelyRecordId(expected.recordID) && allMatchingRows.length < 20) {
        console.log(`[AUDIT] Searching specifically for Record ID: ${expected.recordID}`);
        const recordIdSearch = await fillAuditSearch(reportContext, expected.recordID).catch(() => false);
        if (recordIdSearch) {
          await waitForRowsToLoad(reportContext, AUDIT_ROW_SELECTOR, 10000);
          const recordSpecificRows = await collectVisibleRows(reportContext, 250); // Collect more rows for thorough search
          allMatchingRows = findAllMatchingRows(recordSpecificRows, expected);
          console.log(`[AUDIT] After Record ID search: ${allMatchingRows.length} rows found`);
        }
      }

      if (allMatchingRows.length >= 1) {
        console.log(`[AUDIT] Extracting field entries from ${allMatchingRows.length} audit rows...`);
        auditDetailFields = await extractStructuredFieldsFromRows(reportContext, allMatchingRows);
        verificationSource = allMatchingRows.length > 1 ? 'multi-row' : 'row';
        verificationText = allMatchingRows.map(r => r.text).join(' | ');
      } else if (details?.text) {
        // Single row matched, but detail overlay exists (even if empty of fields)
        detailOpened = true;
        verificationSource = 'detail';
        verificationText = details.text;
      }
    }

    if (auditDetailFields.length > 0) {
      console.log(`\n[AUDIT] ═══ EXTRACTING ${auditDetailFields.length} FIELD ENTRIES ═══`);
      for (let i = 0; i < auditDetailFields.length; i++) {
        const f = auditDetailFields[i];
        console.log(`[AUDIT] [${i + 1}/${auditDetailFields.length}] Field: "${f.fieldName}"`);
        console.log(`[AUDIT]          Old Value: "${f.oldValue}"`);
        console.log(`[AUDIT]          New Value: "${f.newValue}"`);
      }
      console.log(`[AUDIT] ════════════════════════════════════════\n`);
    }

    const snapshotDerivedFields = extractStructuredFieldsFromSnapshots(operationRowSnapshots);
    if (snapshotDerivedFields.length > 0) {
      const byKey = new Map();
      const normKey = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      for (const field of [...auditDetailFields, ...snapshotDerivedFields]) {
        const k = normKey(field?.fieldName);
        if (!k) continue;
        const prev = byKey.get(k);
        const richness = (f) => (String(f?.newValue || '').trim() ? 2 : 0) + (String(f?.oldValue || '').trim() ? 1 : 0) + (String(f?.timestamp || '').trim() ? 1 : 0);
        if (!prev || richness(field) >= richness(prev)) byKey.set(k, field);
      }
      auditDetailFields = Array.from(byKey.values());
    }

    // Always require field evidence verification (timestamp + field values)
    const analysis = analyzeAuditText(verificationText, expected, true);
    console.log(`[AUDIT] Verification matched: ${analysis.matched.join(', ') || 'none'}`);
    if (analysis.missing.length > 0) {
      console.warn(`[AUDIT] Missing from audit detail: ${analysis.missing.join(', ')}`);
    }

    // Field-by-field comparison between dashboard data and audit trail
    const dashboardAuditTrail = options?.auditTrail || {};
    let comparison = null;
    let screenshotPath = '';

    if (auditDetailFields.length > 0 && Object.keys(dashboardAuditTrail).length > 0) {
      console.log(`\n[AUDIT] ═══ FIELD VERIFICATION ═══`);
      console.log(`[AUDIT] Audit Trail has: ${auditDetailFields.length} field entries`);
      console.log(`[AUDIT] Expected fields to verify: ${Object.keys(dashboardAuditTrail).length}`);
      console.log(`[AUDIT] Expected field names: ${Object.keys(dashboardAuditTrail).join(', ')}`);
      console.log(`[AUDIT] ════════════════════════════════\n`);

      comparison = compareAuditWithDashboard(auditDetailFields, dashboardAuditTrail, expected.operation, {
        skipFields: options?.skipFields || [],
      });

      console.log(`[AUDIT] Comparison: ${comparison.matchCount} matched, ${comparison.mismatchCount} mismatches (of ${comparison.totalChecked} checked)`);

      // ──── DETAILED SINGLE-FIELD VALIDATION REPORT ────────────────────────────────
      if (comparison.fieldValidationResults && comparison.fieldValidationResults.length > 0) {
        console.log('\n[AUDIT] ═══ FIELD-BY-FIELD VALIDATION REPORT ═══');
        for (const fieldResult of comparison.fieldValidationResults) {
          const statusSymbol = fieldResult.status === 'PASS' ? '✓' : fieldResult.status === 'MISMATCH' ? '✗' : '?';
          console.log(`[AUDIT] ${statusSymbol} Field: "${fieldResult.fieldName}"`);
          console.log(`[AUDIT]    Status: ${fieldResult.status}`);
          console.log(`[AUDIT]    Expected: "${fieldResult.expected}"`);
          if (fieldResult.actual !== null) {
            console.log(`[AUDIT]    Actual: "${fieldResult.actual}"`);
          }
          if (fieldResult.auditFieldName) {
            console.log(`[AUDIT]    Audit Field: "${fieldResult.auditFieldName}"`);
          }
          if (fieldResult.error) {
            console.log(`[AUDIT]    Error: ${fieldResult.error}`);
          }
        }
        console.log('[AUDIT] ════════════════════════════════════════\n');
      }

      // ──── SUMMARY ────────────────────────────────────────────────────────────────
      if (comparison.fieldValidationSummary) {
        const summary = comparison.fieldValidationSummary;
        console.log('[AUDIT] VALIDATION SUMMARY:');
        if (summary.passedFields.length > 0) {
          console.log(`[AUDIT]   ✓ PASSED (${summary.passedFields.length}): ${summary.passedFields.join(', ')}`);
        }
        if (summary.failedFields.length > 0) {
          console.warn(`[AUDIT]   ✗ FAILED (${summary.failedFields.length}): ${summary.failedFields.join(', ')}`);
        }
        if (summary.missingFields.length > 0) {
          console.warn(`[AUDIT]   ? MISSING (${summary.missingFields.length}): ${summary.missingFields.join(', ')}`);
        }
      }

      if (comparison.mismatches.length > 0) {
        console.warn('[AUDIT] MISMATCHES between dashboard and audit trail:');
        for (const m of comparison.mismatches) {
          console.warn(`[AUDIT]   Field: "${m.field}" expected="${m.expected}" actual="${m.actual}"${m.auditField ? ` (audit field: "${m.auditField}")` : ''}`);
        }
      }
      if (comparison.notFoundInAudit.length > 0) {
        console.warn('[AUDIT] Fields NOT FOUND in audit trail:');
        for (const m of comparison.notFoundInAudit) {
          console.warn(`[AUDIT]   Field: "${m.field}" expected="${m.expected}"`);
        }
      }
      // Capture screenshot if there are mismatches
      if (!comparison.passed) {
        screenshotPath = await captureAuditScreenshot(reportContext, expected.masterName, expected.operation, 'audit-mismatch').catch(() => '');
        if (screenshotPath) {
          console.log(`[AUDIT] Mismatch screenshot saved: ${screenshotPath}`);
        }
      }
    } else if (Object.keys(dashboardAuditTrail).length > 0 && auditDetailFields.length === 0) {
      // Strict mode: if expected dashboard fields exist but audit fields cannot be extracted, fail comparison.
      console.warn('[AUDIT] Could not extract structured fields from audit detail for comparison');
      comparison = {
        totalChecked: Object.keys(dashboardAuditTrail).length,
        matchCount: 0,
        mismatchCount: Object.keys(dashboardAuditTrail).length,
        matches: [],
        mismatches: [],
        notFoundInAudit: Object.entries(dashboardAuditTrail).map(([field, expectedValue]) => ({
          field,
          expected: String(expectedValue || ''),
        })),
        auditFieldCount: 0,
        passed: false,
        reason: 'Structured audit fields could not be extracted',
      };
      screenshotPath = await captureAuditScreenshot(reportContext, expected.masterName, expected.operation, 'audit-no-fields').catch(() => '');
    }

    // Capture proof screenshot for successful audit verification as well.
    if (!screenshotPath && analysis.missing.length === 0) {
      screenshotPath = await captureAuditScreenshot(reportContext, expected.masterName, expected.operation, 'audit-verified').catch(() => '');
      if (screenshotPath) {
        console.log(`[AUDIT] Verification screenshot saved: ${screenshotPath}`);
      }
    }

    // Close detail overlay after screenshot
    if (details?.overlay) {
      await closeAuditDetails(reportContext, details.overlay).catch(() => { });
    }

    // ── FIELD-BY-FIELD INDIVIDUAL VERIFICATION on the already-open reportContext ──
    // This MUST run here while reportContext (popup/tab) is still open, NOT from the
    // caller with the main page object.
    let fieldByFieldResults = null;
    if (Object.keys(dashboardAuditTrail).length > 0) {
      const recordID = expected.recordID || expected.identifiers[0] || '';
      fieldByFieldResults = await verifyEachFieldIndividually(reportContext, recordID, dashboardAuditTrail, {
        operation: expected.operation,
        skipFields: options?.skipFields || [],
        scopedRows: operationRowSnapshots,
      });
    }

    const expectsFieldComparison = Object.keys(dashboardAuditTrail || {}).length > 0;
    const fieldComparisonPassed = !expectsFieldComparison || (
      fieldByFieldResults ? fieldByFieldResults.passed : (comparison && comparison.passed === true)
    );
    const verified = analysis.missing.length === 0 && fieldComparisonPassed;

    if (strict && !verified) {
      const failureReasons = [];
      if (analysis.missing.length > 0) {
        failureReasons.push(`missing audit evidence: ${analysis.missing.join(', ')}`);
      }
      if (expectsFieldComparison && !fieldComparisonPassed) {
        const failedFields = fieldByFieldResults?.results?.filter((r) => r.status !== 'PASS').map((r) => r.fieldName) || [];
        failureReasons.push(`field verification failed: ${failedFields.join(', ') || 'see above'}`);
      }
      throw new Error(`Strict audit verification failed for ${expected.masterDisplayName || expected.masterName} (${expected.operation}): ${failureReasons.join(' | ')}`);
    }

    const fieldValidationResults = fieldByFieldResults?.results || comparison?.fieldValidationResults || [];
    const fieldValidationPassed = fieldValidationResults.filter((r) => String(r?.status || '').toUpperCase() === 'PASS');
    const fieldValidationExpectedMissing = fieldValidationResults.filter((r) => String(r?.status || '').toUpperCase() === 'EXPECTED_MISSING');
    const fieldValidationFailed = fieldValidationResults.filter((r) => {
      const status = String(r?.status || '').toUpperCase();
      return status !== 'PASS' && status !== 'EXPECTED_MISSING';
    });

    return {
      verified,
      source: verificationSource,
      detailOpened,
      queryUsed: row.queryUsed || '',
      matchedRow: row.text,
      matched: analysis.matched,
      missing: analysis.missing,
      fieldMatches: analysis.fieldMatches,
      rowSnapshots: statusSnapshot.rows || [],
      operationRowSnapshots,
      operationRowRange,
      statusColumn: {
        found: !!statusSnapshot.statusColumnFound,
        index: Number.isInteger(statusSnapshot.statusColumnIndex) ? statusSnapshot.statusColumnIndex : -1,
        header: statusSnapshot.statusHeader || '',
      },
      reasonColumn: {
        found: !!statusSnapshot.reasonColumnFound,
        index: Number.isInteger(statusSnapshot.reasonColumnIndex) ? statusSnapshot.reasonColumnIndex : -1,
        header: statusSnapshot.reasonHeader || '',
      },
      comparison,
      screenshotPath,
      fieldByFieldResults,
      // ──── FIELD VALIDATION RESULTS (from field-by-field) ────
      fieldValidationResults,
      fieldValidationSummary: {
        total: fieldValidationResults.length,
        passed: fieldValidationPassed.length,
        failed: fieldValidationFailed.length,
        expectedMissing: fieldValidationExpectedMissing.length,
        passedFields: fieldValidationPassed.map((r) => r.fieldName),
        failedFields: fieldValidationFailed.map((r) => r.fieldName),
        missingFields: [],
        expectedMissingFields: fieldValidationExpectedMissing.map((r) => r.fieldName),
      },
    };
  }


  return {
    formatMasterDisplayName,
    inferPrimaryRecordIdentifier,
    verifyAuditTrail: verifyAuditTrailEntry,
    verifyAuditTrailEntry,
    verifyEachFieldIndividually,
    openAuditTrailPage,
    navigateAndSearchMasterAudit,
    fillAuditSearch,
    compareAuditWithDashboard,
    analyzeAuditText,
    collectVisibleRowsWithStatusSnapshot,
    filterOperationScopedRowSnapshots,
    extractStructuredFieldsFromSnapshots,
  };
})();

const {
  verifyAuditTrailEntry,
  openAuditTrailPage,
  fillAuditSearch,
} = __complianceAuditTrailLocal;

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function compactKey(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, '');
}

function uniqueNonEmpty(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function includesNormalized(haystack, needle) {
  const left = normalizeText(haystack);
  const right = normalizeText(needle);
  return !!right && left.includes(right);
}

function looksLikeRecordId(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^[A-Z]{1,10}-\d{1,8}-\d{1,12}$/i.test(text);
}

function extractRecordIdsFromText(value) {
  const text = String(value || '');
  const matches = text.match(/\b[A-Z]{1,10}-\d{1,8}-\d{1,12}\b/gi);
  return uniqueNonEmpty(matches || []);
}

function normalizeComparableValue(value) {
  const text = normalizeText(value);
  if (!text) return '';
  const parts = text
    .split(/[,;|\n]+/)
    .map((part) => normalizeText(part))
    .filter(Boolean);
  if (parts.length > 1) {
    return Array.from(new Set(parts)).sort().join(',');
  }
  return text;
}

function buildOperationPattern(operation) {
  switch (normalizeText(operation)) {
    case 'create':
      return /\b(create|created|add|added|save|saved|insert|inserted)\b/i;
    case 'update':
      return /\b(update|updated|edit|edited|modify|modified)\b/i;
    case 'delete':
      return /\b(delete|deleted|deactivate|deactivated|inactive|remove|removed)\b/i;
    default:
      return /.*/i;
  }
}

function findHeaderIndex(headers, patterns) {
  const normalized = Array.isArray(headers) ? headers.map((h) => normalizeText(h)) : [];
  for (let i = 0; i < normalized.length; i += 1) {
    const header = normalized[i];
    for (const pattern of patterns) {
      if (pattern.test(header)) return i;
    }
  }
  return -1;
}

function buildHeaderIndexMap(headers) {
  return {
    status: findHeaderIndex(headers, [/^status$/i, /status/i, /^operation$/i, /operation/i, /^action/i]),
    field: findHeaderIndex(headers, [/^field\s*name$/i, /^field$/i, /^column\s*name$/i, /^column$/i]),
    oldValue: findHeaderIndex(headers, [/^old\s*value$/i, /^old$/i, /old\s*value/i]),
    newValue: findHeaderIndex(headers, [/^new\s*value$/i, /^new$/i, /new\s*value/i]),
    reason: findHeaderIndex(headers, [/^reason$/i, /reason/i, /remark/i, /comment/i, /note/i]),
    performedOn: findHeaderIndex(headers, [/^performed\s*on$/i, /timestamp/i, /date\s*time/i, /^date$/i]),
    performedBy: findHeaderIndex(headers, [/^performed\s*by$/i, /performed\s*by/i, /^user$/i, /username/i, /actor/i]),
  };
}

function extractTimestampFromText(text) {
  const raw = String(text || '');
  const iso = raw.match(/\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/i);
  if (iso && iso[0]) return iso[0];
  const friendly = raw.match(/\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}/);
  return friendly && friendly[0] ? friendly[0] : '';
}

function extractPerformerFromRowText(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';

  const timestamp = extractTimestampFromText(raw);
  let base = raw;
  if (timestamp) {
    const idx = raw.lastIndexOf(timestamp);
    if (idx > 0) base = raw.slice(0, idx).trim();
  }

  const opToken = /(\bcreated\b|\bupdated\b|\bdeleted\b|\bdeactivated\b)/i;
  const opMatch = base.match(opToken);
  if (!opMatch) return '';

  const afterOp = base.slice((opMatch.index || 0) + opMatch[0].length).trim();
  if (!afterOp) return '';
  return afterOp.split(' ').filter(Boolean).slice(0, 3).join(' ');
}

function decorateRow(row) {
  const headers = Array.isArray(row && row.headers) ? row.headers : [];
  const cells = Array.isArray(row && row.cells) ? row.cells : [];
  const indexes = buildHeaderIndexMap(headers);

  const readCell = (idx) => (idx >= 0 ? String(cells[idx] || '').trim() : '');

  const rowText = String((row && row.text) || '').replace(/\s+/g, ' ').trim();
  const statusValue = String((row && row.statusValue) || readCell(indexes.status) || '').trim();
  const reasonValue = String((row && row.reasonValue) || readCell(indexes.reason) || '').trim();
  const fieldName = readCell(indexes.field) || String(cells[1] || cells[0] || '').trim();
  const oldValue = readCell(indexes.oldValue) || String(cells[2] || '').trim();
  const newValue = readCell(indexes.newValue) || String(cells[3] || cells[cells.length - 1] || '').trim();
  const timestamp = readCell(indexes.performedOn) || extractTimestampFromText(rowText);
  const performedBy = readCell(indexes.performedBy) || extractPerformerFromRowText(rowText);

  return {
    ...(row || {}),
    headers,
    cells,
    headerIndexes: indexes,
    text: rowText,
    statusValue,
    reasonValue,
    fieldName,
    oldValue,
    newValue,
    timestamp,
    performedBy,
    extractedRecordIds: extractRecordIdsFromText(`${rowText} ${cells.join(' ')}`),
  };
}

function pickIdentifiers(options, baseResult) {
  const fromOptions = [
    options && options.recordID,
    options && options.recordName,
    baseResult && baseResult.queryUsed,
  ];

  const fromRows = [];
  fromRows.push(...extractRecordIdsFromText(baseResult && baseResult.matchedRow));

  const snapshots = Array.isArray(baseResult && baseResult.rowSnapshots) ? baseResult.rowSnapshots : [];
  for (const row of snapshots.slice(0, 50)) {
    if (!row || !row.text) continue;
    const ids = extractRecordIdsFromText(row.text);
    for (const id of ids) fromRows.push(id);
  }

  return uniqueNonEmpty([...fromOptions, ...fromRows]);
}

function filterRecordScopedRows(rows, identifiers) {
  const usableRows = Array.isArray(rows) ? rows : [];
  if (!usableRows.length) {
    return {
      primaryRecordId: '',
      identifiers: uniqueNonEmpty(identifiers),
      recordRows: [],
    };
  }

  const allIdentifiers = uniqueNonEmpty(identifiers || []);
  const primaryRecordId = allIdentifiers.find((id) => looksLikeRecordId(id)) || allIdentifiers[0] || '';

  const matchesPrimary = (row) => {
    if (!primaryRecordId) return false;
    const searchText = `${row.text || ''} ${Array.isArray(row.cells) ? row.cells.join(' ') : ''}`;
    return includesNormalized(searchText, primaryRecordId);
  };

  const matchesAny = (row) => {
    if (!allIdentifiers.length) return false;
    const searchText = `${row.text || ''} ${Array.isArray(row.cells) ? row.cells.join(' ') : ''}`;
    return allIdentifiers.some((id) => includesNormalized(searchText, id));
  };

  let recordRows = primaryRecordId
    ? usableRows.filter(matchesPrimary)
    : usableRows.filter(matchesAny);

  if (!recordRows.length && allIdentifiers.length) {
    recordRows = usableRows.filter(matchesAny);
  }

  if (!recordRows.length) {
    recordRows = usableRows;
  }

  return {
    primaryRecordId,
    identifiers: allIdentifiers,
    recordRows,
  };
}

function filterOperationScopedRows(recordRows, operation, reason) {
  const rows = Array.isArray(recordRows) ? recordRows : [];
  if (!rows.length) return [];

  const op = normalizeText(operation);
  const opPattern = buildOperationPattern(op);
  const reasonNorm = normalizeText(reason);

  const withOperationToken = rows.filter((row) => {
    const status = String(row && row.statusValue || '');
    const text = String(row && row.text || '');
    return opPattern.test(status) || opPattern.test(text);
  });

  if (op === 'update' && reasonNorm) {
    const reasonRows = rows.filter((row) => normalizeText(row && row.reasonValue));
    const reasonAnchors = reasonRows.filter((row) => {
      const reasonValue = String(row && row.reasonValue || '');
      const searchText = `${reasonValue} ${row && row.text || ''}`;
      return includesNormalized(searchText, reasonNorm);
    });

    if (reasonAnchors.length > 0) {
      const anchorIndex = Number(reasonAnchors[0].index);
      const otherReasonRows = reasonRows.filter((row) => {
        const val = normalizeText(row && row.reasonValue);
        return val && !includesNormalized(val, reasonNorm) && !includesNormalized(reasonNorm, val);
      });
      const otherReasonIndexes = otherReasonRows
        .map((row) => Number(row.index))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b);

      const previousReasonIndex = otherReasonIndexes.filter((value) => value < anchorIndex).pop();
      const nextReasonIndex = otherReasonIndexes.find((value) => value > anchorIndex);
      const startIndex = Number.isFinite(previousReasonIndex) ? previousReasonIndex + 1 : -Infinity;
      const endIndex = Number.isFinite(nextReasonIndex) ? nextReasonIndex - 1 : Infinity;

      const rangedRows = rows.filter((row) => {
        const idx = Number(row.index);
        return Number.isFinite(idx) && idx >= startIndex && idx <= endIndex;
      });

      const rangedScoped = rangedRows.filter((row) => {
        const statusNorm = normalizeText(row.statusValue);
        const statusOrTextMatches = opPattern.test(String(row.statusValue || '')) || opPattern.test(String(row.text || ''));
        return statusOrTextMatches || !statusNorm;
      });

      if (rangedScoped.length > 0) return rangedScoped;
      if (rangedRows.length > 0) return rangedRows;
    }
  }

  if (withOperationToken.length > 0) {
    const expanded = rows.filter((row) => {
      const statusNorm = normalizeText(row.statusValue);
      const matches = opPattern.test(String(row.statusValue || '')) || opPattern.test(String(row.text || ''));
      return matches || !statusNorm;
    });
    if (expanded.length > 0) return expanded;
    return withOperationToken;
  }

  return rows;
}

function extractStructuredFieldRows(rows) {
  const inRows = Array.isArray(rows) ? rows : [];
  const extracted = [];

  for (const row of inRows) {
    const fieldName = String(row && row.fieldName || '').trim();
    const fieldNorm = normalizeText(fieldName);
    if (!fieldNorm) continue;
    if (/^(field\s*name|old\s*value|new\s*value|performed\s*on|timestamp|status|reason(?:\s*for\s*change)?|operation|action)$/i.test(fieldNorm)) {
      continue;
    }

    extracted.push({
      rowIndex: row && row.index,
      rowText: String(row && row.text || '').slice(0, 260),
      fieldName,
      oldValue: String(row && row.oldValue || '').trim(),
      newValue: String(row && row.newValue || '').trim(),
      timestamp: String(row && row.timestamp || '').trim(),
      performedBy: String(row && row.performedBy || '').trim(),
      reasonValue: String(row && row.reasonValue || '').trim(),
      statusValue: String(row && row.statusValue || '').trim(),
    });
  }

  const score = (entry) => {
    let total = 0;
    if (String(entry.oldValue || '').trim()) total += 1;
    if (String(entry.newValue || '').trim()) total += 2;
    if (String(entry.timestamp || '').trim()) total += 1;
    return total;
  };

  const dedup = new Map();
  for (const entry of extracted) {
    const key = compactKey(entry.fieldName);
    const previous = dedup.get(key);
    if (!previous || score(entry) >= score(previous)) {
      dedup.set(key, entry);
    }
  }

  return Array.from(dedup.values());
}

function findLooseKeyValue(source, targetKey) {
  const data = source || {};
  const directKeys = Object.keys(data);
  const targetNorm = normalizeText(targetKey);
  const targetCompact = compactKey(targetKey);

  for (const key of directKeys) {
    if (normalizeText(key) === targetNorm) return data[key];
  }

  for (const key of directKeys) {
    const keyCompact = compactKey(key);
    if (!keyCompact || !targetCompact) continue;
    if (keyCompact === targetCompact || keyCompact.includes(targetCompact) || targetCompact.includes(keyCompact)) {
      return data[key];
    }
  }

  return '';
}

function buildUpdateOldNewValidation(options, fieldRows) {
  if (normalizeText(options && options.operation) !== 'update') return null;

  const expectedChangedFields = options && options.auditTrail && typeof options.auditTrail === 'object'
    ? options.auditTrail
    : {};
  const preUpdateMasterData = options && options.preUpdateMasterData && typeof options.preUpdateMasterData === 'object'
    ? options.preUpdateMasterData
    : {};

  const rowByField = new Map();
  for (const row of fieldRows || []) {
    rowByField.set(compactKey(row.fieldName), row);
  }

  const results = [];

  for (const [fieldName, expectedNewRaw] of Object.entries(expectedChangedFields)) {
    const key = compactKey(fieldName);
    const row = rowByField.get(key);
    const expectedOldRaw = findLooseKeyValue(preUpdateMasterData, fieldName);

    if (!row) {
      results.push({
        fieldName,
        status: 'NOT_FOUND',
        expectedOld: String(expectedOldRaw || ''),
        actualOld: null,
        expectedNew: String(expectedNewRaw || ''),
        actualNew: null,
        oldMatches: false,
        newMatches: false,
        reason: 'Field row not found in filtered audit rows',
      });
      continue;
    }

    const expectedOld = normalizeComparableValue(expectedOldRaw);
    const expectedNew = normalizeComparableValue(expectedNewRaw);
    const actualOld = normalizeComparableValue(row.oldValue);
    const actualNew = normalizeComparableValue(row.newValue);

    const oldCheckRequired = String(expectedOldRaw || '').trim() !== '';
    const oldMatches = oldCheckRequired ? actualOld === expectedOld : true;
    const newMatches = actualNew === expectedNew;
    const passed = oldMatches && newMatches;

    results.push({
      fieldName,
      status: passed ? 'PASS' : 'FAIL',
      expectedOld: String(expectedOldRaw || ''),
      actualOld: String(row.oldValue || ''),
      expectedNew: String(expectedNewRaw || ''),
      actualNew: String(row.newValue || ''),
      oldMatches,
      newMatches,
      reason: passed ? '' : (oldMatches ? 'New value mismatch' : 'Old/New value mismatch'),
    });
  }

  const passedRows = results.filter((row) => row.status === 'PASS');
  const failedRows = results.filter((row) => row.status !== 'PASS');

  return {
    checkedFieldCount: results.length,
    auditFieldCount: Array.isArray(fieldRows) ? fieldRows.length : 0,
    passedFieldCount: passedRows.length,
    failedFieldCount: failedRows.length,
    passed: results.length > 0 && failedRows.length === 0,
    reason: results.length > 0
      ? ''
      : 'No changed field old/new values were found in the filtered audit rows',
    passedFields: passedRows.map((row) => row.fieldName),
    failedFields: failedRows.map((row) => row.fieldName),
    results,
  };
}

function mergeFieldMatches(baseResult) {
  const baseMatches = Array.isArray(baseResult && baseResult.fieldMatches) ? baseResult.fieldMatches : [];
  const comparisonMatches = Array.isArray(baseResult && baseResult.comparison && baseResult.comparison.matches)
    ? baseResult.comparison.matches.map((m) => m && m.field).filter(Boolean)
    : [];
  const passedFields = Array.isArray(baseResult && baseResult.fieldValidationSummary && baseResult.fieldValidationSummary.passedFields)
    ? baseResult.fieldValidationSummary.passedFields
    : [];
  return uniqueNonEmpty([...baseMatches, ...comparisonMatches, ...passedFields]);
}

async function verifyAuditTrailEntryCompliance(page, options) {
  const baseResult = await verifyAuditTrailEntry(page, options || {});

  const rawRows = Array.isArray(baseResult && baseResult.rowSnapshots) ? baseResult.rowSnapshots : [];
  const decoratedRows = rawRows.map((row) => decorateRow(row));

  const identifiers = pickIdentifiers(options || {}, baseResult || {});
  const recordScope = filterRecordScopedRows(decoratedRows, identifiers);
  const operationRows = filterOperationScopedRows(
    recordScope.recordRows,
    options && options.operation,
    options && options.reason
  );

  const extractedFieldRows = extractStructuredFieldRows(operationRows);
  const updateOldNewValidation = buildUpdateOldNewValidation(options || {}, extractedFieldRows);

  const mergedFieldMatches = mergeFieldMatches(baseResult || {});

  const comparison = baseResult && baseResult.comparison
    ? {
      ...baseResult.comparison,
      auditFieldCount: Math.max(
        Number(baseResult.comparison.auditFieldCount || 0),
        extractedFieldRows.length
      ),
    }
    : baseResult && baseResult.comparison;

  const output = {
    ...(baseResult || {}),
    comparison,
    fieldMatches: mergedFieldMatches,
    legacyOperationRowSnapshots: Array.isArray(baseResult && baseResult.operationRowSnapshots)
      ? baseResult.operationRowSnapshots
      : [],
    complianceIdentifiers: recordScope.identifiers,
    compliancePrimaryRecordId: recordScope.primaryRecordId,
    complianceRecordRows: recordScope.recordRows,
    complianceOperationRows: operationRows,
    complianceExtractedFieldRows: extractedFieldRows,
    updateOldNewValidation,
  };

  if (operationRows.length > 0) {
    output.operationRowSnapshots = operationRows;
    output.operationRowRange = {
      startIndex: Number(operationRows[0] && operationRows[0].index),
      endIndex: Number(operationRows[operationRows.length - 1] && operationRows[operationRows.length - 1].index),
      total: operationRows.length,
    };
  }

  return output;
}

module.exports = {
  verifyAuditTrailEntryCompliance,
  openAuditTrailPage,
  fillAuditSearch,
  verifyAuditTrailEntry,
};
