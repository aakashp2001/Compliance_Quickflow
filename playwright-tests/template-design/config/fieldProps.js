'use strict';

/**
 * Representative property customizations applied to each dropped control.
 *
 * Each entry is { accordion, id, value }. `accordion` is the accordion header id to
 * expand before setting; `id` is the property input/select/checkbox id in the right
 * panel; `value` is the value to apply.
 *
 * propPanel.setProp() silently skips any id not present/visible for the selected
 * control type, so a control only receives the props it actually exposes.
 *
 * Accordion header ids:
 *   #propAccLayout  #propAccLabel  #propAccValidation
 *   #propAccBehavior  #propAccAppearance  #propAccSpecific
 */

// Props tried for every control (set only when the control exposes them).
const COMMON_PROPS = [
  { accordion: 'propAccLayout', id: 'ctrl-width', value: '50' },
  { accordion: 'propAccLabel', id: 'labelText', value: '__LABEL__' },
  { accordion: 'propAccLabel', id: 'showLabel', value: 'Yes' },
  { accordion: 'propAccBehavior', id: 'title', value: 'Set by automation' },
];

// Extra props by control type (merged after COMMON_PROPS).
const BY_CONTROL = {
  ctltext: [
    { accordion: 'propAccValidation', id: 'required', value: 'Yes' },
    { accordion: 'propAccValidation', id: 'maxlength', value: '100' },
    { accordion: 'propAccValidation', id: 'placeholder', value: 'Enter value' },
  ],
  ctltextarea: [
    { accordion: 'propAccValidation', id: 'maxlength', value: '500' },
    { accordion: 'propAccValidation', id: 'placeholder', value: 'Enter details' },
  ],
  ctlnumber: [
    { accordion: 'propAccValidation', id: 'required', value: 'Yes' },
  ],
  ctlemail: [
    { accordion: 'propAccValidation', id: 'placeholder', value: 'name@example.com' },
  ],
  ctltel: [
    { accordion: 'propAccValidation', id: 'placeholder', value: '+1 000 000 0000' },
  ],
  // Layout containers expose width/label only -> COMMON_PROPS is enough.
};

/**
 * Build the prop list for a control. `label` substitutes the `__LABEL__` token so
 * labelText is meaningful per control.
 */
function propsFor(ctl, label) {
  const merged = [...COMMON_PROPS, ...(BY_CONTROL[ctl] || [])];
  return merged.map((p) => ({
    ...p,
    value: p.value === '__LABEL__' ? `${label} (auto)` : p.value,
  }));
}

module.exports = { COMMON_PROPS, BY_CONTROL, propsFor };
