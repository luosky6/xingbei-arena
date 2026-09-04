// bridge/selfplay.mjs
// 基线自对弈: 用引擎内置 AI 跑 N 局星杯对局, 把结果与逐事件轨迹落盘。
// 这是"立刻能开始训练"的最快路径: 先拿到 baseline 数据与可用管线, 再叠加 overlay 优化AI。
//
// 启动序列已通过 probe 与实际对局验证；若引擎升级，先运行 `npm run probe` 检查兼容性。
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';
import { browserLaunchOptions } from './browser.mjs';
import { engineFingerprint, inspectEngine, resolveEngineRoot } from './engine.mjs';
import { installTrajectoryRecorder, readTrajectory } from './trajectoryRecorder.mjs';
import { validateSetup } from '../rules/adjudicator.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const MATCHES = join(RUNTIME, 'matches');
const TRAJECTORIES = join(RUNTIME, 'trajectories');

const N        = Number(process.env.XB_MATCHES || 20);
const MATCH_PREFIX = process.env.XB_MATCH_PREFIX || 'm';
const MODE     = process.env.XB_MODE || 'three';            // 固定六人局: three=3v3(6人)
const SEED0    = Number(process.env.XB_SEED || 1000);
const TEAM_A   = (process.env.XB_TEAM_A || '').split(',').filter(Boolean); // e.g. fengZhiJianSheng,shengNv
const TEAM_B   = (process.env.XB_TEAM_B || '').split(',').filter(Boolean);
const HEADLESS = process.env.XB_HEADFUL ? false : true;
const OVERLAY  = !!process.env.XB_OVERLAY;                // 是否注入 ai-overlay (优化AI)
const OVERLAY_SIDE = process.env.XB_OVERLAY_SIDE || 'both'; // both|red|blue；仅 XB_OVERLAY=1 时生效
const MODERN_UI = !!process.env.XB_MODERN_UI;             // 仅视觉主题 overlay，默认关闭以保持基线
const RANDOM   = !!process.env.XB_RANDOM;                 // 默认可复现；需要真实随机时显式开启
const MATCH_TIMEOUT_MS = Number(process.env.XB_MATCH_TIMEOUT_MS || 300000);
const EXPECTED_PLAYERS = { two: 4, three: 6, four: 8 };
if (!Number.isFinite(MATCH_TIMEOUT_MS) || MATCH_TIMEOUT_MS < 1000) throw new Error(`XB_MATCH_TIMEOUT_MS must be >=1000, got ${MATCH_TIMEOUT_MS}`);
if (!Object.hasOwn(EXPECTED_PLAYERS, MODE)) throw new Error(`XB_MODE must be one of ${Object.keys(EXPECTED_PLAYERS).join(', ')}, got ${MODE}`);
if ((TEAM_A.length || TEAM_B.length) && (TEAM_A.length !== EXPECTED_PLAYERS[MODE] / 2 || TEAM_B.length !== EXPECTED_PLAYERS[MODE] / 2)) {
  throw new Error(`explicit lineup requires ${EXPECTED_PLAYERS[MODE] / 2} characters per team; got A=${TEAM_A.length}, B=${TEAM_B.length}`);
}
if (!['both', 'red', 'blue'].includes(OVERLAY_SIDE)) throw new Error(`XB_OVERLAY_SIDE must be both|red|blue, got ${OVERLAY_SIDE}`);
if (!/^[A-Za-z0-9_-]+$/.test(MATCH_PREFIX)) throw new Error(`XB_MATCH_PREFIX contains unsafe characters: ${MATCH_PREFIX}`);
const ENGINE_ROOT = resolveEngineRoot();
const RULE_PROFILE = MODE === 'four' ? 'supplement-8p' : 'core-10th';
const RULE_SETUP = validateSetup({ players: EXPECTED_PLAYERS[MODE], profile: RULE_PROFILE });
const RULES_VERSION = process.env.XB_RULES_VERSION || (MODE === 'four' ? 'manual-10th-supplement-8p-v0.1' : 'manual-10th-core-v0.1');
const ENGINE_CHECK = await inspectEngine(ENGINE_ROOT);
if (!ENGINE_CHECK.ready) throw new Error(`engine checkout is incomplete: ${ENGINE_CHECK.files.filter(item => !item.exists).map(item => item.file).join(', ')}`);
const ENGINE_FINGERPRINT = await engineFingerprint(ENGINE_ROOT);
// overlay 已接通价值函数、伤害估值、集火态度和浅层候选重排；外部策略
// 接管仍由独立 decision bridge 控制，避免把启发式和信箱策略混成一个指标。
const POLICY_ID = OVERLAY ? `overlay-v0-partial:${OVERLAY_SIDE}` : 'builtin-v0';
const hashConfig = seed => createHash('sha256').update(JSON.stringify({ mode: MODE, seed, teamA: TEAM_A, teamB: TEAM_B, overlay: OVERLAY, overlay_side: OVERLAY_SIDE, random: RANDOM, policy_id: POLICY_ID, rules_profile: RULE_PROFILE, initial_morale: RULE_SETUP.morale, rules_version: RULES_VERSION, engine_fingerprint: ENGINE_FINGERPRINT })).digest('hex');

// 历史版本的内嵌记录器仅保留作迁移参考；生产路径使用
// `bridge/trajectoryRecorder.mjs`，只包装公开 API，不改写 noname_xingbei。
const LEGACY_RECORDER = () => {
  // 旧版内嵌轨迹记录器保留作历史参考；实际轨迹由 trajectoryRecorder.mjs 负责。
  return;
  /* legacy recorder body (kept until v1 migration is complete)
  if (window.__xbRecorderInstalled) return;
  window.__xbRecorderInstalled = true;
  window.__xbResult = null;
  window.__xbTrajectory = [];
  const MAX_TRAJECTORY = 30000;
  const startedAt = performance.now();
  const compact = value => {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(compact);
    if (value?.name1 || value?.name2) return { player: value.name1 || value.name2, seat: value.dataset?.position, side: value.side };
    if (value?.name && (value.isCard || value.cardid || value.suit || value.nature)) return { card: value.name, suit: value.suit, number: value.number, nature: value.nature, id: value.cardid };
    if (value?.name && typeof value.name === 'string') return { name: value.name, id: value.id, link: compact(value.link) };
    if (value && Object.prototype.hasOwnProperty.call(value, 'link')) return { link: compact(value.link), text: typeof value.innerText === 'string' ? value.innerText : void 0 };
    if (value?.dataset?.position != null) return { seat: value.dataset.position, name: value.name1 || value.name };
    if (typeof value === 'object') {
      const out = {};
      for (const key of ['name', 'mode', 'type', 'step', 'bool', 'control', 'skill', 'card', 'target', 'targets', 'cards', 'links', 'confirm', 'action', 'args', 'event', 'selected', 'data']) {
        if (key in value) out[key] = compact(value[key]);
      }
      return Object.keys(out).length ? out : String(value);
    }
    return String(value);
  };
  const snapshot = nn => {
    const { game: g, get, _status } = nn || {};
    if (!g) return null;
    const eventChain = [];
    let event = _status?.event;
    let guard = 0;
    while (event && guard++ < 8) {
      eventChain.push({ name: event.name, type: event.type, step: event.step, player: event.player?.name1 || event.player?.name,
        source: event.source?.name1 || event.source?.name, target: event.target?.name1 || event.target?.name });
      event = typeof event.getParent === 'function' ? event.getParent() : null;
    }
    const team = side => ({
      shiqi: typeof get?.shiQi === 'function' ? get.shiQi(side) : (side ? g.hongShiQi : g.lanShiQi),
      xingbei: typeof get?.xingBei === 'function' ? get.xingBei(side) : (side ? g.hongXingBei : g.lanXingBei),
      zhanji: typeof get?.zhanJi === 'function' ? get.zhanJi(side) : void 0,
    });
    return {
      phase_number: g.phaseNumber ?? null,
      current_phase: _status?.currentPhase?.name1 || null,
      event: eventChain,
      red: team(true), blue: team(false),
      card_pile: g.cardPile?.childElementCount ?? null,
      discard_pile: g.discardPile?.childElementCount ?? null,
      players: (g.players || []).map(p => ({
        seat: p.dataset?.position ?? null, name: p.name1 || p.name || null, side: p.side === true ? 'red' : 'blue',
        hp: p.hp ?? null, max_hp: p.maxHp ?? null, turned: !!p.isTurned?.(),
        hand: typeof p.getCards === 'function' ? p.getCards('h').map(c => c.name) : [],
        equip: typeof p.getCards === 'function' ? p.getCards('e').map(c => c.name) : [],
        skills: Array.isArray(p.skills) ? p.skills.slice() : [],
        stat: Array.isArray(p.stat) ? p.stat.slice(-3).map(compact) : [],
      })),
    };
  };
  const record = (kind, payload, nn, includeState = true) => {
    try {
      const item = { t_ms: Math.round(performance.now() - startedAt), kind, payload: compact(payload) };
      if (includeState) item.state = snapshot(nn);
      window.__xbTrajectory.push(item);
      if (window.__xbTrajectory.length > MAX_TRAJECTORY) window.__xbTrajectory.splice(0, window.__xbTrajectory.length - MAX_TRAJECTORY);
    } catch {}
  };
  const wrap = async () => {
    const nn = window.__nn || (window.__nn = await import('/noname.js').catch(()=>null));
    const g = nn && nn.game;
    if (!g || !g.over) { return setTimeout(wrap, 200); }
    if (!g.__xbWrapped) {
      g.__xbWrapped = true;
      const orig = g.over.bind(g);
      g.over = function (bool) {
        try {
          record('over', { bool }, nn);
          const stats = (g.players || []).map(p => {
          const acc = { seat: p.dataset && p.dataset.position, actor: p.name1 || p.name,
            side: p.side ? 'red' : 'blue', damage: 0, damaged: 0,
            change_shiqi: 0, changed_shiqi: 0, add_zhanji: 0, add_zhiliao: 0 };
          for (const s of (p.stat || [])) {
            if (s.damage) acc.damage += s.damage;
            if (s.damaged) acc.damaged += s.damaged;
            if (s.changeShiQi) acc.change_shiqi += s.changeShiQi;
            if (s.changedShiQi) acc.changed_shiqi += s.changedShiQi;
            if (s.addZhanJi) acc.add_zhanji += s.addZhanJi;
            if (s.addZhiLiao) acc.add_zhiliao += s.addZhiLiao;
          }
          acc.is_winner = (bool === true) === (p.side === g.me.side);
          return acc;
          });
          window.__xbResult = {
            schema_version: 'trajectory.v1',
            win_by: (g.hongShiQi <= 0 || g.lanShiQi <= 0) ? 'shiqi0' : 'xingBei5',
            red_shiqi: g.hongShiQi, blue_shiqi: g.lanShiQi,
            red_xingbei: g.hongXingBei, blue_xingbei: g.lanXingBei,
            winner_side: (typeof bool === 'boolean' && g.me) ? (bool === true ? (g.me.side ? 'red' : 'blue') : (g.me.side ? 'blue' : 'red')) : null,
            turns: g.phaseNumber || null, stats, trajectory: window.__xbTrajectory,
          };
        } catch (e) { window.__xbResult = { schema_version: 'trajectory.v1', error: String(e), trajectory: window.__xbTrajectory }; }
        return orig(bool);
      };
    }
    if (typeof g.addVideo === 'function' && !g.__xbTrajectoryVideoWrapped) {
      g.__xbTrajectoryVideoWrapped = true;
      const orig = g.addVideo.bind(g);
      g.addVideo = function (name, ...args) { record('video', { name, args }, nn, false); return orig(name, ...args); };
    }
    if (typeof g.log === 'function' && !g.__xbTrajectoryLogWrapped) {
      g.__xbTrajectoryLogWrapped = true;
      const orig = g.log.bind(g);
      g.log = function (...args) { record('log', args, nn, false); return orig(...args); };
    }
    if (nn.ui?.click && !nn.ui.click.__xbTrajectoryWrapped) {
      nn.ui.click.__xbTrajectoryWrapped = true;
      for (const key of ['ok', 'cancel']) {
        if (typeof nn.ui.click[key] !== 'function') continue;
        const orig = nn.ui.click[key].bind(nn.ui.click);
        nn.ui.click[key] = function (...args) {
          const evt = nn._status?.event;
          record('decision', { action: key, args, event: { name: evt?.name, type: evt?.type, step: evt?.step },
            selected: { cards: nn.ui.selected?.cards, targets: nn.ui.selected?.targets, buttons: nn.ui.selected?.buttons, skills: nn.ui.selected?.skills } }, nn);
          return orig(...args);
        };
      }
    }
    record('ready', { mode: nn.lib?.config?.mode }, nn);
    if (!window.__xbTrajectoryTicker) {
      window.__xbTrajectoryTicker = setInterval(() => record('tick', null, window.__nn || nn), 250);
    }
  };
  wrap();
  */
};

// 只负责把终局摘要暴露给 Node；逐事件轨迹由公开 GameEvent/API hook 另行采集。
const RESULT_RECORDER = () => {
  if (window.__xbResultRecorderInstalled) return;
  window.__xbResultRecorderInstalled = true;
  window.__xbResult = null;
  const install = async () => {
    const nn = window.__nn || (window.__nn = await import('/noname.js').catch(() => null));
    const g = nn?.game;
    if (!g?.over) return setTimeout(install, 200);
    if (g.__xbResultWrapped) return;
    g.__xbResultWrapped = true;
    const original = g.over.bind(g);
    g.over = function (bool) {
      try {
        const stats = (g.players || []).map(p => {
          const acc = { seat: p.dataset?.position, actor: p.name1 || p.name, side: p.side ? 'red' : 'blue',
            damage: 0, damaged: 0, change_shiqi: 0, changed_shiqi: 0, add_zhanji: 0, add_zhiliao: 0 };
          for (const s of (p.stat || [])) {
            if (s.damage) acc.damage += s.damage;
            if (s.damaged) acc.damaged += s.damaged;
            if (s.changeShiQi) acc.change_shiqi += s.changeShiQi;
            if (s.changedShiQi) acc.changed_shiqi += s.changedShiQi;
            if (s.addZhanJi) acc.add_zhanji += s.addZhanJi;
            if (s.addZhiLiao) acc.add_zhiliao += s.addZhiLiao;
          }
          acc.is_winner = (bool === true) === (p.side === g.me?.side);
          return acc;
        });
        window.__xbResult = {
          schema_version: 'result.v1',
          win_by: (g.hongShiQi <= 0 || g.lanShiQi <= 0) ? 'shiqi0' : 'xingBei5',
          red_shiqi: g.hongShiQi, blue_shiqi: g.lanShiQi,
          red_xingbei: g.hongXingBei, blue_xingbei: g.lanXingBei,
          winner_side: (typeof bool === 'boolean' && g.me) ? (bool === true ? (g.me.side ? 'red' : 'blue') : (g.me.side ? 'blue' : 'red')) : null,
          turns: g.phaseNumber || null, stats, overlay_installed: !!window.__xbOverlayInstalled,
        };
      } catch (error) { window.__xbResult = { schema_version: 'result.v1', error: String(error) }; }
      return original(bool);
    };
  };
  install();
};

// 浏览器端安装 overlay。竞技场模块通过 /__arena/ 只读前缀提供，避免把
// arena 源码复制进引擎目录；安装只在 xingBei 玩家创建完成后执行一次。
const OVERLAY_BOOTSTRAP = overlaySide => {
  if (window.__xbOverlayBootstrap) return;
  window.__xbOverlayBootstrap = true;
  const attempt = async () => {
    const nn = window.__nn || (window.__nn = await import('/noname.js'));
    if (!nn?.game?.players?.length || !nn.lib?.config) return setTimeout(attempt, 200);
    const [overlay, weights] = await Promise.all([
      import('/__arena/ai-overlay/install.js'),
      fetch('/__arena/ai-overlay/weights.json', { cache: 'no-store' }).then(response => response.json()).catch(() => ({})),
    ]);
    if (typeof overlay.installOverlay === 'function') {
      const side = overlaySide === 'red' ? true : overlaySide === 'blue' ? false : null;
      overlay.installOverlay(nn, weights, { side });
      window.__xbOverlayInstalled = true;
    }
  };
  attempt().catch(() => setTimeout(attempt, 500));
};

// 可逆现代主题，仅消费现有 DOM/CSS，不改变规则或隐藏信息。
const UI_BOOTSTRAP = ({ matchId, policyId }) => {
  if (window.__xbModernUIBootstrap) return;
  window.__xbModernUIBootstrap = true;
  const attempt = async () => {
    try {
      const mod = await import('/__arena/ui-overlay/install.js');
      if (typeof mod.installModernTheme === 'function') await mod.installModernTheme({ matchId, policyId });
    } catch {
      setTimeout(attempt, 500);
    }
  };
  attempt();
};

// 显式阵容注入：不改引擎文件，只在页面初始化时包裹 Player.init。
// 选角事件会先给每个座位写入 side，再逐个调用 init；因此按 side 内的
// 当前座位顺序消费 TEAM_A/TEAM_B。包装器只在 chooseCharacter 事件期间
// 接管第一次初始化，后续技能/换肤等 init 调用完全交还引擎。
const LINEUP_BOOTSTRAP = ({ teamA, teamB, expectedPlayers }) => {
  if ((!Array.isArray(teamA) || !teamA.length) && (!Array.isArray(teamB) || !teamB.length)) return;
  if (window.__xbLineupBootstrap) return;
  window.__xbLineupBootstrap = true;
  window.__xbLineupError = null;
  window.__xbLineupApplied = [];
  const fail = message => {
    window.__xbLineupError = String(message);
    if (window.__xbLineupDebug) console.error(`[xb-lineup] ${window.__xbLineupError}`);
  };
  const install = async () => {
    try {
      const nn = window.__nn || (window.__nn = await import('/noname.js'));
      const proto = nn?.lib?.element?.Player?.prototype;
      if (!proto || typeof proto.init !== 'function') return setTimeout(install, 100);
      const allPlayers = () => {
        const raw = (nn.game || window.game)?.players;
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw.length === 'number') return Array.from(raw);
        if (raw && typeof raw[Symbol.iterator] === 'function') return Array.from(raw);
        return [];
      };
      const seen = new Set();
      const names = [...teamA, ...teamB].map(value => String(value).trim()).filter(Boolean);
      if (names.length !== expectedPlayers || new Set(names).size !== names.length) {
        fail(`lineup requires ${expectedPlayers} unique character ids, got ${names.length}`);
        return;
      }
      // The engine module is available before character packs finish loading;
      // do not classify every requested id as missing during that window.
      if (!nn.lib.character || !Object.keys(nn.lib.character).length) return setTimeout(install, 100);
      const missing = names.filter(name => !nn.lib.character?.[name]);
      if (missing.length) {
        fail(`unknown character id(s): ${missing.join(',')}`);
        return;
      }
      if (proto.init.__xbLineupWrapped) {
        window.__xbLineupReady = true;
        return;
      }
      const original = proto.init;
      const wrapped = function (character, character2, skill, update) {
        const event = nn._status?.event;
        const choosing = String(event?.name || '') === 'chooseCharacter';
        if (choosing && !this.__xbLineupAssigned) {
          const players = allPlayers();
          const index = players.indexOf(this);
          const side = typeof this.side === 'boolean' ? this.side : (index >= 0 ? index < expectedPlayers / 2 : null);
          const team = side === true ? teamA : side === false ? teamB : null;
          const sidePlayers = team ? players.filter(player => (typeof player?.side === 'boolean' ? player.side : players.indexOf(player) < expectedPlayers / 2) === side) : [];
          const sideIndex = sidePlayers.indexOf(this);
          const desired = team?.[sideIndex >= 0 ? sideIndex : 0];
          if (!desired) {
            fail(`cannot map seat ${this.dataset?.position ?? index} to explicit lineup`);
          } else {
            character = desired;
            character2 = undefined;
            this.__xbLineupAssigned = desired;
            seen.add(this);
            window.__xbLineupApplied.push({ seat: this.dataset?.position ?? index, side: side === true ? 'red' : 'blue', character: desired });
          }
        }
        return original.call(this, character, character2, skill, update);
      };
      Object.defineProperty(wrapped, '__xbLineupWrapped', { value: true });
      proto.init = wrapped;
      window.__xbLineupReady = true;
    } catch (error) {
      fail(error?.message || error);
    }
  };
  install();
};

// 启动一局星杯对局(内置 AI 自动对战)。
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
  //   - 然后 game.promises.saveConfig('mode','xingBei') + 逐项保存 xingBei 子配置 + game.reload();
  //   - free_choose=false 让角色随机分配(免手动选角), _status.auto=true 让 AI 全自动。
  // 路径2 (复刻菜单"开始游戏"的 in-session 启动):
  //   - 定位菜单点"单机→某模式→开始"实际调用的内部函数(ui/click 或 create/menu 内),
  //   - 用它在同一会话内正确启动, 避免裸调 mode.start 的前置缺失。
  //   - 模式子配置通过 game.promises.saveConfig(key, value, 'xingBei') 写入，get.config(key) 读取。
  //
  // 角色自动分配: 设 free_choose=false; 若仍弹选角对话框, 在 _status.auto 下需驱动 ai 自动选取或随机指派。
  const configure = async ({ mode }) => {
    const nn = await import('/noname.js'); const { lib, game, ui, _status } = nn;
    while (ui.dialogs && ui.dialogs.length) { try { ui.dialogs[0].close(); } catch { break; } }
    lib.config.mode_config = lib.config.mode_config || {};
    const settings = { versus_mode: mode, shiQiMax: mode === 'four' ? 18 : 15, free_choose:false, choose_number:1, AItiLian:true, phaseswap:false, change_identity:false };
    lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei||{}, settings);
    lib.config.mode = 'xingBei'; _status.auto = true;
    // IndexedDB-backed builds can lose a fire-and-forget save when reload starts
    // immediately. Persist the global mode and every mode-local key through the
    // Promise wrapper; this mirrors the in-game start menu and makes 3v3/4v4
    // selection durable across the reload boundary.
    if (game.promises?.saveConfig) {
      await game.promises.saveConfig('mode', 'xingBei');
      for (const [key, value] of Object.entries(settings)) {
        await game.promises.saveConfig(key, value, 'xingBei');
      }
    } else {
      game.saveConfig('mode','xingBei');
      for (const [key, value] of Object.entries(settings)) game.saveConfig(key, value, 'xingBei');
    }
    setTimeout(()=>game.reload(), 100);
  };
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await page.evaluate(configure, { mode });
      break;
    } catch (error) {
      if (!/Execution context was destroyed|navigation/i.test(String(error)) || attempt === 11) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

await mkdir(MATCHES, { recursive: true });
await mkdir(TRAJECTORIES, { recursive: true });
const server = await startServer();
const browser = await chromium.launch(browserLaunchOptions({ headless: HEADLESS }));

let wins = { red: 0, blue: 0 }, byShiqi = 0, byCup = 0, ok = 0, fail = 0;
const closeWithDeadline = async (resource, timeoutMs = 5000) => {
  if (!resource) return;
  try {
    await Promise.race([
      resource.close(),
      new Promise(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {}
};

for (let i = 0; i < N; i++) {
  const matchId = `${MATCH_PREFIX}_${String(SEED0 + i).padStart(6, '0')}`;
  const page = await browser.newPage();
  let clk = null;
  let appliedLineup = null;
  page.on('console', m => {
    const message = m.text();
    // 资源清单包含可选头像/动画素材，缺失时引擎仍可无头结算；避免把 404 噪声混入训练日志。
    if (/Failed to load resource: the server responded with a status of 404/i.test(message)) return;
    if (/error|fail/i.test(message)) console.log('[page]', message);
  });
  try {
    if (!RANDOM) {
      await page.addInitScript(seed => {
        let state = (Number(seed) >>> 0) || 0x6d2b79f5;
        Math.random = () => {
          state = (state + 0x6d2b79f5) | 0;
          let t = Math.imul(state ^ (state >>> 15), 1 | state);
          t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        window.__xbSeed = Number(seed) >>> 0;
      }, SEED0 + i);
    }
    await page.addInitScript(RESULT_RECORDER);
    await page.addInitScript(() => {
      // 仅写入 _status.auto 不会唤醒正在等待用户输入的 GameEvent；
      // 通过引擎公开的托管入口触发 switchToAuto/redo，才能覆盖选角、响应、结算等暂停点。
      window.__xbAuto = setInterval(async () => {
        try {
          const nn = window.__nn || (window.__nn = await import('/noname.js'));
          const { _status, ui, lib } = nn;
          if (lib?.config) {
            // 自对弈不需要渲染等待；保留引擎事件顺序，只压缩动画/展示间隔。
            lib.config.game_speed = 'vvfast';
            lib.config.speed = 'vvfast';
            lib.config.duration = 25;
            lib.config.sync_speed = false;
            lib.config.animation = false;
            lib.config.low_performance = true;
          }
          if (!_status || _status.auto) return;
          if (ui?.click?.auto) ui.click.auto('forced');
          else _status.auto = true;
        } catch {}
      }, 300);
    });
    if (OVERLAY) {
      await page.addInitScript(OVERLAY_BOOTSTRAP, OVERLAY_SIDE);
    }
    if (MODERN_UI) {
      await page.addInitScript(UI_BOOTSTRAP, { matchId, policyId: POLICY_ID });
    }
    if (process.env.XB_DEBUG) {
      await page.addInitScript(() => {
        window.__xbPrepareCalls = window.__xbPrepareCalls || [];
        const install = () => {
          const nn = window.__nn;
          const prepare = nn?.game?.prepareArena;
          if (!prepare || prepare.__xbDebugWrapped) return;
          const wrapped = function (...args) {
            window.__xbPrepareCalls.push({ args, mode: nn.lib?.config?.mode, versus: nn.get?.config?.('versus_mode'), statusMode: nn._status?.mode });
            return prepare.apply(this, args);
          };
          Object.defineProperty(wrapped, '__xbDebugWrapped', { value: true });
          nn.game.prepareArena = wrapped;
        };
        window.__xbPrepareDebugTimer = setInterval(install, 50);
        install();
      });
    }
    if (TEAM_A.length || TEAM_B.length) {
      await page.addInitScript(LINEUP_BOOTSTRAP, { teamA: TEAM_A, teamB: TEAM_B, expectedPlayers: EXPECTED_PLAYERS[MODE] });
    }
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(6000);
    if (process.env.XB_DEBUG) {
      try {
        const bootConfig = await page.evaluate(async () => {
          const nn = window.__nn || (window.__nn = await import('/noname.js'));
          const { lib, get, _status, game } = nn;
          return {
            mode: lib?.config?.mode,
            versus_mode: get?.config?.('versus_mode'),
            free_choose: get?.config?.('free_choose'),
            mode_config: lib?.config?.mode_config?.xingBei,
            status_mode: _status?.mode,
            players: Array.isArray(game?.players) ? game.players.length : null,
            prepareCalls: window.__xbPrepareCalls || [],
          };
        });
        console.log(`[selfplay-config] ${JSON.stringify(bootConfig)}`);
      } catch (error) {
        console.log(`[selfplay-config] inspect failed: ${String(error).slice(0, 240)}`);
      }
    }
    if (TEAM_A.length || TEAM_B.length) {
      await page.waitForFunction(() => window.__xbLineupReady === true || window.__xbLineupError, undefined, { timeout: 30000 });
      const lineupStatus = await page.evaluate(() => ({ ready: !!window.__xbLineupReady, error: window.__xbLineupError }));
      if (lineupStatus.error) throw new Error(lineupStatus.error);
    }
    const matchConfigHash = hashConfig(SEED0 + i);
    await installTrajectoryRecorder(page, { matchId, seed: SEED0 + i, mode: MODE, overlaySide: OVERLAY_SIDE, rulesProfile: RULE_PROFILE, rulesVersion: RULES_VERSION, engineFingerprint: ENGINE_FINGERPRINT, configHash: matchConfigHash, policyId: POLICY_ID });
    await startMatch(page, { mode: MODE, seed: SEED0 + i, teamA: TEAM_A, teamB: TEAM_B });
    if (process.env.XB_DEBUG) {
      try {
        const configured = await page.evaluate(async () => {
          const nn = window.__nn || (window.__nn = await import('/noname.js'));
          const { lib, get, _status, game } = nn;
          return {
            mode: lib?.config?.mode,
            versus_mode: get?.config?.('versus_mode'),
            free_choose: get?.config?.('free_choose'),
            mode_config: lib?.config?.mode_config?.xingBei,
            status_mode: _status?.mode,
            players: Array.isArray(game?.players) ? game.players.length : null,
            prepareCalls: window.__xbPrepareCalls || [],
          };
        });
        console.log(`[selfplay-config-after] ${JSON.stringify(configured)}`);
      } catch (error) {
        console.log(`[selfplay-config-after] inspect failed: ${String(error).slice(0, 240)}`);
      }
    }
    if (TEAM_A.length || TEAM_B.length) {
      await page.waitForFunction(expected => window.__xbLineupError || (window.__xbLineupApplied || []).length >= expected, EXPECTED_PLAYERS[MODE], { timeout: 30000 });
      const lineupStatus = await page.evaluate(() => ({ error: window.__xbLineupError, applied: window.__xbLineupApplied || [] }));
      if (lineupStatus.error) throw new Error(lineupStatus.error);
      if (lineupStatus.applied.length !== EXPECTED_PLAYERS[MODE]) throw new Error(`explicit lineup was not fully applied: ${lineupStatus.applied.length}/${EXPECTED_PLAYERS[MODE]}`);
      appliedLineup = lineupStatus.applied;
    }
    clk = setInterval(()=>page.evaluate(()=>{const d=document.querySelector('.dialog');if(d){const b=d.querySelector('.button:not(.selected)');if(b)b.click();}document.querySelectorAll('.menubutton,.control').forEach(c=>{if(/确定|开始/.test(c.innerText))c.click();});}).catch(()=>{}), 700);

    // 等待对局结束(__xbResult 被填充), 最多等 5 分钟。
    // Playwright 的 Node API 第二个参数是 arg，选项需放第三个参数。
    await page.waitForFunction(() => window.__xbResult !== null, undefined, { timeout: MATCH_TIMEOUT_MS });
    if (process.env.XB_DEBUG) {
      try {
        const completedConfig = await page.evaluate(async () => {
          const nn = window.__nn || (window.__nn = await import('/noname.js'));
          return {
            mode: nn.lib?.config?.mode,
            versus_mode: nn.get?.config?.('versus_mode'),
            free_choose: nn.get?.config?.('free_choose'),
            status_mode: nn._status?.mode,
            players: Array.isArray(nn.game?.players) ? nn.game.players.length : null,
            prepareCalls: window.__xbPrepareCalls || [],
          };
        });
        console.log(`[selfplay-config-complete] ${JSON.stringify(completedConfig)}`);
      } catch (error) {
        console.log(`[selfplay-config-complete] inspect failed: ${String(error).slice(0, 240)}`);
      }
    }
    const result = await page.evaluate(() => window.__xbResult);
    const observedPlayers = Array.isArray(result?.stats) ? result.stats.length : 0;
    if (observedPlayers !== EXPECTED_PLAYERS[MODE]) {
      throw new Error(`engine player-count mismatch for ${MODE}: expected ${EXPECTED_PLAYERS[MODE]}, observed ${observedPlayers}`);
    }
    const observedSeats = new Set(result.stats.map(stat => String(stat?.seat ?? '')));
    if (observedSeats.size !== observedPlayers || [...observedSeats].some(seat => !/^\d+$/.test(seat))) {
      throw new Error(`engine returned invalid seat statistics for ${MODE}`);
    }
    // 轨迹单独写入 runtime/trajectories，结果行只保留引用和聚合摘要，避免 JSONL 膨胀。
    const { trajectory: _embeddedTrajectory, ...resultSummary } = result || {};
    const trajectory = await readTrajectory(page);
    const observedSeating = trajectory.records.slice().reverse().find(record => record?.public_state?.seating)?.public_state?.seating || null;
    const trajectoryLines = [
      JSON.stringify({ type: 'trajectory_meta', match_id: matchId, mode: MODE, seed: SEED0 + i, overlay_side: OVERLAY_SIDE, rules_profile: RULE_PROFILE, initial_morale: RULE_SETUP.morale, rules_version: RULES_VERSION, engine_fingerprint: ENGINE_FINGERPRINT, config_hash: matchConfigHash, policy_id: POLICY_ID, schema_version: trajectory.schema_version, record_count: trajectory.record_count, dropped_count: trajectory.dropped_count }),
      ...trajectory.records.map(record => JSON.stringify(record)),
      JSON.stringify({ type: 'trajectory_end', match_id: matchId, overlay_side: OVERLAY_SIDE, rules_profile: RULE_PROFILE, initial_morale: RULE_SETUP.morale, rules_version: RULES_VERSION, engine_fingerprint: ENGINE_FINGERPRINT, config_hash: matchConfigHash, policy_id: POLICY_ID, schema_version: trajectory.schema_version, record_count: trajectory.record_count, dropped_count: trajectory.dropped_count }),
    ];
    await writeFile(join(TRAJECTORIES, `${matchId}.jsonl`), trajectoryLines.join('\n') + '\n');

    const line = JSON.stringify({ type: 'result', match_id: matchId, mode: MODE,
      seed: SEED0 + i, overlay: OVERLAY, overlay_side: OVERLAY_SIDE, rules_profile: RULE_PROFILE, initial_morale: RULE_SETUP.morale, lineup: (TEAM_A.length || TEAM_B.length) ? { requested: { team_a: TEAM_A, team_b: TEAM_B }, applied: appliedLineup } : null, seating: observedSeating, policy_id: POLICY_ID, rules_version: RULES_VERSION, engine_root: ENGINE_ROOT, engine_fingerprint: ENGINE_FINGERPRINT, config_hash: matchConfigHash, trajectory_file: `runtime/trajectories/${matchId}.jsonl`, trajectory_records: trajectory.record_count, trajectory_dropped: trajectory.dropped_count, ...resultSummary });
    await appendFile(join(MATCHES, `${matchId}.jsonl`), line + '\n');
    if (result.winner_side) wins[result.winner_side]++;
    if (result.win_by === 'shiqi0') byShiqi++; else if (result.win_by === 'xingBei5') byCup++;
    ok++;
    console.log(`[selfplay] ${i + 1}/${N} ${matchId} -> ${result.winner_side} by ${result.win_by} (turns ${result.turns})`);
  } catch (e) {
    fail++;
    const message = String(e).slice(0, 500);
    const timedOut = /timeout|Timeout/i.test(message);
    await appendFile(join(MATCHES, `${matchId}.jsonl`), JSON.stringify({
      type: 'result', schema_version: 'result.v1', status: timedOut ? 'timeout' : 'error', ok: false,
      match_id: matchId, mode: MODE, seed: SEED0 + i, overlay: OVERLAY, overlay_side: OVERLAY_SIDE, rules_profile: RULE_PROFILE, initial_morale: RULE_SETUP.morale,
      lineup: (TEAM_A.length || TEAM_B.length) ? { requested: { team_a: TEAM_A, team_b: TEAM_B }, applied: appliedLineup } : null,
      policy_id: POLICY_ID, rules_version: RULES_VERSION, engine_root: ENGINE_ROOT,
      engine_fingerprint: ENGINE_FINGERPRINT, config_hash: hashConfig(SEED0 + i), error: message,
      expected_players: EXPECTED_PLAYERS[MODE],
    }) + '\n');
    console.log(`[selfplay] ${i + 1}/${N} ${matchId} ${timedOut ? 'TIMEOUT' : 'FAILED'}: ${message}`);
  } finally {
    if (clk) clearInterval(clk);
    await closeWithDeadline(page);
  }
}

console.log(`\n[selfplay] done ok=${ok} fail=${fail} | red=${wins.red} blue=${wins.blue} | byShiqi=${byShiqi} byCup=${byCup}`);
await closeWithDeadline(browser, 10000);
server.close();
if (fail > 0) process.exitCode = 1;
