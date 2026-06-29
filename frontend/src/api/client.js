const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

async function request(path, options = {}) {
  const isAbsolute = /^https?:\/\//i.test(path);
  const url = isAbsolute ? path : `${API_BASE_URL}${path}`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!response.ok) {
    const raw = await response.text();
    let message = raw;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        message = parsed.message;
      }
    } catch {
      // Keep raw response text when not JSON.
    }

    throw new Error(message || `Request failed with status ${response.status}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }

  return response.text();
}

export function getHealth() {
  return request('/health');
}

export function getItems() {
  return request('/api/items');
}

export function createItem(payload) {
  return request('/api/items', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getMasters() {
  return request('/api/masters');
}

export function fetchMasters(payload = {}) {
  return request('/api/masters/fetch', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getMasterFields(masterName, options = {}) {
  const safeName = encodeURIComponent(String(masterName || ''));
  if (!safeName) {
    throw new Error('masterName is required');
  }

  const params = new URLSearchParams();
  if (options.refresh) params.set('refresh', 'true');
  if (options.loginUrl) params.set('loginUrl', options.loginUrl);
  if (options.username) params.set('username', options.username);
  if (options.password) params.set('password', options.password);
  if (typeof options.showBrowser === 'boolean') params.set('showBrowser', String(options.showBrowser));

  const query = params.toString();
  const path = `/api/masters/${safeName}/fields${query ? `?${query}` : ''}`;
  return request(path);
}

export function runCrudOperation(masterName, payload = {}) {
  const safeName = encodeURIComponent(String(masterName || ''));
  if (!safeName) throw new Error('masterName is required');
  return request(`/api/masters/${safeName}/crud`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}



export function getTestReports() {
  return request('/api/test-reports');
}

export function getRecordings() {
  return request('/api/recordings');
}

export function compareFieldMaster(payload = {}) {
  return request('/api/masters/compare-field', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getDependencyConfig(masterName) {
  const params = new URLSearchParams();
  if (masterName) params.set('masterName', String(masterName));
  const query = params.toString();
  return request(`/api/dependency-config${query ? `?${query}` : ''}`);
}

export function saveDependencyConfig(masterName, payload = {}) {
  const safeName = encodeURIComponent(String(masterName || ''));
  if (!safeName) throw new Error('masterName is required');
  return request(`/api/dependency-config/${safeName}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export function validateMandatoryFields(masterName, payload = {}) {
  const safeName = encodeURIComponent(String(masterName || ''));
  if (!safeName) throw new Error('masterName is required');
  return request(`/api/masters/${safeName}/validate-mandatory`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runTemplateWorkflow(payload = {}) {
  return request('/api/template-workflow/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function runComplianceTest(payload = {}) {
  return request('/api/compliance/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function startComplianceRun(payload = {}) {
  return request('/api/compliance/runs', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getComplianceRun(runId, clientToken) {
  const safeRunId = encodeURIComponent(String(runId || ''));
  if (!safeRunId) throw new Error('runId is required');
  const params = new URLSearchParams();
  if (clientToken) params.set('clientToken', String(clientToken));
  const query = params.toString();
  return request(`/api/compliance/runs/${safeRunId}${query ? `?${query}` : ''}`);
}

export function stopComplianceRun(runId, clientToken) {
  const safeRunId = encodeURIComponent(String(runId || ''));
  if (!safeRunId) throw new Error('runId is required');
  return request(`/api/compliance/runs/${safeRunId}/stop`, {
    method: 'POST',
    body: JSON.stringify({ clientToken: String(clientToken || '') }),
  });
}

export function openComplianceRunStream(runId, clientToken) {
  const safeRunId = encodeURIComponent(String(runId || ''));
  if (!safeRunId) throw new Error('runId is required');
  if (!clientToken) throw new Error('clientToken is required');

  const params = new URLSearchParams({ clientToken: String(clientToken) });
  const path = `/api/compliance/runs/${safeRunId}/stream?${params.toString()}`;
  const isAbsoluteBase = /^https?:\/\//i.test(API_BASE_URL);
  const url = isAbsoluteBase ? `${API_BASE_URL}${path}` : `${API_BASE_URL || ''}${path}`;
  return new EventSource(url);
}

export function getLastWorkflowRun() {
  return request('/api/template-workflow/last-run');
}

export function getLastPassedWorkflowRun() {
  return request('/api/template-workflow/last-passed');
}

export function runTemplateDesign(payload = {}) {
  return request('/api/template-design/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getTemplateDesignOptions(options = {}) {
  const params = new URLSearchParams();
  if (typeof options.showBrowser === 'boolean') {
    params.set('showBrowser', String(options.showBrowser));
  }
  const query = params.toString();
  return request(`/api/template-design/options${query ? `?${query}` : ''}`);
}

export { API_BASE_URL };
