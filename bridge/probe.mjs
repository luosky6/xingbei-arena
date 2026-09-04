// bridge/probe.mjs
// 一次性"探针": 打开无头引擎, 把运行时 API 与启动星杯对局所需的信息 dump 到 runtime/probe.json。
// 因为 noname 启动序列(首屏菜单/配置)依机器而异, 用本脚本让 Copilot CLI 看到真实情况后补全 selfplay 的 startMatch()。
import { chromium } from 'playwright';
import { browserLaunchOptions } from './browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');

const server = await startServer();
const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
const page = await browser.newPage();
page.on('console', m => console.log('[page]', m.text()));

await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
// 给引擎一点初始化时间
await page.waitForTimeout(8000);

const info = await page.evaluate(async () => {
  const out = {};
  // noname 是 ES 模块: 动态 import /noname.js 拿到导出引用 (lib/game/ui/get/ai/_status)
  let nn = null;
  try {
    nn = await import('/noname.js');
    window.__nn = nn;
    out.moduleExports = Object.keys(nn);
  } catch (e) { out.importError = String(e); }

  const lib = nn && nn.lib, game = nn && nn.game, _status = nn && nn._status;
  out.hasGame = !!game; out.hasLib = !!lib;
  try { out.modes = lib && Object.keys(lib.mode || {}); } catch {}
  try { out.configMode = lib && lib.config && lib.config.mode; } catch {}
  try { out.connectMode = lib && lib.config && lib.config.connect_mode; } catch {}
  try {
    out.xingBeiCardLoaded = !!(lib && lib.card && lib.card.anMie);
    out.characterCount = lib && lib.character ? Object.keys(lib.character).length : 0;
    out.sampleCharacters = lib && lib.character ? Object.keys(lib.character).slice(0, 30) : null;
  } catch {}
  try {
    out.gameGlobals = {
      shiQiMax: game?.shiQiMax, xingBeiMax: game?.xingBeiMax,
      zhanJiMax: game?.zhanJiMax, handcardLimit: game?.handcardLimit
    };
  } catch {}
  // 与"开始一局"相关的入口探测
  try {
    out.has = {
      game_prepareArena: !!(game && game.prepareArena),
      game_chooseCharacter: !!(game && game.chooseCharacter),
      game_reload: !!(game && game.reload),
      game_saveConfig: !!(game && game.saveConfig),
      lib_init_start: !!(lib && lib.init && lib.init.start),
      modeXingBei: !!(lib && lib.mode && lib.mode.xingBei),
      status_auto: _status ? ('auto' in _status) : null,
    };
  } catch (e) { out.hasError = String(e); }
  try { out.xingBeiModeConfig = lib && lib.mode && lib.mode.xingBei ? Object.keys(lib.mode.xingBei.config || {}) : null; } catch {}
  out.visibleText = (document.body.innerText || '').slice(0, 1500);
  return out;
});

await mkdir(RUNTIME, { recursive: true });
await writeFile(join(RUNTIME, 'probe.json'), JSON.stringify(info, null, 2));
console.log('[probe] wrote runtime/probe.json');
console.log(JSON.stringify(info, null, 2));

await browser.close();
server.close();
