'use strict';

const OVERLAY_SCRIPT = `
(function() {
  try {
    const install = () => {
      const existing = document.getElementById('pw-artifact-overlay');
      if (existing) return;

      window.__artifactOverlayInfo = window.__artifactOverlayInfo || {};

      const box = document.createElement('div');
      box.id = 'pw-artifact-overlay';
      box.style.position = 'fixed';
      box.style.right = '12px';
      box.style.top = '12px';
      box.style.zIndex = '2147483647';
      box.style.background = 'rgba(0,0,0,0.84)';
      box.style.color = '#ffffff';
      box.style.padding = '8px 12px';
      box.style.borderRadius = '8px';
      box.style.fontFamily = 'Consolas, Menlo, monospace';
      box.style.fontSize = '11px';
      box.style.lineHeight = '1.45';
      box.style.whiteSpace = 'pre-wrap';
      box.style.maxWidth = '68vw';
      box.style.pointerEvents = 'none';
      box.style.boxShadow = '0 4px 14px rgba(0,0,0,0.35)';

      const render = () => {
        const now = new Date();
        const timeText = now.toLocaleString('en-GB', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        const urlText = window.location.href || '';
        const info = window.__artifactOverlayInfo || {};

        const lines = [
          'Time: ' + timeText,
          'URL:  ' + urlText,
        ];

        if (info.masterName) lines.push('Master: ' + info.masterName);
        if (info.operation) lines.push('Operation: ' + info.operation);
        if (info.status) lines.push('Status: ' + info.status);
        if (info.step) lines.push('Step: ' + info.step);

        box.textContent = lines.join('\\n');
      };

      render();
      document.body.appendChild(box);
      setInterval(render, 1000);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install, { once: true });
    } else {
      install();
    }
  } catch {}
})();
`;

async function enableArtifactOverlayOnPage(page) {
  if (!page || page.isClosed()) return;
  await page.addInitScript(OVERLAY_SCRIPT);
  await page.evaluate(OVERLAY_SCRIPT).catch(() => {});
}

async function enableArtifactOverlayOnContext(context) {
  if (!context) return;

  context.on('page', (popupPage) => {
    enableArtifactOverlayOnPage(popupPage).catch(() => {});
  });

  const pages = typeof context.pages === 'function' ? context.pages() : [];
  for (const page of pages) {
    await enableArtifactOverlayOnPage(page).catch(() => {});
  }
}

async function updateArtifactOverlay(page, info = {}) {
  if (!page || page.isClosed()) return;

  await page.evaluate((payload) => {
    try {
      window.__artifactOverlayInfo = Object.assign(window.__artifactOverlayInfo || {}, payload || {});
    } catch {}
  }, info).catch(() => {});
}

module.exports = {
  enableArtifactOverlayOnPage,
  enableArtifactOverlayOnContext,
  updateArtifactOverlay,
};
