'use strict';

function normalizeControlType(rawType, item = {}) {
  const raw = String(rawType || '').trim();
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isMulti = ['y', 'yes', 'true', '1'].includes(
    String(item.isMultiSelect ?? item.cMultiSelect ?? item.bMultiSelect ?? item.multiSelect ?? '').toLowerCase()
  );

  if (!normalized) return '';
  if (normalized === 'textarea' || normalized === 'editor' || normalized === 'richtext' || normalized === 'richtexteditor' || normalized === 'htmleditor') return 'richtext';
  if (normalized === 'text' || normalized === 'password' || normalized === 'encryptedtext') return 'text';
  if (normalized === 'email' || normalized === 'emailto') return 'email';
  if (normalized === 'tel' || normalized === 'phone' || normalized === 'mobile') return 'tel';
  if (normalized === 'number' || normalized === 'numeric' || normalized === 'integer') return 'number';
  if (normalized === 'decimal' || normalized === 'float' || normalized === 'double' || normalized === 'decimalfieldcontroller') return 'decimal';
  if (normalized === 'date') return 'date';
  if (normalized === 'time') return 'time';
  if (normalized === 'datetime' || normalized === 'dateandtime' || normalized === 'serverdatetime' || normalized === 'approvedatetime') return 'dateandtime';
  if (normalized === 'radio') return 'radio';
  if (normalized === 'checkbox' || normalized === 'checkboxlist') return 'checkbox';
  if (normalized === 'multiselect') return 'multiselect';
  if (normalized === 'select' || normalized === 'dropdown' || normalized === 'combobox' || normalized === 'optionlist' || normalized === 'lookup') {
    return isMulti ? 'multiselect' : 'select';
  }
  if (normalized === 'file' || normalized === 'emailattachment') return 'file';
  return raw.toLowerCase();
}

async function collectFormFields(page) {
  return page.evaluate((normalizeControlTypeSource) => {
    const normalizeControlTypeFn = new Function(`return (${normalizeControlTypeSource});`)();

    const detectElementTypeFromDom = (el) => {
      const tag = (el.tagName || '').toLowerCase();
      const className = el.getAttribute('class') || '';
      const inputType = (el.getAttribute('type') || '').toLowerCase();

      if (tag === 'input') {
        if (inputType === 'radio') return 'radio';
        if (inputType === 'checkbox') return 'checkbox';
        if (inputType === 'email') return 'email';
        if (inputType === 'tel') return 'tel';
        if (inputType === 'password') return 'password';
        if (inputType === 'time') return 'time';
        if (inputType === 'date') return 'date';
        if (inputType === 'datetime-local') return 'dateandtime';
        if (inputType === 'number') return 'number';
        if (className.includes('numeric')) return 'number';
        if (className.includes('datetimepicker-input')) return 'date';
        if (
          el.matches('[role="combobox"], [aria-autocomplete]') ||
          el.closest('.react-select__control, .select2, .select2-container, [role="combobox"]')
        ) {
          return 'customselect';
        }
        return 'text';
      }

      if (tag === 'textarea') return 'textarea';
      if (tag === 'select') return el.multiple ? 'multiselect' : 'select';
      if (tag === 'div') {
        const nestedSelect = el.querySelector('select');
        if (nestedSelect) return nestedSelect.multiple ? 'multiselect' : 'select';

        const nestedTextarea = el.querySelector('textarea');
        if (nestedTextarea) return 'textarea';

        const nestedInput = el.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
        if (nestedInput) {
          const nestedType = (nestedInput.getAttribute('type') || '').toLowerCase();
          if (nestedType === 'radio') return 'radio';
          if (nestedType === 'checkbox') return 'checkbox';
          if (nestedType === 'email') return 'email';
          if (nestedType === 'tel') return 'tel';
          if (nestedType === 'number') return 'number';
          if (nestedType === 'password') return 'password';
          if (nestedType === 'date') return 'date';
          if (nestedType === 'time') return 'time';
          if (nestedType === 'datetime-local') return 'dateandtime';
          return 'text';
        }

        if (className.includes('checkboxlist')) return 'checkbox';
        if (className.includes('ql-editor') || className.includes('ql-container')) return 'richtext';
        if (className.includes('tox-edit-area') || className.includes('mce-edit-area')) return 'richtext';
        if (className.includes('ace_editor')) return 'richtext';
        if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') === 'true') return 'richtext';
        if (
          el.querySelector('input[aria-autocomplete], input[role="combobox"], .react-select__input input') ||
          className.includes('react-select') ||
          className.includes('select2') ||
          className.includes('container')
        ) {
          return 'customselect';
        }
      }

      return tag || 'text';
    };

    const combined = [
      ...(window.data?.tblFormDtl || []),
      ...(window.data?.tblFormSubDtl || []),
    ];

    const metaById = new Map();
    const metaByColName = new Map();
    for (const item of combined) {
      const id = `${item.vColName}${item.iFormDtlId}`;
      const controlType = normalizeControlTypeFn(
        item.vControlType || item.cControlType || item.controlType || item.vElementType || item.vType,
        item
      );
      const dependencyKeys = Object.keys(item)
        .filter((key) => /depend|parent|source|lookup/i.test(key) && item[key] != null && String(item[key]).trim() !== '')
        .map((key) => ({ key, value: item[key] }));

      const payload = {
        displayName: item.vDisplayName || id,
        columnToShow: item.vColumnToShow || item.vDisplayName || id,
        columnName: item.vColName || '',
        maxLength: Number(item.iMaxLength || item.vMaxLength || 0) || 0,
        required: String(item.cMandatory || item.isMandatory || item.bMandatory || '').toUpperCase() === 'Y',
        controlType,
        dependencyKeys,
      };

      metaById.set(id, payload);
      if (item.vColName) {
        metaByColName.set(String(item.vColName), payload);
      }
    }

    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
    };

    const offcanvasCandidates = Array.from(document.querySelectorAll(
      '.offcanvas.show .offcanvas-body, #masterFormOffcanvas.show .offcanvas-body, #offcanvas.show .offcanvas-body, #masterFormOffcanvas .offcanvas-body, #offcanvas .offcanvas-body, .offcanvas-body'
    ));

    const offcanvasBody = offcanvasCandidates.find((el) => isVisible(el)) || offcanvasCandidates[0] || null;

    if (!offcanvasBody) return [];

    // Support .ele, .form-control, and .mb-7 as field containers
    let elements = Array.from(offcanvasBody.querySelectorAll('.ele, .form-control, .mb-7'));

    const groups = Array.from(offcanvasBody.querySelectorAll('.form-group, .mb-3, .fv-row, [class*="col-"]')).filter((group) => {
      return group.querySelector(
        'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, select, .form-check-input, .form-switch, [role="combobox"], .react-select__control, div.checkboxlist, [contenteditable="true"], .ql-editor, .tox-edit-area, .mce-edit-area, .ace_editor, [class*="editor"], [class*="Editor"]'
      );
    });

    for (const group of groups) {
      const control =
        group.querySelector('select') ||
        group.querySelector('textarea') ||
        group.querySelector('.react-select__control, [role="combobox"]') ||
        group.querySelector('div.checkboxlist') ||
        group.querySelector('.form-switch, .form-check') ||
        group.querySelector('[contenteditable="true"]') ||
        group.querySelector('.ql-editor, .tox-edit-area, .mce-edit-area, .ace_editor') ||
        group.querySelector('[class*="editor"], [class*="Editor"]') ||
        group.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
      if (!control) continue;

      const root =
        control.closest('.ele') ||
        control.closest('.form-group, .mb-3, .fv-row, [class*="col-"]') ||
        control;

      if (root && !elements.includes(root)) {
        elements.push(root);
      }
    }

    elements = [...new Set(elements)];

    const guessLabel = (node, fallback) => {
      const formGroup = node.closest('.form-group, .mb-3, .fv-row, [class*="col-"]');
      if (formGroup) {
        const label = formGroup.querySelector('label, .form-label, .control-label');
        const text = (label?.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }

      const directLabel = node.closest('label');
      if (directLabel) {
        const text = (directLabel.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }

      const ariaLabel = node.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;

      const placeholder = node.getAttribute('placeholder') || '';
      if (placeholder) {
        return placeholder.replace(/^(please\s+)?(select|enter|choose|type)\s+/i, '').trim() || placeholder;
      }

      return fallback;
    };

    const detectTypeFromContainer = (el) => {
      const tag = (el.tagName || '').toLowerCase();
      const className = el.getAttribute('class') || '';

      const nestedSelect = tag === 'select' ? el : el.querySelector('select');
      if (nestedSelect) return nestedSelect.multiple ? 'multiselect' : 'select';

      const nestedTextarea = tag === 'textarea' ? el : el.querySelector('textarea');
      if (nestedTextarea) return 'textarea';

      const nestedEditable =
        (el.matches('[contenteditable="true"]') ? el : null) ||
        el.querySelector('[contenteditable="true"], .ql-editor, .tox-edit-area, .mce-edit-area, .ace_editor, [class*="editor"], [class*="Editor"]');
      if (nestedEditable) return 'richtext';

      if (
        className.includes('react-select') ||
        className.includes('select2') ||
        el.matches('[role="combobox"]') ||
        el.querySelector('[role="combobox"], [aria-autocomplete], [aria-haspopup="listbox"], .react-select__control, .select2-selection')
      ) {
        return 'customselect';
      }

      const nestedInput = tag === 'input'
        ? el
        : el.querySelector('input:not([type="hidden"]):not([type="button"]):not([type="submit"])');
      if (nestedInput) {
        const nestedType = (nestedInput.getAttribute('type') || '').toLowerCase();
        if (nestedType === 'radio') return 'radio';
        if (nestedType === 'checkbox') return 'checkbox';
        if (nestedType === 'email') return 'email';
        if (nestedType === 'tel') return 'tel';
        if (nestedType === 'number') return 'number';
        if (nestedType === 'date') return 'date';
        if (nestedType === 'time') return 'time';
        if (nestedType === 'datetime-local') return 'dateandtime';
        if (nestedType === 'password') return 'password';
        const nestedClass = nestedInput.getAttribute('class') || '';
        if (nestedClass.includes('numeric')) return 'number';
        if (nestedClass.includes('datetimepicker-input')) return 'date';
        return 'text';
      }

      if (tag === 'div' && className.includes('checkboxlist')) return 'checkbox';
      if (className.includes('ql-editor') || className.includes('ql-container')) return 'richtext';
      if (className.includes('tox-edit-area') || className.includes('mce-edit-area')) return 'richtext';
      if (className.includes('ace_editor')) return 'richtext';
      if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') === 'true') return 'richtext';
      if (className.includes('form-switch') || className.includes('form-check')) {
        const checkbox = el.querySelector('input[type="checkbox"]');
        if (checkbox) return 'checkbox';
        const radio = el.querySelector('input[type="radio"]');
        if (radio) return 'radio';
        return 'checkbox';
      }
      if (
        className.includes('react-select') ||
        el.matches('[role="combobox"]') ||
        el.querySelector?.('.react-select__control, [role="combobox"]')
      ) {
        return 'customselect';
      }
      return detectElementTypeFromDom(el);
    };

    const inferRequired = (el, metaRequired) => {
      if (metaRequired) return true;

      const group = el.closest('.form-group, .mb-3, .fv-row, [class*="col-"]') || el.parentElement;
      if (!group) return false;

      const label = group.querySelector('label, .form-label, .control-label');
      const labelText = (label?.textContent || '').replace(/\s+/g, ' ').trim();
      if (/\*/.test(labelText)) return true;
      if (label?.classList?.contains('required') || group.querySelector('.required')) return true;
      if (label?.classList?.contains('text-danger') || label?.classList?.contains('text-danger-emphasis')) return true;

      const requiredHint = group.querySelector('.invalid-feedback, .text-danger, .field-validation-error, .fv-plugins-message-container');
      const requiredText = (requiredHint?.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (requiredText.includes('required')) return true;

      const control =
        el.matches('input, textarea, select') ? el : el.querySelector('input, textarea, select');
      if (control?.hasAttribute('required')) return true;
      if ((control?.getAttribute('aria-required') || '').toLowerCase() === 'true') return true;

      return false;
    };

    const fields = [];
    for (let idx = 0; idx < elements.length; idx++) {
      const el = elements[idx];
      const tag = (el.tagName || '').toLowerCase();
      let id = el.getAttribute('id') || el.getAttribute('name') || el.getAttribute('data-qf-field-id') || '';
      if (!id) {
        id = `qf_auto_field_${idx + 1}`;
      }
      if (!el.getAttribute('data-qf-field-id')) {
        el.setAttribute('data-qf-field-id', id);
      }
      const disabled = !!el.disabled;
      const maxLengthAttr = Number(el.getAttribute('maxlength') || 0) || 0;

      const meta = metaById.get(id) || metaByColName.get(id) || {};
      const metaType = normalizeControlTypeFn(meta.controlType || '', meta);
      const domType = detectTypeFromContainer(el);
      const elementType = metaType || domType;
      const displayName = meta.displayName || guessLabel(el, id || `field_${idx + 1}`);

      const options = [];
      if (elementType === 'select' || elementType === 'multiselect') {
        const optionHost = tag === 'select' ? el : el.querySelector('select');
        Array.from((optionHost || el).querySelectorAll('option')).forEach((opt) => {
          if (opt.value && opt.value !== '-1' && opt.value !== '') {
            options.push({ value: opt.value, label: (opt.textContent || '').trim() });
          }
        });
      }

      fields.push({
        idx,
        id,
        displayName,
        columnToShow: meta.columnToShow || displayName,
        columnName: meta.columnName || '',
        elementType,
        disabled,
        required: inferRequired(el, !!meta.required),
        maxLength: Math.max(maxLengthAttr, meta.maxLength || 0),
        options,
        dependencyKeys: meta.dependencyKeys || [],
      });
    }

    const seen = new Set();
    return fields.filter((field) => {
      const key = `${field.id}::${field.elementType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, normalizeControlType.toString());
}

async function collectStableFormFields(page, options = {}) {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 400;

  let previousSignature = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const fields = await collectFormFields(page);
    const signature = JSON.stringify(fields.map((field) => `${field.id}:${field.elementType}:${field.required}`));

    if (fields.length > 0 && signature === previousSignature) {
      return fields;
    }

    previousSignature = signature;
    if (attempt < attempts - 1) {
      await page.waitForTimeout(delayMs);
    }
  }

  return collectFormFields(page);
}

module.exports = {
  collectFormFields,
  collectStableFormFields,
  normalizeControlType,
};