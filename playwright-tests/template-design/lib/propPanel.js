'use strict';

const { log } = require('./session');

/** Expand an accordion section by header id (e.g. 'propAccValidation') if collapsed. */
async function openAccordion(page, accordionId) {
  await page.evaluate((id) => {
    const hdr = document.getElementById(id);
    if (!hdr) return;
    const expanded = hdr.getAttribute('aria-expanded');
    const collapsed = hdr.classList.contains('collapsed') || expanded === 'false';
    if (collapsed) hdr.click();
  }, accordionId);
  await page.waitForTimeout(150);
}

/**
 * Set a property field by id. Handles <input>, <textarea>, <select>, and checkboxes.
 * Returns 'set' | 'skipped' (field absent/not visible) | 'error'.
 */
async function setProp(page, accordionId, fieldId, value) {
  if (accordionId) await openAccordion(page, accordionId);

  return page.evaluate(({ id, val }) => {
    const el = document.getElementById(id);
    if (!el) return 'skipped';
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.disabled) return 'skipped';

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    const fire = (node, ev) => node.dispatchEvent(new Event(ev, { bubbles: true }));
    const setNativeValue = (node, v) => {
      const proto = node instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(node, v); else node.value = v;
    };

    try {
      if (tag === 'select') {
        const wanted = String(val).toLowerCase();
        const opt = Array.from(el.options).find(
          (o) => o.value.toLowerCase() === wanted || o.text.trim().toLowerCase() === wanted,
        );
        if (!opt) return 'skipped';
        el.value = opt.value;
        fire(el, 'change');
        if (window.$) { try { window.$(el).trigger('change.select2'); } catch (_) {} }
        return 'set';
      }
      if (type === 'checkbox') {
        const want = ['yes', 'true', '1', 'on'].includes(String(val).toLowerCase());
        if (el.checked !== want) { el.click(); }
        return 'set';
      }
      // text / textarea / number / etc.
      el.focus();
      setNativeValue(el, String(val));
      fire(el, 'input');
      fire(el, 'change');
      el.blur();
      return 'set';
    } catch (e) {
      return 'error';
    }
  }, { id: fieldId, val: value }).catch(() => 'error');
}

/** Apply a list of {accordion,id,value} props. Returns {set,skipped,error} counts. */
async function applyProps(page, props) {
  const tally = { set: 0, skipped: 0, error: 0 };
  for (const p of props) {
    const r = await setProp(page, p.accordion, p.id, p.value);
    tally[r] = (tally[r] || 0) + 1;
    if (r === 'set') log(`    prop ${p.id} = ${p.value}`);
  }
  return tally;
}

module.exports = { openAccordion, setProp, applyProps };
