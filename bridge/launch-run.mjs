// bridge/launch-run.mjs — 跑通一局: 持续保持 _status.auto, 内置AI自动选将+对战, 抓 game.over。
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const server = await startServer();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (/error|TypeError|cannot/i.test(t)) console.log('[pg]', t.slice(0,160)); });

// 重载后立刻持续置 auto + 包装 over
await page.addInitScript(() => {
  window.__xbResult = null;
  const poll = setInterval(async () => {
    try {
      const nn = window.__nn || (window.__nn = await import('/noname.js'));
      const { _status, game } = nn;
      if (_status) _status.auto = true;
      if (game && game.over && !game.__w) {
        game.__w = true; const o = game.over.bind(game);
        game.over = b => { try { window.__xbResult = { winner: b===true?(game.me.side?'red':'blue'):(game.me.side?'blue':'red'), red:game.hongShiQi, blue:game.lanShiQi, rc:game.hongXingBei, bc:game.lanXingBei, turns:game.phaseNumber }; } catch(e){} return o(b); };
      }
    } catch (e) {}
  }, 500);
  window.__xbPoll = poll;
});

await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil:'load', timeout:60000 });
await page.waitForTimeout(7000);
await page.evaluate(async () => {
  const nn = await import('/noname.js'); const { lib, game, ui, _status } = nn;
  while (ui.dialogs && ui.dialogs.length) { try { ui.dialogs[0].close(); } catch { break; } }
  lib.config.mode_config = lib.config.mode_config || {};
  lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei||{}, { versus_mode:'three', free_choose:false, choose_number:1, AItiLian:true, phaseswap:false, change_identity:false });
  lib.config.mode = 'xingBei'; _status.auto = true;
  game.saveConfig('mode','xingBei'); game.saveConfig('mode_config', lib.config.mode_config);
  setTimeout(()=>game.reload(), 150);
});

console.log('[run] waiting for game over (max 3min)...');
// 选将自动点击: 选1候选 + 确定; AI 补其余
const clicker = setInterval(async () => {
  try { await page.evaluate(() => {
    const d = document.querySelector('.dialog'); if (d) { const b = d.querySelector('.button:not(.selected)'); if (b) b.click(); }
    document.querySelectorAll('.menubutton,.control,.caption').forEach(c => { if (/确定|开始|ok/i.test(c.innerText)) c.click(); });
  }); } catch {}
}, 700);try { await page.waitForFunction(() => window.__xbResult !== null, { timeout: 180000 }); }
catch { console.log('[run] timeout; snapshot:', JSON.stringify(await page.evaluate(async()=>{const{game,_status,ui}=await import('/noname.js');const d=document.querySelector('.dialog');return{players:game.players?.length,phase:game.phaseNumber,red:game.hongShiQi,blue:game.lanShiQi,auto:_status.auto,choosing:_status.imchoosing,dialogClasses:d?d.className:null,btn:document.querySelectorAll('.dialog .button').length,ctrls:[...document.querySelectorAll('.menubutton,.control')].map(c=>c.innerText).slice(0,8)};}))); await browser.close(); server.close(); process.exit(0); }
console.log('[run] RESULT', JSON.stringify(await page.evaluate(()=>window.__xbResult)));
await browser.close(); server.close();
