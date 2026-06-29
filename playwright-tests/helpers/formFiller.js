/**
 * helpers/formFiller.js
 *
 * Shared low-level field fillers for QuickFlow offcanvas forms.
 */

function randomNumber(min = 1, max = 9999) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomDate() {
  const date = new Date();
  date.setDate(date.getDate() - randomNumber(1, 365));
  return date.toISOString().split('T')[0];
}

function randomTime() {
  const hours = String(randomNumber(0, 23)).padStart(2, '0');
  const minutes = String(randomNumber(0, 59)).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function randomText(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function defaultTextByField(fieldInfo, fallback = 'QA Entry') {
  const label = String(fieldInfo?.displayName || fieldInfo?.columnToShow || fieldInfo?.id || '').toLowerCase();
  // Generate highly random stamp with alphanumeric characters for uniqueness
  const randomStamp = randomText(8) + String(Date.now()).slice(-5);
  const randomDigits = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

  if (/site\s*name/.test(label)) return `Ahmedabad QA Site ${randomStamp}`;
  if (/app\s*name|application\s*name/.test(label)) return `Quality Management App ${randomStamp}`;
  if (/app\s*code|application\s*code/.test(label)) return `${randomText(2).toUpperCase()}${randomDigits.slice(0,1)}`;
  if (/site\s*code|location\s*code|plant\s*code/.test(label)) return `ST${randomDigits.slice(0, 5)}`;
  if (/template\s*code|sub\s*template\s*code/.test(label)) return `TP${randomDigits.slice(0, 5)}`;
  if (/workflow\s*code/.test(label)) return `WF${randomDigits.slice(0, 5)}`;
  if (/sub\s*template\s*name/.test(label)) return `QC Sub Template ${randomStamp}`;
  if (/template\s*name/.test(label)) return `QC Template ${randomStamp}`;
  if (/workflow\s*name/.test(label)) return `Template Workflow ${randomStamp}`;
  if (/country/.test(label)) return 'India';
  if (/time\s*zone|timezone|\btz\b/.test(label)) return 'India ( +05:30 )';
  if (/address/.test(label)) return `42, Pharma Park Road, Ahmedabad ${randomStamp}`;
  if (/city/.test(label)) return 'Ahmedabad';
  if (/state/.test(label)) return 'Gujarat';
  if (/pin|zip|postal/.test(label)) return `380${randomDigits.slice(0, 3)}`;
  if (/email/.test(label)) return `qa${randomDigits}@pharmatest.in`;
  if (/phone|mobile|contact/.test(label)) return `9${String(100000000 + Math.floor(Math.random() * 899999999)).padStart(9, '0')}`;
  if (/code|short/.test(label)) return `${randomText(3)}${randomDigits.slice(0, 4)}`;
  if (/remark|note|comment|description|detail|summary|instruction/.test(label)) {
    return `Created for QA workflow validation. ${randomStamp}`;
  }

  const cleaned = String(fieldInfo?.displayName || fallback)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cleaned || fallback} ${randomStamp}`;
}

function clampValueToField(fieldInfo, value) {
  const limit = Number(fieldInfo?.maxLength || 0) || 0;
  if (!limit) return value;

  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return text.slice(0, limit);
}

function fieldRootResolverSource() {
  return `({ idx, id }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const candidates = Array.from(document.querySelectorAll(
      '.offcanvas.show .offcanvas-body, #masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas-body'
    ));

    const offcanvas = candidates.find((el) => isVisible(el)) || candidates[0] || null;
    if (!offcanvas) return null;

    const eleRoots = Array.from(offcanvas.querySelectorAll('.ele')).filter((el) => isVisible(el));
    const fallbackRoots = Array.from(
      offcanvas.querySelectorAll(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, div.checkboxlist, [role="combobox"], .react-select__control, .select2-selection, .form-switch, .form-check, [contenteditable="true"], .ql-editor, .tox-edit-area, .mce-edit-area, .ace_editor, [class*="editor"]'
      )
    ).filter((el) => isVisible(el));

    const byIdCandidates = id ? Array.from(offcanvas.querySelectorAll('#' + CSS.escape(id))) : [];
    const byId = byIdCandidates.find((el) => isVisible(el)) || byIdCandidates[0] || null;
    if (byId) return byId;

    if (id) {
      const bySynthetic = offcanvas.querySelector('[data-qf-field-id="' + id + '"]');
      if (bySynthetic) return bySynthetic;
    }

    return eleRoots[idx] || fallbackRoots[idx] || null;
  }`;
}

async function detectFieldInfo(page, idx, dtl = []) {
  return page.evaluate(({ idx, dtl }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const candidates = Array.from(document.querySelectorAll(
      '.offcanvas.show .offcanvas-body, #masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas-body'
    ));

    const offcanvas = candidates.find((el) => isVisible(el)) || candidates[0] || null;
    if (!offcanvas) return null;

    const roots = Array.from(offcanvas.querySelectorAll('.ele')).filter((el) => isVisible(el));
    const el = roots[idx] || null;
    if (!el) return null;

    const tagName = el.tagName.toLowerCase();
    const id = el.getAttribute('id') || '';
    const className = el.getAttribute('class') || '';
    const type = el.getAttribute('type') || '';
    const disabled = !!el.disabled;

    let elementType = tagName;
    if (tagName === 'input') {
      elementType = type || 'text';
      if (className.includes('numeric')) elementType = 'number';
      else if (className.includes('datetimepicker-input')) elementType = 'date';
    } else if (tagName === 'textarea') {
      elementType = 'textarea';
    } else if (tagName === 'select') {
      elementType = el.multiple ? 'multiselect' : 'select';
    } else if (tagName === 'div') {
      if (className.includes('checkboxlist')) {
        elementType = 'checkbox';
      } else {
        const nestedSelect = el.querySelector('select');
        if (nestedSelect) {
          elementType = nestedSelect.multiple ? 'multiselect' : 'select';
        } else if (
          el.querySelector('[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete], .react-select__control, .select2-selection')
        ) {
          elementType = 'customselect';
        } else if (el.querySelectorAll('input[type="checkbox"]').length > 1) {
          // Dropdown-style multi-checkbox list (e.g. Site field with multiple checkboxes in a dropdown)
          elementType = 'checkbox';
        }
      }
    }

    const meta = dtl.find((item) => `${item.vColName}${item.iFormDtlId}` === id) || null;
    const displayName = meta?.vDisplayName || id;
    const columnToShow = meta?.vColumnToShow || displayName;
    const nestedTextControl = el.matches('input, textarea')
      ? el
      : el.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea');
    const maxLengthAttr = Number(nestedTextControl?.getAttribute('maxlength') || el.getAttribute('maxlength') || 0) || 0;
    const maxLengthMeta = Number(meta?.iMaxLength || meta?.vMaxLength || 0) || 0;
    const maxLength = Math.max(maxLengthAttr, maxLengthMeta);

    return { idx, id, disabled, displayName, columnToShow, elementType, maxLength };
  }, { idx, dtl });
}

async function scrollFieldIntoView(page, idx, id) {
  await page.evaluate(({ idx, id, resolverSource }) => {
    const resolveRoot = new Function(`return (${resolverSource});`)();
    const root = resolveRoot({ idx, id });
    if (root) root.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, { idx, id, resolverSource: fieldRootResolverSource() });
}

async function fillTextLikeField(page, idx, id, value) {
  // First, find the target element's selector
  const targetSelector = await page.evaluate(({ idx, id, resolverSource }) => {
    const resolveRoot = new Function(`return (${resolverSource});`)();
    const root = resolveRoot({ idx, id });
    if (!root) return null;

    const target = root.matches('input, textarea')
      ? root
      : root.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea');
    if (!target) return null;

    // Always target the exact resolved control instance, not a global id/name match.
    const uid = `_pwtmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    target.setAttribute('data-pw-fill', uid);
    return `[data-pw-fill="${uid}"]`;
  }, { idx, id, resolverSource: fieldRootResolverSource() });

  if (!targetSelector) return false;

  try {
    // Use real typing so React-controlled inputs receive the full keyboard/input lifecycle.
    const locator = page.locator(targetSelector).first();
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(120);
    await locator.press('Control+A').catch(() => {});
    await locator.press('Delete').catch(() => {});
    await page.waitForTimeout(80);
    await locator.type(value, { delay: 20, timeout: 5000 });
    await page.waitForTimeout(180);

    // Trigger validation and dependency listeners after the real typing sequence.
    // Also use React's nativeInputValueSetter to ensure React-controlled inputs
    // update their internal state (required for FormValidation.io to see the value).
    await page.evaluate(({ selector, val }) => {
      const el = document.querySelector(selector);
      if (!el) return;

      // Use React's internal setter to update controlled input state
      try {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set || Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, val);
        }
      } catch {}

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
      el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'a', charCode: 'a'.charCodeAt(0) }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
      
      if (window.$) {
        window.$(el).trigger('input');
        window.$(el).trigger('keyup');
        window.$(el).trigger('change');
        window.$(el).trigger('blur');
      }
    }, { selector: targetSelector, val: value });

    await page.waitForTimeout(300);  // Wait for validation to run
    return true;
  } catch {
    // Fallback: use evaluate-based value setting
    return page.evaluate(({ idx, id, value, resolverSource }) => {
      const resolveRoot = new Function(`return (${resolverSource});`)();
      const root = resolveRoot({ idx, id });
      if (!root) return false;

      const target = root.matches('input, textarea')
        ? root
        : root.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea');
      if (!target) return false;

      target.focus();
      target.value = value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      if (window.$) window.$(target).trigger('change');
      return true;
    }, { idx, id, value, resolverSource: fieldRootResolverSource() });
  }
}

async function fillNativeSelect(page, idx, id, existingValues = [], multiSelect = false, preferredLabel = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    // Step 1: Discover available options and choose one
    const choiceInfo = await page.evaluate(({ idx, id, existingValues, preferredLabel, resolverSource }) => {
      const resolveRoot = new Function(`return (${resolverSource});`)();
      const root = resolveRoot({ idx, id });
      if (!root) return null;

      const selectEl = root.tagName?.toLowerCase() === 'select' ? root : root.querySelector('select');
      if (!selectEl) return null;

      const options = Array.from(selectEl.options)
        .filter((opt) => opt.value && opt.value !== '-1' && opt.value !== '')
        .map((opt) => ({ value: opt.value, label: (opt.textContent || '').trim() }))
        .filter((opt) => opt.label);
      if (!options.length) return null;

      const preferred = preferredLabel ? options.find((opt) => opt.label === preferredLabel) : null;
      const available = options.filter((opt) => !existingValues.includes(opt.label));
      const pool = available.length ? available : options;
      const chosen = preferred || pool[Math.floor(Math.random() * pool.length)];
      if (!chosen) return null;

      // Return the select element's selector and the chosen value
      const uid = `_pwselect_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      selectEl.setAttribute('data-pw-select', uid);
      return { value: chosen.value, label: chosen.label, selectSelector: `[data-pw-select="${uid}"]` };
    }, { idx, id, existingValues, preferredLabel, resolverSource: fieldRootResolverSource() });

    if (choiceInfo) {
      // Step 2: Use Playwright's selectOption for real user interaction
      try {
        await page.locator(choiceInfo.selectSelector).first().selectOption(choiceInfo.value, { timeout: 3000 });

        // Trigger blur + jQuery change (some apps fire cascading loads on blur)
        await page.evaluate(({ selectSelector }) => {
          const selectEl = document.querySelector(selectSelector);
          if (!selectEl) return;

          selectEl.dispatchEvent(new Event('blur', { bubbles: true }));
          selectEl.dispatchEvent(new Event('focusout', { bubbles: true }));
          if (window.$) {
            window.$(selectEl).trigger('change');
            window.$(selectEl).trigger('blur');
          }
        }, { selectSelector: choiceInfo.selectSelector });

        // Wait for any AJAX calls triggered by the selection
        await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});

        return choiceInfo.label;
      } catch {
        // Fallback: use evaluate-based value setting if selectOption fails
        const fallbackResult = await page.evaluate(({ idx, id, value, resolverSource }) => {
          const resolveRoot = new Function(`return (${resolverSource});`)();
          const root = resolveRoot({ idx, id });
          if (!root) return null;

          const selectEl = root.tagName?.toLowerCase() === 'select' ? root : root.querySelector('select');
          if (!selectEl) return null;

          selectEl.value = value;
          selectEl.dispatchEvent(new Event('input', { bubbles: true }));
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.$) window.$(selectEl).trigger('change');

          const selected = selectEl.selectedOptions?.[0];
          return (selected?.textContent || '').trim() || null;
        }, { idx, id, value: choiceInfo.value, resolverSource: fieldRootResolverSource() });

        if (fallbackResult) return fallbackResult;
      }
    }

    await page.waitForTimeout(350 + attempt * 200);
  }

  return null;
}

async function waitForDependentFieldsToPopulate(page, currentFieldIdx, fields, maxWaitMs = 3000) {
  /**
   * After filling a parent select field, wait for dependent child select fields
   * to populate with options. This triggers the app's onchange handlers and allows
   * backend/JavaScript to fetch dependent dropdown options.
   */
  if (!fields || !fields.length) return;

  const startTime = Date.now();
  const checkIntervalMs = 150;

  while (Date.now() - startTime < maxWaitMs) {
    const dependentFieldPopulated = await page.evaluate(
      ({ currentIdx, fieldsList, resolverSource: rs }) => {
        const resolveRoot = new Function(`return (${rs});`)();

        // Check fields AFTER current index for select fields that now have options
        for (let i = currentIdx + 1; i < fieldsList.length; i++) {
          const field = fieldsList[i];
          if (!['select', 'multiselect', 'customselect'].includes(field.elementType)) continue;

          const root = resolveRoot({ idx: i, id: field.id });
          if (!root) continue;

          const selectEl = root.tagName?.toLowerCase() === 'select' ? root : root.querySelector('select');
          if (!selectEl) continue;

          const optionCount = Array.from(selectEl.options).filter(
            (opt) => opt.value && opt.value !== '-1' && opt.value !== ''
          ).length;

          // At least one selectable option means the dependent field is populated.
          if (optionCount > 0) {
            return true;
          }
        }

        return false;
      },
      {
        currentIdx: currentFieldIdx,
        fieldsList: fields,
        resolverSource: fieldRootResolverSource(),
      }
    );

    if (dependentFieldPopulated) {
      return;
    }

    await page.waitForTimeout(checkIntervalMs);
  }
}

async function readCustomSelectValue(page, idx, id) {
  return page.evaluate(({ idx, id, resolverSource }) => {
    const resolveRoot = new Function(`return (${resolverSource});`)();
    const root = resolveRoot({ idx, id });
    if (!root) return null;

    // ── Strategy 1: named single-value elements (various react-select / select2 conventions) ──
    // react-select v5 with emotion generates CamelCase class suffixes, e.g. css-[hash]-SingleValue
    // react-select v3/v4 generates camelCase suffixes, e.g. css-[hash]-singleValue
    // When classNamePrefix is set, react-select also adds e.g. react-select__single-value
    const singleValueSelectors = [
      '.select2-selection__rendered',
      '.react-select__single-value',
      '[class*="-SingleValue"]',   // emotion CamelCase (react-select v5)
      '[class*="singleValue"]',    // emotion camelCase (react-select v3/v4)
      '[class*="single-value"]',   // kebab-case fallback
    ];
    for (const sel of singleValueSelectors) {
      const node = root.querySelector(sel);
      const text = (node?.textContent || '').trim();
      if (text) return text;
    }

    // ── Strategy 2: scan visible children of the value container ──
    // The value container holds either the placeholder or the selected value div.
    // After selection: placeholder is hidden/removed; a single-value div is present.
    const valueContainerSelectors = [
      '[class*="ValueContainer"]',   // emotion CamelCase (react-select v5)
      '[class*="valueContainer"]',   // camelCase variant
      '[class*="value-container"]',  // kebab-case variant
    ];
    for (const vcSel of valueContainerSelectors) {
      const vc = root.querySelector(vcSel);
      if (!vc) continue;
      for (const child of Array.from(vc.children)) {
        const cs = window.getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        // Skip the invisible input wrapper (contains the real <input role="combobox">)
        if (child.querySelector('input[role="combobox"], input[aria-autocomplete]')) continue;
        // Skip placeholder divs (their id ends with -placeholder)
        if (child.id && /-placeholder$/i.test(child.id)) continue;
        const text = (child.textContent || '').trim();
        if (text) return text;
      }
    }

    // ── Strategy 3: plain input value (native selects or non-react-select controls) ──
    const input = root.querySelector('input:not([type="hidden"])');
    if (input && input.value && input.value.trim()) return input.value.trim();

    return null;
  }, { idx, id, resolverSource: fieldRootResolverSource() });
}

async function readFieldValue(page, idx, fieldInfo) {
  const { id, elementType } = fieldInfo;

  if (elementType === 'customselect') {
    return readCustomSelectValue(page, idx, id);
  }

  return page.evaluate(({ idx, id, elementType, resolverSource }) => {
    const resolveRoot = new Function(`return (${resolverSource});`)();
    const root = resolveRoot({ idx, id });
    if (!root) return null;

    if (elementType === 'select' || elementType === 'multiselect') {
      const selectEl = root.tagName?.toLowerCase() === 'select' ? root : root.querySelector('select');
      if (!selectEl) return null;
      const selected = Array.from(selectEl.selectedOptions || []).map((opt) => (opt.textContent || '').trim()).filter(Boolean);
      return selected.length ? selected.join(', ') : null;
    }

    if (elementType === 'checkbox') {
      const checked = Array.from(root.querySelectorAll('input[type="checkbox"]:checked'));
      const labels = checked.map((cb) => {
        const label = (cb.closest('label, li, div')?.textContent || cb.value || cb.id || '').trim();
        return label || 'checked';
      }).filter((l) => !/^\s*(select\s+all|all)\s*$/i.test(l));
      return labels.length ? labels.join(', ') : null;
    }

    if (elementType === 'radio') {
      const checked = root.querySelector('input[type="radio"]:checked');
      if (!checked) return null;
      const label = checked.closest('label');
      return (label?.textContent || '').trim() || checked.value || checked.id || 'selected';
    }

    if (elementType === 'richtext') {
      // Try Quill API first
      const quillContainer = root.querySelector('.ql-container, .quill, [class*="quill"]') || root;
      if (quillContainer && window.Quill) {
        const quillInstance = quillContainer.__quill || window.Quill.instances?.find(q => q.container.contains(quillContainer));
        if (quillInstance) {
          const contents = quillInstance.getContents();
          const text = contents.ops?.map(op => op.insert || '').join('').replace(/\s+/g, ' ').trim();
          if (text) return text;
        }
      }

      // Fallback to DOM reading
      const richNode = root.querySelector('.ql-editor, [contenteditable="true"], .tox-edit-area, .mce-edit-area') || root;
      const text = (richNode.textContent || richNode.innerHTML || '').replace(/\s+/g, ' ').trim();
      return text || null;
    }

    const field = root.matches('input, textarea, select')
      ? root
      : root.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select');
    if (!field) return null;

    const value = 'value' in field ? field.value : field.textContent;
    const trimmed = String(value || '').trim();
    return trimmed || null;
  }, { idx, id, elementType, resolverSource: fieldRootResolverSource() });
}

async function fillCustomSelect(page, idx, id, existingValues = [], preferredLabel = null, attempt = 0) {
  const rootSelector = await page.evaluate(({ idx, id, resolverSource }) => {
    const resolveRoot = new Function(`return (${resolverSource});`)();
    const root = resolveRoot({ idx, id });
    if (!root) return null;
    const uid = `_pwroot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    root.setAttribute('data-pw-root', uid);
    return `[data-pw-root="${uid}"]`;
  }, { idx, id, resolverSource: fieldRootResolverSource() });

  if (!rootSelector) return null;

  const openTargets = [
    `${rootSelector} [role="combobox"]`,
    `${rootSelector} .select2-selection`,
    `${rootSelector} [aria-haspopup="listbox"]`,
    `${rootSelector} input:not([type="hidden"]):not([disabled])`,
    rootSelector,
  ].filter(Boolean);

  // Click to open dropdown
  for (const selector of openTargets) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    await locator.click({ force: true, timeout: 2500 }).catch(() => {});
    break;
  }

  await page.waitForTimeout(500);

  // Get visible options from the currently open dropdown menu/listbox.
  const options = await page.evaluate(() => {
    const isVisible = (el) => {
      const style = window.getComputedStyle(el);
      return style && style.visibility !== 'hidden' && style.display !== 'none' && el.offsetParent !== null;
    };

    const menuContainers = Array.from(document.querySelectorAll(
      '.select2-container--open .select2-results, .react-select__menu, [role="listbox"]'
    )).filter(isVisible);
    const activeContainer = menuContainers[menuContainers.length - 1] || null;

    const source = activeContainer || document;
    const selectors = [
      '.select2-results__option',
      '.react-select__option',
      '[class*="menu-list"] [class*="option"]',
      '[id*="react-select"][id*="option"]',
      '[role="option"]',
      '[role="listbox"] > *',
    ];

    const found = [];
    for (const selector of selectors) {
      const nodes = Array.from(source.querySelectorAll(selector)).filter(isVisible);
      for (const node of nodes) {
        const label = (node.textContent || '').trim();
        if (!label || /^\s*(please\s+select|select|choose|none|--\s*select)\s*$/i.test(label)) continue;
        if (!found.includes(label)) found.push(label);
      }
      if (found.length) break;
    }

    return found;
  });

  if (!options.length) {
    return null;
  }

  // ── If a preferred value is given, type it first to filter the dropdown,
  //    then re-read the options to get an exact (or closest) match.
  let filteredOptions = options;
  if (preferredLabel) {
    const inputLocatorEarly = page.locator(`${rootSelector} input:not([type="hidden"]):not([disabled])`).first();
    const inputVisibleEarly = await inputLocatorEarly.isVisible().catch(() => false);
    if (inputVisibleEarly) {
      await inputLocatorEarly.fill('').catch(() => {});
      await inputLocatorEarly.type(preferredLabel.slice(0, Math.min(preferredLabel.length, 20)), { delay: 20 }).catch(() => {});
      await page.waitForTimeout(500);
      // Re-read the (now filtered) options
      filteredOptions = await page.evaluate(() => {
        const isVisible = (el) => {
          const style = window.getComputedStyle(el);
          return style && style.visibility !== 'hidden' && style.display !== 'none' && el.offsetParent !== null;
        };
        const menuContainers = Array.from(document.querySelectorAll(
          '.select2-container--open .select2-results, .react-select__menu, [role="listbox"]'
        )).filter(isVisible);
        const activeContainer = menuContainers[menuContainers.length - 1] || null;
        const source = activeContainer || document;
        const selectors = [
          '.select2-results__option', '.react-select__option',
          '[class*="menu-list"] [class*="option"]',
          '[id*="react-select"][id*="option"]',
          '[role="option"]', '[role="listbox"] > *',
        ];
        const found = [];
        for (const selector of selectors) {
          const nodes = Array.from(source.querySelectorAll(selector)).filter(isVisible);
          for (const node of nodes) {
            const label = (node.textContent || '').trim();
            if (!label || /^\s*(please\s+select|select|choose|none|--\s*select)\s*$/i.test(label)) continue;
            if (!found.includes(label)) found.push(label);
          }
          if (found.length) break;
        }
        return found;
      });
    }
  }

  // Exact match first, then case-insensitive contains match
  const normalizeOption = (s) => String(s || '').trim().toLowerCase();
  const preferred = preferredLabel
    ? (filteredOptions.find((o) => o === preferredLabel) ||
       filteredOptions.find((o) => normalizeOption(o) === normalizeOption(preferredLabel)) ||
       filteredOptions.find((o) => normalizeOption(o).includes(normalizeOption(preferredLabel))) ||
       null)
    : null;
  const available = (preferred ? filteredOptions : options).filter((label) => !existingValues.includes(label));
  const pool = available.length ? available : (preferred ? filteredOptions : options);
  const chosen = preferred || randomChoice(pool);
  if (!chosen) return null;

  // If we haven't typed yet (no preferredLabel filtering done above), type now to filter
  const inputLocator = page.locator(`${rootSelector} input:not([type="hidden"]):not([disabled])`).first();
  const inputVisible = await inputLocator.isVisible().catch(() => false);
  if (inputVisible && !preferredLabel) {
    try {
      await inputLocator.fill('').catch(() => {});
      await inputLocator.type(chosen.slice(0, Math.min(chosen.length, 10)), { delay: 20 }).catch(() => {});
      await page.waitForTimeout(300);
    } catch (e) {
      // Ignore input errors
    }
  }

  // Use Playwright-native clicks so React Select internal state updates correctly.
  let optionClicked = false;
  const escaped = chosen.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const optionLocators = [
    page.locator(`.react-select__option:has-text("${escaped}")`).first(),
    page.locator(`.select2-results__option:has-text("${escaped}")`).first(),
    page.locator(`[role="option"]:has-text("${escaped}")`).first(),
    page.locator(`[role="listbox"] > *:has-text("${escaped}")`).first(),
  ];

  for (const locator of optionLocators) {
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    try {
      await locator.click({ timeout: 2500, force: true });
      optionClicked = true;
      break;
    } catch {
      // try next locator
    }
  }

  if (!optionClicked && inputVisible) {
    // Keyboard fallback for React Select
    await inputLocator.click({ force: true, timeout: 1500 }).catch(() => {});
    await inputLocator.press('ArrowDown').catch(() => {});
    await inputLocator.press('Enter').catch(() => {});
    optionClicked = true;
  }

  // Wait for form state to update and trigger validation
  await page.waitForTimeout(800);
  
  // Dispatch change events on the select wrapper and trigger form validation.
  // Also update any hidden <select> backing element that FormValidation.io may validate.
  await page.evaluate(({ rootSelector, chosenLabel }) => {
    const root = document.querySelector(rootSelector);
    if (!root) return;
    
    // Find all interactive elements including hidden inputs that might hold the actual value
    const elements = root.querySelectorAll('input, select, [role="combobox"], [role="listbox"]');
    for (const el of elements) {
      // Focus the element first to ensure it's in the validation context
      if (typeof el.focus === 'function') {
        try { el.focus(); } catch {}
      }
      
      // Dispatch all relevant events
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      el.dispatchEvent(new Event('focusout', { bubbles: true }));
      
      // Trigger keyboard events that some validation libraries listen for
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
      
      if (window.$) {
        window.$(el).trigger('input');
        window.$(el).trigger('change');
        window.$(el).trigger('blur');
        window.$(el).trigger('focusout');
      }
    }
    
    // Also trigger events on the root container itself
    root.dispatchEvent(new Event('change', { bubbles: true }));
    root.dispatchEvent(new Event('blur', { bubbles: true }));
    if (window.$) {
      window.$(root).trigger('change');
      window.$(root).trigger('blur');
    }

    // If there is a hidden <select> backing element (used by FormValidation.io),
    // try to set its value to match the chosen label so validation passes.
    // Search both inside the root element AND in the entire offcanvas, because
    // some apps place the hidden <select> outside the widget's .ele container.
    if (chosenLabel) {
      const offcanvas = document.querySelector(
        '.offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body'
      );
      const searchRoots = [root, offcanvas].filter(Boolean);
      const isVisible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
      };

      for (const searchRoot of searchRoots) {
        const hiddenSelects = Array.from(searchRoot.querySelectorAll('select')).filter((s) => !isVisible(s));
        for (const sel of hiddenSelects) {
          const matchingOption = Array.from(sel.options).find(
            (opt) => (opt.textContent || '').trim().toLowerCase() === chosenLabel.toLowerCase()
          );
          if (matchingOption && sel.value !== matchingOption.value) {
            sel.value = matchingOption.value;
            sel.dispatchEvent(new Event('input',  { bubbles: true }));
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            sel.dispatchEvent(new Event('blur',   { bubbles: true }));
            if (window.$) {
              window.$(sel).trigger('change');
              window.$(sel).trigger('blur');
            }
          }
        }
      }
    }
  }, { rootSelector, chosenLabel: chosen });

  // Wait longer for validation to process and form state to stabilize
  await page.waitForTimeout(500);

  // Do not assume chosen label was applied; verify actual selected value from UI state.
  let actual = await readCustomSelectValue(page, idx, id);

  if (!actual) {
    // Retry with keyboard select to force value commit for controls that require Enter.
    if (inputVisible) {
      await inputLocator.click({ force: true, timeout: 1500 }).catch(() => {});
      await inputLocator.fill('').catch(() => {});
      await inputLocator.type(chosen, { delay: 20 }).catch(() => {});
      await inputLocator.press('Enter').catch(() => {});
      await inputLocator.press('Tab').catch(() => {});
      await page.waitForTimeout(350);
      actual = await readCustomSelectValue(page, idx, id);
    }
  }

  if (!actual) return null;

  const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const actualNorm = norm(actual);
  const chosenNorm = norm(chosen);
  if (!chosenNorm) return actual;

  // Accept if selected text contains chosen text (or vice versa) to handle formatted labels.
  if (actualNorm.includes(chosenNorm) || chosenNorm.includes(actualNorm)) {
    // Some dependent dropdowns briefly show value and then clear after async option refresh.
    await page.waitForTimeout(450);
    const stabilized = await readCustomSelectValue(page, idx, id);
    if (!stabilized && attempt < 1) {
      return fillCustomSelect(page, idx, id, existingValues, preferredLabel || chosen, attempt + 1);
    }
    return stabilized || actual;
  }

  return null;
}

async function fillField(page, idx, fieldInfo, existingValues = [], preferredValue = null) {
  const { elementType, id } = fieldInfo;
  await scrollFieldIntoView(page, idx, id);
  await page.waitForTimeout(250);

  let filledValue = null;

  switch (elementType) {
    case 'text':
    case 'email':
    case 'tel':
    case 'encryptedtext':
    case 'password': {
      const value = clampValueToField(fieldInfo, preferredValue ?? defaultTextByField(fieldInfo));
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'textarea': {
      const value = clampValueToField(fieldInfo, preferredValue ?? defaultTextByField(fieldInfo, 'QA Note'));
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'number':
    case 'decimal': {
      const value = clampValueToField(fieldInfo, String(preferredValue ?? randomNumber(1, 9999)));
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'date': {
      const value = clampValueToField(fieldInfo, preferredValue ?? randomDate());
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'time': {
      const value = clampValueToField(fieldInfo, preferredValue ?? randomTime());
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'dateandtime': {
      const value = clampValueToField(fieldInfo, preferredValue ?? `${randomDate()} ${randomTime()}`);
      await fillTextLikeField(page, idx, id, value);
      filledValue = value;
      break;
    }

    case 'select': {
      filledValue = await fillNativeSelect(page, idx, id, existingValues, false, preferredValue);
      if (filledValue === null) {
        filledValue = await fillCustomSelect(page, idx, id, existingValues, preferredValue);
      }
      break;
    }

    case 'multiselect': {
      filledValue = await fillNativeSelect(page, idx, id, existingValues, true, preferredValue);
      break;
    }

    case 'customselect': {
      filledValue = await fillCustomSelect(page, idx, id, existingValues, preferredValue);
      break;
    }

    case 'richtext': {
      const value = preferredValue ?? `Sample content: ${randomText(8)}`;
      filledValue = await page.evaluate(({ idx, id, value, resolverSource }) => {
        const resolveRoot = new Function(`return (${resolverSource});`)();
        const root = resolveRoot({ idx, id });
        if (!root) return null;

        // Strategy 1: Try to find Quill editor and set via HTML + events
        const quillEditor = root.querySelector('.ql-editor');
        if (quillEditor) {
          // Clear existing content
          quillEditor.innerHTML = '';
          quillEditor.textContent = value;
          
          // Trigger Quill text-change event
          const textChangeEvent = new Event('text-change', { bubbles: true, cancelable: true });
          quillEditor.dispatchEvent(textChangeEvent);
          
          // Also trigger input and change events
          quillEditor.dispatchEvent(new Event('input', { bubbles: true }));
          quillEditor.dispatchEvent(new Event('change', { bubbles: true }));
          
          // Try to find Quill instance in parent containers
          let container = quillEditor.parentElement;
          for (let i = 0; i < 5; i++) {
            if (!container) break;
            // Try accessing Quill instance from various locations
            if (container.__quill) {
              try {
                container.__quill.setContents([{ insert: value }], 'user');
                return value;
              } catch (e) {
                // Continue if Quill API fails
              }
            }
            container = container.parentElement;
          }
          
          return value; // Return success even if we just set HTML
        }

        // Strategy 2: Try TinyMCE editor
        const tinyFrame = root.querySelector('.tox-edit-area iframe');
        if (tinyFrame && window.tinymce) {
          const editors = window.tinymce.get();
          const editor = editors.find((ed) => ed.contentAreaContainer && ed.contentAreaContainer.contains(tinyFrame));
          if (editor) {
            editor.setContent(value);
            editor.fire('change');
            return value;
          }
        }

        // Strategy 3: Try contenteditable div
        const editableDiv = root.querySelector('[contenteditable="true"]');
        if (editableDiv) {
          editableDiv.innerHTML = value;
          editableDiv.textContent = value;
          editableDiv.dispatchEvent(new Event('input', { bubbles: true }));
          editableDiv.dispatchEvent(new Event('change', { bubbles: true }));
          return value;
        }

        // Strategy 4: Try regular textarea
        const textarea = root.querySelector('textarea');
        if (textarea) {
          textarea.value = value;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          textarea.dispatchEvent(new Event('change', { bubbles: true }));
          return value;
        }

        return null;
      }, { idx, id, value, resolverSource: fieldRootResolverSource() });
      
      // Additional Playwright-level typing as fallback
      if (!filledValue) {
        try {
          const fieldRoot = await page.evaluate(({ idx, id, resolverSource }) => {
            const resolveRoot = new Function(`return (${resolverSource});`)();
            const root = resolveRoot({ idx, id });
            if (!root) return null;
            const quillEditor = root.querySelector('.ql-editor');
            if (quillEditor) {
              quillEditor.setAttribute('data-pw-root', `_qf_${Date.now()}`);
              return `[data-pw-root="_qf_${Date.now()}"]`;
            }
            return null;
          }, { idx, id, resolverSource: fieldRootResolverSource() });

          if (fieldRoot) {
            const editor = page.locator(fieldRoot).first();
            await editor.click({ force: true, timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(200);
            await editor.fill(value).catch(async () => {
              // If fill fails, try typing
              await editor.focus().catch(() => {});
              await page.waitForTimeout(100);
              await editor.type(value, { delay: 10 }).catch(() => {});
            });
            filledValue = value;
          }
        } catch (e) {
          // Silently fail and continue
        }
      }
      
      break;
    }

    case 'checkbox': {
      const rootSelector = await page.evaluate(({ idx, id, resolverSource }) => {
        const resolveRoot = new Function(`return (${resolverSource});`)();
        const root = resolveRoot({ idx, id });
        if (!root) return null;
        const uid = `_pwcbroot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        root.setAttribute('data-pw-cb-root', uid);
        return `[data-pw-cb-root="${uid}"]`;
      }, { idx, id, resolverSource: fieldRootResolverSource() });

      if (!rootSelector) return null;

      // First try: click to open dropdown if options are hidden behind a toggle.
      const checkboxDropdownOpener = page.locator(`${rootSelector} .dropdown-toggle:visible, ${rootSelector} [aria-expanded]:visible`).first();
      const openerVisible = await checkboxDropdownOpener.isVisible().catch(() => false);
      if (openerVisible) {
        await checkboxDropdownOpener.click({ force: true, timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(250);
      }

      const selectionPlan = await page.evaluate(({ rootSelector, preferredValue }) => {
        const root = document.querySelector(rootSelector);
        if (!root) return null;

        const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
        const selectable = checkboxes
          .map((cb) => {
            const label = (cb.closest('label, li, div')?.textContent || cb.id || cb.value || '').trim();
            return { cb, label };
          })
          .filter((item) => item.label && !/^\s*(select\s+all|all)\s*$/i.test(item.label));

        if (!selectable.length) return null;

        selectable.forEach((item) => {
          if (item.cb.checked) {
            item.cb.click();
          }
        });

        const preferredList = String(preferredValue || '')
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);

        let chosen = [];
        if (preferredList.length) {
          chosen = selectable.filter((item) => {
            const label = item.label.toLowerCase();
            return preferredList.some((pref) => label.includes(pref) || pref.includes(label));
          });
        }

        if (!chosen.length) {
          const count = Math.min(selectable.length, Math.floor(Math.random() * 3) + 1);
          const shuffled = selectable.slice().sort(() => Math.random() - 0.5);
          chosen = shuffled.slice(0, count);
        }

        const selectedLabels = [];
        chosen.forEach((item, index) => {
          const uid = `_pwcb_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`;
          item.cb.setAttribute('data-pw-cb', uid);
          selectedLabels.push({ uid, label: item.label });
        });

        return selectedLabels;
      }, { rootSelector, preferredValue });

      if (!selectionPlan || !selectionPlan.length) {
        filledValue = null;
        break;
      }

      for (const item of selectionPlan) {
        const cb = page.locator(`${rootSelector} input[type="checkbox"][data-pw-cb="${item.uid}"]`).first();
        const exists = await cb.count().catch(() => 0);
        if (!exists) continue;
        await cb.scrollIntoViewIfNeeded().catch(() => {});
        await cb.click({ force: true, timeout: 2000 }).catch(() => {});
      }

      await page.evaluate(({ rootSelector }) => {
        const root = document.querySelector(rootSelector);
        if (!root) return;
        const checked = root.querySelectorAll('input[type="checkbox"]:checked');
        checked.forEach((cb) => {
          cb.dispatchEvent(new Event('input', { bubbles: true }));
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          cb.dispatchEvent(new Event('blur', { bubbles: true }));
          if (window.$) {
            window.$(cb).trigger('input');
            window.$(cb).trigger('change');
            window.$(cb).trigger('blur');
          }
        });
      }, { rootSelector }).catch(() => {});

      filledValue = await page.evaluate(({ idx, id, resolverSource }) => {
        const resolveRoot = new Function(`return (${resolverSource});`)();
        const root = resolveRoot({ idx, id });
        if (!root) return null;

        // Collect all checkboxes; skip "Select All" master toggles.
        const allCheckboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));
        const selectable = allCheckboxes.filter((cb) => {
          const label = (cb.closest('label, li, div')?.textContent || cb.id || cb.value || '').trim();
          return !/^\s*(select\s+all|all)\s*$/i.test(label);
        });

        if (!selectable.length) return null;

        const labels = [];

        for (const cb of selectable) {
          if (!cb.checked) continue;
          const label = (cb.closest('label, li, div')?.textContent || cb.id || cb.value || '').trim();
          labels.push(label || 'checked');
        }

        return labels.length ? labels.join(', ') : null;
      }, { idx, id, resolverSource: fieldRootResolverSource() });

      // Close only the local dropdown opener when possible; avoid Escape which can close the offcanvas.
      if (filledValue) {
        const closeByToggle = await page.evaluate(({ idx, id, resolverSource }) => {
          const resolveRoot = new Function(`return (${resolverSource});`)();
          const root = resolveRoot({ idx, id });
          if (!root) return false;
          const opener = root.querySelector('.dropdown-toggle, [aria-expanded="true"]');
          if (!opener) return false;
          opener.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }, { idx, id, resolverSource: fieldRootResolverSource() }).catch(() => false);

        if (!closeByToggle) {
          await page.mouse.click(20, 20).catch(() => {});
        }
        await page.waitForTimeout(200);
      }
      break;
    }

    case 'radio': {
      filledValue = await page.evaluate(({ idx, id, resolverSource }) => {
        const resolveRoot = new Function(`return (${resolverSource});`)();
        const root = resolveRoot({ idx, id });
        if (!root) return null;

        const radios = Array.from(root.querySelectorAll('input[type="radio"]'));
        const first = radios[0];
        if (!first) return null;

        first.checked = true;
        first.dispatchEvent(new Event('change', { bubbles: true }));
        const label = first.closest('label');
        return (label?.textContent || '').trim() || first.id || first.value || 'selected';
      }, { idx, id, resolverSource: fieldRootResolverSource() });
      break;
    }

    default:
      console.log(`[FILL] Skipping unsupported field type: ${elementType} for #${id}`);
      break;
  }

  return filledValue;
}

async function fillOffcanvasForm(page, masterName) {
  const dtl = await page.evaluate(() =>
    [
      ...(window.data?.tblFormDtl || []),
      ...(window.data?.tblFormSubDtl || []),
    ].map((item) => ({
      vDisplayName: item.vDisplayName,
      vColumnToShow: item.vColumnToShow,
      vColName: item.vColName,
      iFormDtlId: item.iFormDtlId,
      iMaxLength: item.iMaxLength,
      vMaxLength: item.vMaxLength,
    }))
  );

  const count = await page.evaluate(() => document.querySelectorAll('.offcanvas-body .ele').length);
  const auditTrail = {};

  for (let idx = 0; idx < count; idx++) {
    const info = await detectFieldInfo(page, idx, dtl);
    if (!info) continue;

    const { id, disabled, displayName, columnToShow } = info;
    if (disabled || id.includes('RecordID') || id.includes('RecordId')) {
      console.log(`[FILL] Skipping field #${id} (disabled or RecordID)`);
      continue;
    }

    const value = await fillField(page, idx, info, Object.values(auditTrail).map(String));
    if (value !== null && value !== undefined) {
      const auditKey = String(columnToShow || displayName || id || '').trim();
      if (!auditKey) {
        console.log(`[FILL] Skipping unmapped field at index ${idx} (id="${id || ''}") with value "${value}"`);
      } else {
        auditTrail[auditKey] = value;
        console.log(`[FILL] Master "${masterName}" | Field "${auditKey}" = "${value}"`);
      }
    }

    await page.waitForTimeout(150);
  }

  return auditTrail;
}

async function verifyOffcanvasForm(page, auditTrail, masterName) {
  const dtl = await page.evaluate(() =>
    [
      ...(window.data?.tblFormDtl || []),
      ...(window.data?.tblFormSubDtl || []),
    ].map((item) => ({
      vDisplayName: item.vDisplayName,
      vColumnToShow: item.vColumnToShow,
      vColName: item.vColName,
      iFormDtlId: item.iFormDtlId,
    }))
  );

  const count = await page.evaluate(() => document.querySelectorAll('.offcanvas-body .ele').length);
  const results = [];

  for (let idx = 0; idx < count; idx++) {
    const info = await detectFieldInfo(page, idx, dtl);
    if (!info) continue;

    const key = info.columnToShow || info.displayName;
    if (!(key in auditTrail)) continue;

    const expected = auditTrail[key];
    const actual = await readCustomSelectValue(page, idx, info.id).catch(() => null);
    const fallbackActual = await page.evaluate(({ idx, id }) => {
      const offcanvas = document.querySelector(
        '#masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas.show .offcanvas-body'
      ) || document.querySelector('.offcanvas-body');
      if (!offcanvas) return null;

      const root = document.getElementById(id) || offcanvas.querySelectorAll('.ele')[idx];
      if (!root) return null;

      const field = root.matches('input, textarea, select')
        ? root
        : root.querySelector('input:not([type="hidden"]), textarea, select');
      if (!field) return null;
      if (field.tagName.toLowerCase() === 'select') {
        const selected = field.selectedOptions?.[0];
        return (selected?.textContent || '').trim();
      }
      return field.value;
    }, { idx, id: info.id });

    const observed = String(actual || fallbackActual || '').trim();
    const match = observed === String(expected || '').trim();
    results.push({ field: info.displayName, expected, actual: observed, match });
    if (!match) {
      console.warn(`[VERIFY] MISMATCH in master "${masterName}" | field "${info.displayName}": expected="${expected}" actual="${observed}"`);
    }
  }

  return results;
}

module.exports = {
  detectFieldInfo,
  fillField,
  fillOffcanvasForm,
  readFieldValue,
  verifyOffcanvasForm,
  waitForDependentFieldsToPopulate,
  randomText,
  randomNumber,
};