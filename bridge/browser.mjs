import { existsSync } from 'node:fs';

// Prefer an explicit browser path when Playwright's managed download is
// unavailable (common on restricted networks). Without an override,
// Playwright still uses its managed browser as usual.
export function browserLaunchOptions({ headless = true } = {}) {
  const candidates = [
    process.env.XB_BROWSER_EXECUTABLE,
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null,
  ].filter(Boolean);
  const executablePath = candidates.find(path => existsSync(path));
  return executablePath ? { headless, executablePath } : { headless };
}
