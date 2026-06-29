'use strict';

/**
 * Palette groups for the Quickflow Template Design page.
 *
 * Each group maps to a left-toolbar category button (`.cbar-cat-btn[data-panel=...]`)
 * and the floating panel it opens (`#<panel>`). `controls` lists every tile in that
 * panel by its `data-ctl` value (the drag/add identifier) and a human label.
 *
 * Source: quickflow_core .../TemplateDesign/template-design.html
 */

const GROUPS = {
  Layout: {
    panel: 'catPanelLayout',
    controls: [
      { ctl: 'ctlplaceholder', label: 'Placeholder' },
      { ctl: 'ctlhr', label: 'Divider' },
      { ctl: 'ctltable', label: 'Table' },
      { ctl: 'ctlcollapse', label: 'Modal' },
      { ctl: 'ctlcard', label: 'Card' },
    ],
  },
  Input: {
    panel: 'catPanelInput',
    controls: [
      { ctl: 'ctlnumber', label: 'Number' },
      { ctl: 'ctltext', label: 'Text' },
      { ctl: 'ctltextarea', label: 'Textarea' },
      { ctl: 'ctldecimalFieldController', label: 'Decimal Field Controller' },
      { ctl: 'ctldecimal', label: 'Decimal' },
      { ctl: 'ctldate', label: 'Date' },
      { ctl: 'ctldaterange', label: 'Date Range' },
      { ctl: 'ctltime', label: 'Time' },
      { ctl: 'ctldateandtime', label: 'Date and Time' },
      { ctl: 'ctlserverdatetime', label: 'Server Date Time' },
      { ctl: 'ctlfile', label: 'File' },
      { ctl: 'ctlimagecapture', label: 'Image Capture' },
      { ctl: 'ctlqrcode', label: 'QR Code' },
      { ctl: 'ctlesigncontrol', label: 'E-Sign' },
      { ctl: 'ctlinventorycontrol', label: 'Inventory' },
      { ctl: 'ctltel', label: 'Telephone' },
      { ctl: 'ctlemail', label: 'Email' },
      { ctl: 'ctlmcq', label: 'MCQ' },
    ],
  },
  Email: {
    panel: 'catPanelEmail',
    controls: [
      { ctl: 'ctlemailto', label: 'Email To' },
      { ctl: 'ctlemailattachment', label: 'Email Attachment' },
    ],
  },
  Editors: {
    panel: 'catPanelEditors',
    controls: [
      { ctl: 'ctldocumenteditor', label: 'Document Editor' },
      { ctl: 'ctleditor', label: 'Editor' },
    ],
  },
  Select: {
    panel: 'catPanelSelection',
    controls: [
      { ctl: 'ctlcheckbox', label: 'Checkbox' },
      { ctl: 'ctlradio', label: 'Radio' },
      { ctl: 'ctlselect', label: 'Select' },
      { ctl: 'ctlmultiselect', label: 'Multi Select' },
    ],
  },
  Display: {
    panel: 'catPanelDisplay',
    controls: [
      { ctl: 'ctlesignaturetable', label: 'E-Signature Table' },
      { ctl: 'ctllabel', label: 'Label' },
      { ctl: 'ctlmcqresult', label: 'MCQ Result' },
      { ctl: 'ctlcurrentdate', label: 'Current Date' },
      { ctl: 'ctlcurrentdateandime', label: 'Current Date and Time' },
      { ctl: 'ctlloggedinuser', label: 'Logged In User' },
      { ctl: 'ctlloggedinprofile', label: 'Logged In Profile' },
      { ctl: 'ctlloggedindepartment', label: 'Logged In Department' },
      { ctl: 'ctlapprovecontrol', label: 'Approve Control' },
      { ctl: 'ctlapprovedatetime', label: 'Approve Date Time' },
      { ctl: 'ctlchart', label: 'Chart' },
      { ctl: 'ctlversioncontrol', label: 'Version Control' },
      { ctl: 'ctlbutton', label: 'Button' },
    ],
  },
  Intg: {
    panel: 'catPanelIntegration',
    controls: [
      { ctl: 'ctlformlookup', label: 'Form Lookup' },
    ],
  },
  RPA: {
    panel: 'catPanelRpa',
    controls: [
      { ctl: 'ctlinstrument', label: 'Instrument' },
      { ctl: 'ctltagno', label: 'Tag No' },
      { ctl: 'ctlactionrequested', label: 'Action Requested' },
    ],
  },
};

const GROUP_NAMES = Object.keys(GROUPS);

module.exports = { GROUPS, GROUP_NAMES };
