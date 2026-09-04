// tune/optimize.mjs
// 自对弈调参(CEM): 优化 ai-overlay/weights.json, 目标 = 优化AI(overlay) 对 原版内置AI 的胜率。
//
// ⚠️ 依赖 selfplay 支持"红蓝两侧用不同AI对打"(XB_OVERLAY 仅作用于一侧)。
//    阶段0先把 selfplay 跑通(baseline), 再启用本调参。这里给出 CEM 主循环骨架。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const WEIGHTS = process.env.XB_WEIGHTS_PATH || join(__dirname, '..', 'ai-overlay', 'weights.json');
const RUNTIME = join(__dirname, '..', 'runtime');

const GENERATIONS = Number(process.env.XB_GEN || 6);
const POP = Number(process.env.XB_POP || 12);
const ELITE = Number(process.env.XB_ELITE || 4);
const EVAL_MATCHES = Number(process.env.XB_EVAL || 40);
const EVAL_SEED = Number(process.env.XB_OPT_SEED || 700000);
const EVAL_MODE = process.env.XB_MODE || 'two';
const REPORT = join(RUNTIME, 'optimizer-evals.jsonl');

// 仅优化数值型标量权重(顶层)。victim/search 子项可后续纳入。
const KEYS = ['shiqi_diff','shiqi_enemy_near0','shiqi_self_near0','xingbei_diff',
  'xingbei_self_progress','zhanji_self','actions_left','chain_potential','pierce_potential',
  'hand_quality_self','zhiliao_self_team','enemy_burn_exposure','self_burn_exposure',
  'markers_banked_self','tempo'];

function sampleGaussian(mu, sigma) { return mu + sigma * (Math.sqrt(-2*Math.log(Math.random()))*Math.cos(2*Math.PI*Math.random())); }

// 评估一组权重: 红方 overlay、蓝方内置 AI，使用同一批种子，返回真实胜率。
async function evaluate(weightsObj) {
  const base = JSON.parse(await readFile(WEIGHTS, 'utf8'));
  const merged = { ...base };
  for (const k of KEYS) merged[k] = weightsObj[k];
  await writeFile(WEIGHTS, JSON.stringify(merged, null, 2));

  await runSelfplay({ matches: EVAL_MATCHES, overlay: true, overlaySide: 'red', seed: EVAL_SEED, mode: EVAL_MODE, prefix: 'opt_r' });
  await runSelfplay({ matches: EVAL_MATCHES, overlay: true, overlaySide: 'blue', seed: EVAL_SEED, mode: EVAL_MODE, prefix: 'opt_b' });
  const red = await overlayWinRate({ matches: EVAL_MATCHES, seed: EVAL_SEED, side: 'red', prefix: 'opt_r' });
  const blue = await overlayWinRate({ matches: EVAL_MATCHES, seed: EVAL_SEED, side: 'blue', prefix: 'opt_b' });
  const result = { red, blue, wins: red.wins + blue.wins, valid: red.valid + blue.valid, win_rate: (red.win_rate + blue.win_rate) / 2 };
  await writeFile(REPORT, `${JSON.stringify({ ts: new Date().toISOString(), mode: EVAL_MODE, seed: EVAL_SEED, matches_per_side: EVAL_MATCHES, ...result, weights: weightsObj })}\n`, { flag: 'a' });
  return result.win_rate;
}

function runSelfplay(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(__dirname, '..', 'bridge', 'selfplay.mjs')], {
      stdio: 'inherit',
      env: { ...process.env, XB_MATCHES: String(env.matches), XB_OVERLAY: env.overlay ? '1' : '', XB_OVERLAY_SIDE: env.overlaySide || 'both', XB_SEED: String(env.seed ?? EVAL_SEED), XB_MODE: env.mode || EVAL_MODE, XB_MATCH_PREFIX: env.prefix || 'm' }
    });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error('selfplay exit ' + code)));
  });
}

async function overlayWinRate({ matches, seed, side, prefix }) {
  let wins = 0, valid = 0;
  for (let i = 0; i < matches; i++) {
    const path = join(RUNTIME, 'matches', `${prefix}_${String(seed + i).padStart(6, '0')}.jsonl`);
    const lines = (await readFile(path, 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length) continue;
    let row;
    try { row = JSON.parse(lines.at(-1)); } catch { continue; }
    if (row.type !== 'result' || row.overlay_side !== side || row.overlay_installed !== true || row.trajectory_dropped !== 0) continue;
    valid++;
    if (row.winner_side === side) wins++;
  }
  if (!valid) throw new Error(`no valid overlay evaluation results for seed ${seed}`);
  const winRate = wins / valid;
  const z = 1.959963984540054;
  const denom = 1 + z * z / valid;
  const center = (winRate + z * z / (2 * valid)) / denom;
  const radius = z * Math.sqrt((winRate * (1 - winRate) + z * z / (4 * valid)) / valid) / denom;
  return { wins, valid, win_rate: winRate, ci95_low: Math.max(0, center - radius), ci95_high: Math.min(1, center + radius) };
}

async function main() {
  await mkdir(RUNTIME, { recursive: true });
  const init = JSON.parse(await readFile(WEIGHTS, 'utf8'));
  let mu = {}, sigma = {};
  for (const k of KEYS) { mu[k] = init[k] ?? 0; sigma[k] = Math.max(1, Math.abs(mu[k]) * 0.5 || 2); }

  let best = { score: -1, w: { ...mu } };
  for (let g = 0; g < GENERATIONS; g++) {
    const pop = [];
    for (let i = 0; i < POP; i++) {
      const w = {}; for (const k of KEYS) w[k] = sampleGaussian(mu[k], sigma[k]);
      const score = await evaluate(w);
      pop.push({ w, score });
      console.log(`[cem] gen ${g} ind ${i} winrate=${score.toFixed(3)}`);
    }
    pop.sort((a, b) => b.score - a.score);
    if (pop[0].score > best.score) best = pop[0];
    const elite = pop.slice(0, ELITE);
    for (const k of KEYS) {
      const vals = elite.map(e => e.w[k]);
      mu[k] = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / vals.length;
      sigma[k] = Math.max(0.5, Math.sqrt(variance));
    }
    console.log(`[cem] gen ${g} best=${best.score.toFixed(3)}`);
  }

  // 写回最优权重
  const base = JSON.parse(await readFile(WEIGHTS, 'utf8'));
  await writeFile(WEIGHTS, JSON.stringify({ ...base, ...best.w }, null, 2));
  console.log(`[cem] done. best winrate=${best.score.toFixed(3)} written to weights.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
