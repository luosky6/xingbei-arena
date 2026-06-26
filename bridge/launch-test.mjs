// bridge/launch-test.mjs
// 一次性实验: 探测 configprefix / 关键config, 然后尝试预置配置直接启动 xingBei(auto) 并报告卡点。
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const server = await startServer();
const browser = await chromium.launch({ headless: true });

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
    // 1. 关掉新手向导/任何对话框
    let guard = 10; while (ui.dialogs && ui.dialogs.length && guard--) { try { ui.dialogs[0].close(); } catch (e) { break; } }
    // 2. 切模式 + 写入 xingBei 子配置(模式通过 get.config 读取 lib.config['xingBei_'+key])
    lib.config.mode = 'xingBei';
    const mc = lib.mode.xingBei.config || {};
    const overrides = { versus_mode: 'two', free_choose: false, AItiLian: true, phaseswap: false };
    for (const k in mc) {
      const v = (k in overrides) ? overrides[k] : mc[k].init;
      lib.config['xingBei_' + k] = v;
    }
    _status.auto = true;
    log.push('config set; versus=' + get.config('versus_mode') + ' free=' + get.config('free_choose'));
    // 3. 重放 onload 末尾的启动
    ui.create.arena();
    game.createEvent('game', false).setContent(lib.mode.xingBei.start);
    log.push('launched');
  } catch (e) { log.push('ERR ' + String(e)); }
  return { log };
});
console.log('[pass2-launch]', JSON.stringify(launch));
await p2.waitForTimeout(15000);
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
