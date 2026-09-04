// Reversible runtime UI theme. It consumes the existing DOM and never changes
// engine rules, card data, or hidden-information visibility.
const FALLBACK_CSS = 'body.xb-modern{background:#0b1020!important;color:#eef3ff}body.xb-modern .dialog{background:rgba(34,47,78,.96);color:#eef3ff;border-radius:14px}';

export async function installModernTheme({ document = globalThis.document, matchId = null, policyId = null, cssUrl = '/__arena/ui-overlay/modern-theme.css', fetchImpl = globalThis.fetch } = {}) {
  if (!document?.documentElement) return { installed: false, reason: 'document_unavailable' };
  if (document.documentElement.dataset.xbModernTheme === '1') return { installed: true, reused: true };
  const style = document.createElement('style');
  style.id = 'xb-modern-theme';
  let css = FALLBACK_CSS;
  try {
    if (typeof fetchImpl === 'function') {
      const response = await fetchImpl(cssUrl, { cache: 'no-store' });
      if (response?.ok) css = await response.text();
    }
  } catch {}
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.dataset.xbModernTheme = '1';
  document.body?.classList.add('xb-modern');
  if (matchId) document.documentElement.dataset.xbMatchId = String(matchId);
  if (policyId) document.documentElement.dataset.xbPolicyId = String(policyId);
  return { installed: true, reused: false, matchId, policyId };
}

export function uninstallModernTheme(document = globalThis.document) {
  document?.getElementById?.('xb-modern-theme')?.remove?.();
  document?.documentElement?.classList.remove('xb-modern');
  if (document?.documentElement) delete document.documentElement.dataset.xbModernTheme;
  document?.body?.classList.remove('xb-modern');
  return { installed: false };
}
