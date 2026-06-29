'use strict';

const {
  login,
  navigateTo,
  openCreateForm,
} = require('../helpers/uiActions');

function baseOrigin(loginUrl) {
  try {
    return new URL(String(loginUrl || 'https://ipdev.quickflow.in/login')).origin;
  } catch {
    return 'https://ipdev.quickflow.in';
  }
}

async function GivenUserLoggedIn(page, { loginUrl, username, password }) {
  await login(page, { loginUrl, username, password });
  return { ok: true };
}

async function GivenNavigatedToModule(page, modulePathOrMaster, loginUrl) {
  const value = String(modulePathOrMaster || '').trim();
  const origin = baseOrigin(loginUrl);
  if (!value) return { ok: false, reason: 'module path is required' };

  if (value.startsWith('/')) {
    await page.goto(`${origin}${value}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    return { ok: true, route: `${origin}${value}` };
  }

  await navigateTo(page, value, origin);
  return { ok: true, route: `${origin}/${value}` };
}

async function GivenFormCreateOpened(page) {
  await openCreateForm(page);
  return { ok: true };
}

async function GivenWorkflowRecordPrepared() {
  return { ok: false, reason: 'workflow seed preparation will be implemented in Phase 2' };
}

async function GivenUploadFieldAccessible() {
  return { ok: false, reason: 'upload field discovery will be implemented in Phase 2' };
}

async function WhenSubmitWithMandatoryBlank() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenNavigateToNonExistentUrl() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenSubmitWhileOffline() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenInjectXssPayload() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenInjectSqlPayload() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenEnterOversizedInput() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenUploadFile() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenTriggerMalformedApiRequest() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function WhenDeactivateApproverDuringPendingTask() {
  return { ok: false, reason: 'step logic will be implemented in Phase 2' };
}

async function ThenShowActionableErrorWithoutSensitiveLeak() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenRenderFriendly404WithoutLeak() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenPreserveFormDataAfterNetworkFailure() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenPreventScriptExecutionAndSanitizeStoredValue() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenTreatSqlPatternAsLiteralWithoutDataExposure() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenRejectOversizedInputGracefully() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenRejectDisallowedFileType() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenRejectOversizedFileWithLimitMessage() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenRejectMacroFileOrReturnBlocked() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenLogServerErrorWithRequiredContextOrBlocked() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

async function ThenHaltWorkflowAndNotifyAdminOrBlocked() {
  return { ok: false, reason: 'assertion logic will be implemented in Phase 2' };
}

module.exports = {
  GivenUserLoggedIn,
  GivenNavigatedToModule,
  GivenFormCreateOpened,
  GivenWorkflowRecordPrepared,
  GivenUploadFieldAccessible,
  WhenSubmitWithMandatoryBlank,
  WhenNavigateToNonExistentUrl,
  WhenSubmitWhileOffline,
  WhenInjectXssPayload,
  WhenInjectSqlPayload,
  WhenEnterOversizedInput,
  WhenUploadFile,
  WhenTriggerMalformedApiRequest,
  WhenDeactivateApproverDuringPendingTask,
  ThenShowActionableErrorWithoutSensitiveLeak,
  ThenRenderFriendly404WithoutLeak,
  ThenPreserveFormDataAfterNetworkFailure,
  ThenPreventScriptExecutionAndSanitizeStoredValue,
  ThenTreatSqlPatternAsLiteralWithoutDataExposure,
  ThenRejectOversizedInputGracefully,
  ThenRejectDisallowedFileType,
  ThenRejectOversizedFileWithLimitMessage,
  ThenRejectMacroFileOrReturnBlocked,
  ThenLogServerErrorWithRequiredContextOrBlocked,
  ThenHaltWorkflowAndNotifyAdminOrBlocked,
};

