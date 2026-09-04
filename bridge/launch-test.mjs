// bridge/launch-test.mjs
// 一次性实验: 探测 configprefix / 关键config, 然后尝试预置配置直接启动 xingBei(auto) 并报告卡点。
import { chromium } from 'playwright';
import { browserLaunchOptions } from './browser.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const server = await startServer();
const browser = await chromium.launch(browserLaunchOptions({ headless: true }));

// ---- Pass 1: 读取 configprefix 与默认配置 ----
const p1 = await browser.newPage();
await p1.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
await p1.waitForTimeout(7000);
const cfg = await p1.evaluate(async () => {
  const nn = await import('/noname.js'); const { lib } = nn;
  const out = { configprefix: lib.configprefix };
  out.localStorageKeys = Object.keys(localStorage).slice(0, 60);
  out.config_mode = lib.config.mode;
  out.config_characters = lib.config.characters;
  out.config_cards = lib.config.cards;
  out.xingBeiDefaults = lib.mode.xingBei && lib.mode.xingBei.config
    ? Object.fromEntries(Object.entries(lib.mode.xingBei.config).map(([k, v]) => [k, v.init])) : null;
  return out;
});
console.log('[pass1]', JSON.stringify(cfg, null, 2));
await p1.close();

// ---- Pass 2: JS 驱动启动 (Option A): 启动后强制切到 xingBei + auto + 随机选角, 报告卡点 ----
const p2 = await browser.newPage();
p2.on('console', m => { const t = m.text(); if (/error|fail|TypeError|cannot|undefined is not/i.test(t)) console.log('[page]', t.slice(0, 220)); });
await p2.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
await p2.waitForTimeout(8000);
const launch = await p2.evaluate(async () => {
  const nn = await import('/noname.js'); const { lib, game, ui, get, _status } = nn;
  const log = [];
  try {
    let guard = 10; while (ui.dialogs && ui.dialogs.length && guard--) { try { ui.dialogs[0].close(); } catch (e) { break; } }
    lib.config.mode_config = lib.config.mode_config || {};
    lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei || {}, {
      versus_mode: 'two', free_choose: false, AItiLian: true, phaseswap: false, change_identity: false, choose_number: 1
    });
    lib.config.mode = 'xingBei';
    _status.auto = true;
    game.saveConfig('mode', 'xingBei');
    game.saveConfig('mode_config', lib.config.mode_config);
    log.push('saved; versus=' + get.config('versus_mode') + ' free=' + get.config('free_choose'));
    setTimeout(() => game.reload(), 200);
    log.push('reload scheduled');
  } catch (e) { log.push('ERR ' + String(e)); }
  return { log };
});
console.log('[pass2-launch]', JSON.stringify(launch));
await p2.waitForTimeout(18000);
// 选角后开启 auto + 自动确认, 让 AI 全自动跑完
await p2.evaluate(async () => {
  const nn = await import('/noname.js'); const { _status, game, ui } = nn;
  _status.auto = true;
  const tick = () => {
    try {
      _status.auto = true;
      const sel = document.querySelector('.dialog .button.selected');
      if (!sel) { const b = document.querySelector('.dialog .button'); if (b) b.click(); }
      const conf = [...document.querySelectorAll('.control,.menubutton,.confirm>div,#window .menubutton')].find(e => /确定|开始/.test(e.innerText));
      if (conf) conf.click();
    } catch (e) {}
  };
  window.__xbAuto = setInterval(tick, 600);
});
await p2.waitForTimeout(60000);
const st = await p2.evaluate(async () => {
  const nn = await import('/noname.js'); const { lib, game, ui, _status } = nn;
  return {
    config_mode: lib.config.mode,
    playersLen: game.players ? game.players.length : null,
    hongShiQi: game.hongShiQi, lanShiQi: game.lanShiQi,
    hongXingBei: game.hongXingBei, lanXingBei: game.lanXingBei,
    status_auto: _status.auto, imchoosing: _status.imchoosing, paused: _status.paused,
    currentPhase: !!_status.currentPhase, phaseNumber: game.phaseNumber,
    dialogs: ui.dialogs ? ui.dialogs.length : null,
    over: _status.over || (game.players && game.players.length ? 'running?' : 'none'),
    bodyText: (document.body.innerText || '').slice(0, 300)
  };
});
console.log('[pass2-state]', JSON.stringify(st, null, 2));

await mkdir(RUNTIME, { recursive: true });
await writeFile(join(RUNTIME, 'launch-test.json'), JSON.stringify({ cfg, st }, null, 2));
await browser.close();
server.close();
