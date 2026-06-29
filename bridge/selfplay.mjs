// bridge/selfplay.mjs
// 基线自对弈: 用引擎内置 AI 跑 N 局星杯对局, 把结果落盘到 runtime/matches/*.jsonl。
// 这是"立刻能开始训练"的最快路径: 先拿到 baseline 数据与可用管线, 再叠加 overlay 优化AI。
//
// ⚠️ startMatch() 标 [DISCOVER]: noname 的无头启动序列依机器而异,
//    先运行 `npm run probe`, 再让 Copilot CLI 根据 runtime/probe.json 补全本函数。
import { chromium } from 'playwright';
import { mkdir, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const MATCHES = join(RUNTIME, 'matches');

const N        = Number(process.env.XB_MATCHES || 20);
const MODE     = process.env.XB_MODE || 'three';            // 固定六人局: three=3v3(6人)
const SEED0    = Number(process.env.XB_SEED || 1000);
const TEAM_A   = (process.env.XB_TEAM_A || '').split(',').filter(Boolean); // e.g. fengZhiJianSheng,shengNv
const TEAM_B   = (process.env.XB_TEAM_B || '').split(',').filter(Boolean);
const HEADLESS = process.env.XB_HEADFUL ? false : true;
const OVERLAY  = !!process.env.XB_OVERLAY;                // 是否注入 ai-overlay (优化AI)

// 注入到页面: 记录对局结果(包装 game.over)。读取引擎已有统计字段。
const RECORDER = () => {
  if (window.__xbRecorderInstalled) return;
  window.__xbRecorderInstalled = true;
  window.__xbResult = null;
  const wrap = () => {
    if (!window.game || !window.game.over || window.game.__xbWrapped) { return setTimeout(wrap, 200); }
    const orig = window.game.over.bind(window.game);
    window.game.__xbWrapped = true;
    window.game.over = function (bool) {
      try {
        const g = window.game;
        const stats = (g.players || []).map(p => {
          const acc = { seat: p.dataset && p.dataset.position, actor: p.name1 || p.name,
            side: p.side ? 'red' : 'blue', damage: 0, damaged: 0,
            change_shiqi: 0, changed_shiqi: 0, add_zhanji: 0, add_zhiliao: 0 };
          for (const s of (p.stat || [])) {
            for (const k of ['damage','damaged','add_zhiliao']) {}
            if (s.damage) acc.damage += s.damage;
            if (s.damaged) acc.damaged += s.damaged;
            if (s.changeShiQi) acc.change_shiqi += s.changeShiQi;
            if (s.changedShiQi) acc.changed_shiqi += s.changedShiQi;
            if (s.addZhanJi) acc.add_zhanji += s.addZhanJi;
            if (s.addZhiLiao) acc.add_zhiliao += s.addZhiLiao;
          }
          acc.is_winner = (bool === true) === (p.side === window.game.me.side);
          return acc;
        });
        window.__xbResult = {
          win_by: (g.hongShiQi <= 0 || g.lanShiQi <= 0) ? 'shiqi0' : 'xingBei5',
          red_shiqi: g.hongShiQi, blue_shiqi: g.lanShiQi,
          red_xingbei: g.hongXingBei, blue_xingbei: g.lanXingBei,
          winner_side: (typeof bool === 'boolean') ? (bool === true ? (g.me.side ? 'red' : 'blue') : (g.me.side ? 'blue' : 'red')) : null,
          turns: g.phaseNumber || null, stats
        };
      } catch (e) { window.__xbResult = { error: String(e) }; }
      return orig(bool);
    };
  };
  wrap();
};

// [DISCOVER] 启动一局星杯对局(内置AI自动对战)。需根据 runtime/probe.json 补全。
async function startMatch(page, { mode, seed, teamA, teamB }) {
  // ===== 已探明的事实 (probe + launch-test, 2026-06-26) =====
  // - 引擎是 ES 模块: 用 `await import('/noname.js')` 拿到 { lib, game, ui, get, ai, _status }。
  // - configprefix = "noname_0.9_"; 但配置经 game.readFileAsText 读取(纯静态服务器下 404),
  //   故 localStorage 预置无效, mode 默认回落 'tutorial'。lib.config.characters=['shiZhouNian'], cards=['xingBei']。
  // - 默认值已确认: shiQiMax15/xingBeiMax5/zhanJiMax5/handcardLimit6。
  // - xingBei 模式子配置(默认): versus_mode 'two', free_choose true, AItiLian true, phaseswap false ...
  // - 直接 ui.create.arena()+game.createEvent('game').setContent(lib.mode.xingBei.start) 重放启动
  //   会抛 'Cannot read properties of undefined (reading push)' —— 缺少 onload 的前置初始化, 不能裸调。
  //
  // ===== 推荐的两条落地路径(择一实现) =====
  // 路径1 (供 readFileAsText 文件API, 走"支持"的流程, 最稳):
  //   - 在 server.mjs 增加可读写的 config 文件端点, 或注入 game.readFileAsText/writeFile 的内存/HTTP 实现;
  //   - 然后 game.saveConfig('mode','xingBei') + 设置 'xingBei_*' 子配置 + game.reload();
  //   - free_choose=false 让角色随机分配(免手动选角), _status.auto=true 让 AI 全自动。
  // 路径2 (复刻菜单"开始游戏"的 in-session 启动):
  //   - 定位菜单点"单机→某模式→开始"实际调用的内部函数(ui/click 或 create/menu 内),
  //   - 用它在同一会话内正确启动, 避免裸调 mode.start 的前置缺失。
  //   - get.config 的键映射需先确认(launch-test 显示 free_choose 仍读到 true, 说明键名非 'xingBei_free_choose')。
  //
  // 角色自动分配: 设 free_choose=false; 若仍弹选角对话框, 在 _status.auto 下需驱动 ai 自动选取或随机指派。
  await page.evaluate(async ({ mode }) => {
    const nn = await import('/noname.js'); const { lib, game, ui, _status } = nn;
    while (ui.dialogs && ui.dialogs.length) { try { ui.dialogs[0].close(); } catch { break; } }
    lib.config.mode_config = lib.config.mode_config || {};
    lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei||{}, { versus_mode: mode, free_choose:false, choose_number:1, AItiLian:true, phaseswap:false, change_identity:false });
    lib.config.mode = 'xingBei'; _status.auto = true;
    game.saveConfig('mode','xingBei'); game.saveConfig('mode_config', lib.config.mode_config);
    setTimeout(()=>game.reload(), 150);
  }, { mode });
}

// ===== 已跑通的启动(路径1, saveConfig+reload), 唯余"自动选将"未通 =====
// 验证: 设 lib.config.mode_config.xingBei + mode='xingBei' → saveConfig → game.reload()
//   重载后稳定创建 4 玩家进入选将。get.config 读 lib.config.mode_config[mode][item]。
async function startMatchSupported(page, { versus = 'three' }) {
  await page.evaluate(async (versus) => {
    const nn = await import('/noname.js'); const { lib, game, ui } = nn;
    while (ui.dialogs && ui.dialogs.length) { try { ui.dialogs[0].close(); } catch { break; } }
    lib.config.mode_config = lib.config.mode_config || {};
    lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei || {}, {
      versus_mode: versus, free_choose: false, choose_number: 1, AItiLian: true,
      phaseswap: false, change_identity: false
    });
    lib.config.mode = 'xingBei';
    game.saveConfig('mode', 'xingBei');
    game.saveConfig('mode_config', lib.config.mode_config);
    setTimeout(() => game.reload(), 150);
  }, versus);
  // TODO[最后一步]: 重载后自动选将+确认, 再 _status.auto=true 让 AI 跑完。
}

await mkdir(MATCHES, { recursive: true });
const server = await startServer();
const browser = await chromium.launch({ headless: HEADLESS });

let wins = { red: 0, blue: 0 }, byShiqi = 0, byCup = 0, ok = 0, fail = 0;

for (let i = 0; i < N; i++) {
  const matchId = `m_${String(SEED0 + i).padStart(6, '0')}`;
  const page = await browser.newPage();
  page.on('console', m => { if (/error|fail/i.test(m.text())) console.log('[page]', m.text()); });
  try {
    await page.addInitScript(RECORDER);
    await page.addInitScript(() => { window.__xbAuto = setInterval(async()=>{try{const{_status}=window.__nn||(window.__nn=await import('/noname.js'));if(_status)_status.auto=true;}catch{}},500); });
    if (OVERLAY) {
      // 注入优化AI overlay(ai-overlay/install.js)。需引擎初始化后再 install, 见 README。
      // TODO[DISCOVER]: 在引擎 ready 后调用 installOverlay(engineRefs, weights)。
    }
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(6000);
    await startMatch(page, { mode: MODE, seed: SEED0 + i, teamA: TEAM_A, teamB: TEAM_B });
    const clk = setInterval(()=>page.evaluate(()=>{const d=document.querySelector('.dialog');if(d){const b=d.querySelector('.button:not(.selected)');if(b)b.click();}document.querySelectorAll('.menubutton,.control').forEach(c=>{if(/确定|开始/.test(c.innerText))c.click();});}).catch(()=>{}), 700);

    // 等待对局结束(__xbResult 被填充), 最多等 5 分钟。
    await page.waitForFunction(() => window.__xbResult !== null, { timeout: 300000 });
    clearInterval(clk);
    const result = await page.evaluate(() => window.__xbResult);

    const line = JSON.stringify({ type: 'result', match_id: matchId, mode: MODE,
      seed: SEED0 + i, overlay: OVERLAY, ...result });
    await appendFile(join(MATCHES, `${matchId}.jsonl`), line + '\n');
    if (result.winner_side) wins[result.winner_side]++;
    if (result.win_by === 'shiqi0') byShiqi++; else if (result.win_by === 'xingBei5') byCup++;
    ok++;
    console.log(`[selfplay] ${i + 1}/${N} ${matchId} -> ${result.winner_side} by ${result.win_by} (turns ${result.turns})`);
  } catch (e) {
    fail++;
    console.log(`[selfplay] ${i + 1}/${N} ${matchId} FAILED: ${String(e).slice(0, 200)}`);
  } finally {
    await page.close();
  }
}

console.log(`\n[selfplay] done ok=${ok} fail=${fail} | red=${wins.red} blue=${wins.blue} | byShiqi=${byShiqi} byCup=${byCup}`);
await browser.close();
server.close();
