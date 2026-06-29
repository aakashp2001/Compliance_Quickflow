'use strict';

const SENSITIVE_LEAK_PATTERNS = [
  { id: 'stack-trace', re: /\b(at\s+\S+\s+\(|exception|stack trace)\b/i },
  { id: 'filesystem-path-windows', re: /[A-Za-z]:\\[^:\n\r\t]+/ },
  { id: 'filesystem-path-unix', re: /\/(?:var|opt|usr|home|tmp|srv)\/[^\s]*/i },
  { id: 'sql-server-error', re: /\b(sql(exception|state)?|syntax error|ora-\d+|postgres|mysql|sqlite)\b/i },
  { id: 'framework-banner', re: /\b(asp\.net|spring boot|hibernate|laravel|express)\b/i },
  { id: 'schema-leak', re: /\b(select\s+.+\s+from|table\s+\w+|column\s+\w+)\b/i },
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function findSensitiveLeaks(text, customPatterns = []) {
  const source = normalizeText(text);
  if (!source) return [];

  const patterns = [...SENSITIVE_LEAK_PATTERNS, ...(Array.isArray(customPatterns) ? customPatterns : [])];
  const hits = [];
  for (const pattern of patterns) {
    const matched = source.match(pattern.re);
    if (!matched) continue;
    hits.push({
      id: pattern.id || 'custom-pattern',
      match: String(matched[0] || '').slice(0, 120),
    });
  }
  return hits;
}

function hasSensitiveLeak(text, customPatterns = []) {
  return findSensitiveLeaks(text, customPatterns).length > 0;
}

async function captureConsoleMessages(page, durationMs = 1500) {
  const messages = [];
  const listener = (message) => {
    const type = String(message?.type?.() || 'log');
    const text = String(message?.text?.() || '');
    messages.push({ type, text });
  };

  page.on('console', listener);
  await page.waitForTimeout(Math.max(100, Number(durationMs) || 0));
  page.off('console', listener);
  return messages;
}

module.exports = {
  SENSITIVE_LEAK_PATTERNS,
  findSensitiveLeaks,
  hasSensitiveLeak,
  captureConsoleMessages,
};

