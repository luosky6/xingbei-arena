// bridge/decisionBridge.mjs
// LLM-在环决策桥(方案②): 让某些座位的决策由外部(Copilot CLI)经"文件信箱"做出, 引擎仍负责规则裁判。
// 机制: 页面内 ai.basic.choose* 被旁路 → 调用 exposeFunction('xbDecide', ...) → Node 写 inbox/<id>.req.json
//       → 轮询 outbox/<id>.res.json → 返回 choice 给引擎。
//
// ⚠️ 骨架: 旁路注入点(将 ai.basic.chooseX 替换为 window.xbDecide)需在引擎 ready 后执行, 见 INJECT_BRIDGE。
// ⚠️ 决策端(读 inbox / 写 outbox)由 Copilot CLI 扮演 Player 子智能体(见 ../AGENTS.md 第3、4.2节)。
import { chromium } from 'playwright';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const INBOX = join(RUNTIME, 'inbox');
const OUTBOX = join(RUNTIME, 'outbox');
const POLL_MS = 500;
const DEADLINE_MS = Number(process.env.XB_DEADLINE || 30000);
// 哪些座位交给 LLM。固定六人局(3v3): 默认全部 6 座位。
const LLM_SEATS = (process.env.XB_LLM_SEATS || '1,2,3,4,5,6').split(',').map(s => s.trim());

await mkdir(INBOX, { recursive: true });
await mkdir(OUTBOX, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Node 侧: 收到页面的决策请求 → 写 inbox → 等 outbox → 返回 choice index。
async function handleDecision(req) {
  const id = req.decision_id;
  await writeFile(join(INBOX, `${id}.req.json`), JSON.stringify(req, null, 2));
  const resPath = join(OUTBOX, `${id}.res.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < DEADLINE_MS) {
    const raw = await readFile(resPath, 'utf8').catch(() => null);
    if (raw) {
      try {
        const res = JSON.parse(raw);
        await rm(resPath).catch(() => {});
        await rm(join(INBOX, `${id}.req.json`)).catch(() => {});
        // 合法性: choice 必须是 legal_options 的 id
        const legalIds = (req.legal_options || []).map(o => o.id);
        if (legalIds.includes(res.choice)) return res.choice;
        console.log(`[bridge] illegal choice for ${id}, fallback first_legal`);
      } catch (e) { console.log(`[bridge] bad response ${id}: ${e}`); }
      break;
    }
    await sleep(POLL_MS);
  }
  // fallback: 第一个合法项
  return (req.legal_options && req.legal_options[0] && req.legal_options[0].id) ?? 0;
}

// [DISCOVER] 注入到页面: 把 ai.basic 的选择函数替换为调用 window.xbDecide。
// 真正实现需把引擎的 chooseTarget/chooseCard/chooseControl/chooseBool 候选 序列化成 legal_options + state。
const INJECT_BRIDGE = (llmSeats) => {
  window.__xbLLMSeats = llmSeats;
  const tryInstall = () => {
    if (!window.ai || !window.ai.basic) return setTimeout(tryInstall, 200);
    // TODO[DISCOVER]: 对每个决策函数, 当 _status.event.player 的座位属于 llmSeats 时,
    //   构造 DecisionRequest(见 AGENTS.md 3.1): 枚举 get.selectableTargets()/selectableCards() 为 legal_options,
    //   读取 game/player 状态为 state, 调用 await window.xbDecide(req) 取 choice, 应用之;
    //   否则回退原版 ai.basic.* (省预算)。
    // 这里仅占位, 保证页面不崩。
    window.__xbBridgeReady = true;
  };
  tryInstall();
};

const server = await startServer();
const browser = await chromium.launch({ headless: process.env.XB_HEADFUL ? false : true });
const page = await browser.newPage();
await page.exposeFunction('xbDecide', handleDecision);
await page.addInitScript(INJECT_BRIDGE, LLM_SEATS);
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });

console.log(`[bridge] ready. LLM seats=${LLM_SEATS.join(',')}`);
console.log(`[bridge] inbox=${INBOX}`);
console.log(`[bridge] 让 Copilot CLI 扮演 Player: 处理 inbox/*.req.json → 写 outbox/<id>.res.json`);
console.log('[bridge] 启动对局后, 决策请求将出现在 inbox。Ctrl+C 结束。');

// 保持进程存活
process.stdin.resume();
