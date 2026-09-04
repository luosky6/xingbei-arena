// bridge/decisionBridge.mjs
// LLM-在环决策桥: 让某些座位的决策由外部经“文件信箱”做出；引擎负责推进当前实现，规范正确性由规则库与测试另行裁定。
// 机制: 页面内 ai.basic.choose* 被旁路 → 调用 exposeFunction('xbDecide', ...) → Node 写 inbox/<id>.req.json
//       → 轮询 outbox/<id>.res.json → 返回 choice 给引擎。
//
// 基础 choose* 与主要复合行动旁路已在引擎 ready 后注入；动作以“选卡+目标”原子 option 暴露。
// ⚠️ 决策端(读 inbox / 写 outbox)由 Copilot CLI 扮演 Player 子智能体(见 ../AGENTS.md 第3、4.2节)。
import { chromium } from 'playwright';
import { browserLaunchOptions } from './browser.mjs';
import { appendFile, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, PORT } from './server.mjs';
import { behaviorMetadata, decideWithPolicy, fallbackChoice, POLICY_IDS, validateResponse } from './policy.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME = join(__dirname, '..', 'runtime');
const INBOX = join(RUNTIME, 'inbox');
const OUTBOX = join(RUNTIME, 'outbox');
const POLL_MS = 500;
const DEADLINE_MS = Number(process.env.XB_DEADLINE || 30000);
const FALLBACK_POLICY = process.env.XB_FALLBACK_POLICY || 'first_legal';
const INLINE_POLICY = process.env.XB_INLINE_POLICY || '';
const BRIDGE_MATCH_ID = process.env.XB_MATCH_ID || 'bridge';
const AUTO_START = !!process.env.XB_AUTO_START;
const AUTO_MODE = process.env.XB_MODE || 'three';
const TEAM_SEQUENCE = process.env.XB_TEAM_SEQUENCE || null;
const RULES_VERSION = process.env.XB_RULES_VERSION || (AUTO_MODE === 'four' ? 'manual-10th-supplement-8p-v0.1' : 'manual-10th-core-v0.1');
const RULE_PROFILE = AUTO_MODE === 'four' ? 'supplement-8p' : 'core-10th';
const VIOLATIONS = join(RUNTIME, 'violations', 'events.jsonl');
const DECISION_AUDIT = join(RUNTIME, 'decisions', 'events.jsonl');
if (!/^[A-Za-z0-9_-]+$/.test(BRIDGE_MATCH_ID)) throw new Error(`XB_MATCH_ID contains unsafe characters: ${BRIDGE_MATCH_ID}`);
if (!POLICY_IDS.includes(FALLBACK_POLICY)) throw new Error(`XB_FALLBACK_POLICY must be one of ${POLICY_IDS.join(', ')}, got ${FALLBACK_POLICY}`);
if (INLINE_POLICY && !POLICY_IDS.includes(INLINE_POLICY)) throw new Error(`XB_INLINE_POLICY must be one of ${POLICY_IDS.join(', ')}, got ${INLINE_POLICY}`);
if (TEAM_SEQUENCE && !['random', 'near', 'crossed', 'CM', 'BP'].includes(TEAM_SEQUENCE)) throw new Error(`XB_TEAM_SEQUENCE must be random|near|crossed|CM|BP, got ${TEAM_SEQUENCE}`);
// 哪些座位交给 LLM。未显式指定时覆盖当前人数模式的全部座位。
const DEFAULT_SEATS = { two: 4, three: 6, four: 8 }[AUTO_MODE] || 6;
const LLM_SEATS = (process.env.XB_LLM_SEATS || Array.from({ length: DEFAULT_SEATS }, (_, index) => String(index + 1)).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

await mkdir(INBOX, { recursive: true });
await mkdir(OUTBOX, { recursive: true });
await mkdir(join(RUNTIME, 'violations'), { recursive: true });
await mkdir(join(RUNTIME, 'decisions'), { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Node 侧: 收到页面的决策请求 → 写 inbox → 等 outbox → 返回 choice index。
async function recordViolation(req, reason, extra = {}) {
  const event = { type: 'violation', schema_version: 'trajectory.v1', ts_ms: Date.now(), match_id: String(req?.match_id || 'unknown'), rules_version: RULES_VERSION, rules_profile: RULE_PROFILE, decision_id: String(req?.decision_id || 'unknown'), reason, fallback: FALLBACK_POLICY, ...extra };
  await appendFile(VIOLATIONS, JSON.stringify(event) + '\n');
  console.log(`[bridge] violation ${event.decision_id}: ${reason}`);
}

const responseSummary = response => {
  const choice = response?.choice;
  const scores = response?.scores && typeof response.scores === 'object' ? Object.fromEntries(Object.entries(response.scores).slice(0, 128).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) : null;
  return {
    choice: Array.isArray(choice) ? choice.slice(0, 128).map(value => typeof value === 'string' ? value : null) : typeof choice === 'string' ? choice : null,
    policy_id: typeof response?.policy_id === 'string' ? response.policy_id : null,
    model: typeof response?.model === 'string' ? response.model.slice(0, 120) : null,
    trace_id: typeof response?.trace_id === 'string' ? response.trace_id.slice(0, 120) : null,
    scores,
  };
};

async function recordDecisionAudit(req, { source, choice = null, valid = true, reason = null, latencyMs = 0, response = null, candidateScores = null, behavior = null } = {}) {
  const legalOptions = Array.isArray(req?.legal_options) ? req.legal_options : [];
  const selected = Array.isArray(choice) ? choice.slice(0, 128) : choice;
  const event = {
    type: 'decision_audit',
    schema_version: 'decision.v1',
    ts_ms: Date.now(),
    match_id: String(req?.match_id || 'unknown'),
    rules_version: RULES_VERSION,
    rules_profile: RULE_PROFILE,
    decision_id: String(req?.decision_id || 'unknown'),
    decision_type: String(req?.decision_type || 'unknown'),
    seat: req?.seat ?? null,
    side: req?.side ?? null,
    source,
    valid: !!valid,
    reason,
    latency_ms: Math.max(0, Number(latencyMs) || 0),
    candidate_count: legalOptions.length,
    candidate_ids: legalOptions.slice(0, 128).map(option => option?.id).filter(id => typeof id === 'string'),
    candidate_features: Object.fromEntries(legalOptions.slice(0, 128).filter(option => option?.id).map(option => [option.id, option.candidate_features || null])),
    candidate_scores: candidateScores || Object.fromEntries(legalOptions.slice(0, 128).filter(option => option?.id).map(option => [option.id, option.baseline_score ?? null])),
    choice: selected,
    response: response ? responseSummary(response) : null,
    behavior: behavior && typeof behavior === 'object' ? { policy_id: behavior.policy_id || null, epsilon: Number.isFinite(Number(behavior.epsilon)) ? Number(behavior.epsilon) : null, choice_probability: Number.isFinite(Number(behavior.choice_probability)) ? Number(behavior.choice_probability) : null, probability_status: behavior.probability_status || 'unknown' } : null,
  };
  await appendFile(DECISION_AUDIT, JSON.stringify(event) + '\n');
}

async function handleDecision(req) {
  const id = req.decision_id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.#-]+$/.test(id)) {
    await recordViolation(req, 'unsafe_decision_id');
    return fallbackChoice(req, FALLBACK_POLICY);
  }
  // A response window with no legal candidate is a legitimate “pass/no
  // response” branch (common for an unavailable 应战). Do not manufacture a
  // policy violation or wait for an impossible outbox response.
  if (!Array.isArray(req.legal_options) || req.legal_options.length === 0) {
    await recordDecisionAudit(req, { source: 'pass', choice: 0, valid: true, latencyMs: 0, behavior: behaviorMetadata(req, 'first_legal', 0) });
    return 0;
  }
  const startedAt = Date.now();
  await writeFile(join(INBOX, `${id}.req.json`), JSON.stringify(req, null, 2));
  if (INLINE_POLICY) {
    let source = 'inline';
    const choice = await decideWithPolicy(req, INLINE_POLICY).catch(async error => {
      source = 'fallback';
      await recordViolation(req, 'inline_policy_error', { policy: INLINE_POLICY, error: String(error?.message || error).slice(0, 200) });
      return fallbackChoice(req, FALLBACK_POLICY);
    });
    await rm(join(INBOX, `${id}.req.json`)).catch(() => {});
    await recordDecisionAudit(req, { source, choice, valid: source === 'inline', reason: source === 'fallback' ? 'inline_policy_error' : null, latencyMs: Date.now() - startedAt, behavior: behaviorMetadata(req, source === 'inline' ? INLINE_POLICY : FALLBACK_POLICY, choice), candidateScores: Object.fromEntries(req.legal_options.map(option => [option.id, option.baseline_score ?? null])) });
    if (process.env.XB_DEBUG) console.log(`[bridge] inline policy ${INLINE_POLICY}: ${id} -> ${choice}`);
    return choice;
  }
  const resPath = join(OUTBOX, `${id}.res.json`);
  const t0 = Date.now();
  while (Date.now() - t0 < DEADLINE_MS) {
    const raw = await readFile(resPath, 'utf8').catch(() => null);
    if (raw) {
      try {
        const res = JSON.parse(raw);
        await rm(resPath).catch(() => {});
        await rm(join(INBOX, `${id}.req.json`)).catch(() => {});
        const checked = validateResponse(req, res);
        if (checked.ok) {
          await recordDecisionAudit(req, { source: 'external', choice: checked.choice, valid: true, latencyMs: Date.now() - startedAt, response: res, behavior: { policy_id: res?.policy_id || 'external', choice_probability: res?.behavior_probability, probability_status: Number.isFinite(Number(res?.behavior_probability)) ? 'reported_by_external_policy' : 'not_reported' } });
          return checked.choice;
        }
        await recordViolation(req, checked.reason, { response_choice: res.choice, legal_ids: checked.legal_ids || [] });
        const fallback = fallbackChoice(req, FALLBACK_POLICY);
        await recordDecisionAudit(req, { source: 'fallback', choice: fallback, valid: false, reason: checked.reason, latencyMs: Date.now() - startedAt, response: res, behavior: behaviorMetadata(req, FALLBACK_POLICY, fallback) });
        return fallback;
      } catch (e) {
        await recordViolation(req, 'invalid_response_json', { error: String(e?.message || e).slice(0, 200) });
        const fallback = fallbackChoice(req, FALLBACK_POLICY);
        await recordDecisionAudit(req, { source: 'fallback', choice: fallback, valid: false, reason: 'invalid_response_json', latencyMs: Date.now() - startedAt, behavior: behaviorMetadata(req, FALLBACK_POLICY, fallback) });
        return fallback;
      }
    }
    await sleep(POLL_MS);
  }
  await rm(join(INBOX, `${id}.req.json`)).catch(() => {});
  await recordViolation(req, 'deadline_or_missing_response');
  const fallback = fallbackChoice(req, FALLBACK_POLICY);
  await recordDecisionAudit(req, { source: 'fallback', choice: fallback, valid: false, reason: 'deadline_or_missing_response', latencyMs: Date.now() - startedAt, behavior: behaviorMetadata(req, FALLBACK_POLICY, fallback) });
  return fallback;
}

// 注入到页面：将可暂停的 choose* 事件旁路到外部策略。
// 复合动作被编译成一个原子 option，避免把“选卡+选目标”误拆成两个决策。
const INJECT_BRIDGE = ({ llmSeats, fallbackPolicy = 'first_legal' }) => {
  window.__xbLLMSeats = llmSeats;
  const seatOf = player => player?.dataset?.position ?? player?.seatNum ?? player?.seat ?? null;
  const isLLM = player => {
    const seat = seatOf(player);
    if (seat == null) return false;
    const raw = String(seat);
    const plusOne = /^\d+$/.test(raw) ? String(Number(raw) + 1) : null;
    return window.__xbLLMSeats.some(item => String(item) === raw || (plusOne && String(item) === plusOne));
  };
  const playerRef = player => ({ seat: seatOf(player), actor: player?.name1 || player?.name || null, side: player?.side === true ? 'red' : player?.side === false ? 'blue' : null });
  // Role tags are deliberately coarse and derived only from public character
  // / skill text. They expose composition hypotheses to a policy without
  // leaking card identities or private storage; the rules engine remains the
  // authority for legality and effects.
  const roleTags = player => {
    let ids = [];
    try { ids = Array.isArray(player?.skills) ? player.skills : (typeof player?.getSkills === 'function' ? player.getSkills('invisible') || [] : []); } catch { ids = []; }
    const character = player?.name1 || player?.name || '';
    const text = [character, window.lib?.translate?.[character], window.lib?.translate?.[`${character}_info`], ...ids.map(id => [id, window.lib?.translate?.[`${id}_info`], window.lib?.skill?.[id]?.description, window.lib?.skill?.[id]?.prompt].filter(Boolean).join(' '))].filter(Boolean).join(' ');
    const has = pattern => pattern.test(text);
    return { damage: has(/伤害|攻击|法术|必中|强制命中/), heal: has(/治疗|回复|抵御|恢复/), resource: has(/宝石|水晶|能量|星石|提炼/), control: has(/虚弱|中毒|封印|挑衅|无法应战|不能应战/), defense: has(/圣盾|保护|免疫|抵挡/), finisher: has(/星杯|合成|终结|致命|额外回合|额外行动/), setup: has(/标记|指示物|蓄力|充能|准备|铺垫/), position: has(/座位|顺位|相邻|最近|传递|行动顺序/) };
  };
  const roleCoverage = players => {
    const roster = players.map(player => roleTags(player));
    const size = Math.max(1, roster.length);
    return Object.fromEntries(Object.keys(roster[0] || { damage: false, heal: false, resource: false, control: false, defense: false, finisher: false, setup: false, position: false }).map(key => [key, roster.reduce((sum, tags) => sum + (tags[key] ? 1 : 0), 0) / size]));
  };
  const cardRef = card => ({ name: card?.name || card?.viewAs || null, element: card?.element || card?.nature || null, fate: card?.fate || null });
  const allPlayers = () => {
    const game = window.__nn?.game || window.game;
    const raw = game?.players;
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw.length === 'number') return Array.from(raw);
    if (raw && typeof raw[Symbol.iterator] === 'function') return Array.from(raw);
    try { return typeof game?.filterPlayer === 'function' ? game.filterPlayer(() => true) : []; } catch { return []; }
  };
  const publicSeating = () => {
    const game = window.__nn?.game || window.game || {};
    const players = allPlayers();
    const rows = players.map((player, sourceIndex) => ({ player, sourceIndex, seat: seatOf(player) })).filter(row => row.seat != null).sort((left, right) => Number(left.seat) - Number(right.seat) || left.sourceIndex - right.sourceIndex);
    const seats = rows.map(row => row.seat);
    const explicit = rows.length === players.length && new Set(seats.map(String)).size === seats.length;
    const first = window._status?.firstAct || null;
    const firstSeat = first ? seatOf(first) : null;
    const firstIndex = explicit ? seats.findIndex(seat => String(seat) === String(firstSeat)) : -1;
    const turnOrder = firstIndex < 0 ? [] : seats.slice(firstIndex).concat(seats.slice(0, firstIndex));
    const nextBySeat = {}, previousBySeat = {};
    if (explicit && seats.length) seats.forEach((seat, index) => { nextBySeat[String(seat)] = seats[(index + 1) % seats.length]; previousBySeat[String(seat)] = seats[(index - 1 + seats.length) % seats.length]; });
    let sequence = null;
    try { sequence = typeof game.teamSequenceList === 'function' ? game.teamSequenceList() : null; } catch {}
    if (!players.length || !Array.isArray(sequence) || sequence.length !== players.length || !sequence.every(value => typeof value === 'boolean')) sequence = null;
    const config = window.__nn?.lib?.config?.mode_config?.xingBei || {};
    return {
      schema_version: 'seating.v1', seat_order: explicit ? seats : [], side_by_seat: Object.fromEntries(rows.map(row => [String(row.seat), row.player?.side === true ? 'red' : row.player?.side === false ? 'blue' : null])),
      first_act: playerRef(first), first_act_seat: firstSeat, turn_order_from_first_act: turnOrder, next_by_seat: nextBySeat, previous_by_seat: previousBySeat,
      team_sequence: sequence, configured_team_sequence: config.team_sequence ?? window.__nn?.lib?.configOL?.team_sequence ?? null, choose_mode: config.choose_mode ?? window.__nn?.lib?.configOL?.choose_mode ?? null, phase_swap: config.phaseswap ?? window.__nn?.lib?.configOL?.phaseswap ?? null,
    };
  };
  const liveState = actor => {
    const game = window.__nn?.game || window.game || {};
    const side = typeof actor?.side === 'boolean' ? actor.side : null;
    const teamShiQi = side === true ? game.hongShiQi ?? null : side === false ? game.lanShiQi ?? null : null;
    const teamXingBei = side === true ? game.hongXingBei ?? null : side === false ? game.lanXingBei ?? null : null;
    const enemyShiQi = side === true ? game.lanShiQi ?? null : side === false ? game.hongShiQi ?? null : null;
    const enemyXingBei = side === true ? game.lanXingBei ?? null : side === false ? game.hongXingBei ?? null : null;
    const scalarMarks = player => Object.fromEntries(Object.entries(player?.marks || {}).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 32));
    let zhanJi = null;
    try { zhanJi = side == null || typeof window.get?.zhanJi !== 'function' ? null : window.get.zhanJi(side); } catch {}
    return {
      self: { hand: typeof actor?.getCards === 'function' ? actor.getCards('h').map(cardRef) : [], handLimit: typeof actor?.getHandcardLimit === 'function' ? actor.getHandcardLimit() : null, zhiLiao: actor?.zhiLiao ?? null, energy: actor?.energy ?? actor?.nengLiang ?? null, skills: Array.isArray(actor?.skills) ? actor.skills.slice(0, 128) : [], markers: scalarMarks(actor), turned: !!actor?.isTurned?.(), linked: !!actor?.isLinked?.() },
      team: { shiQi: teamShiQi, xingBei: teamXingBei, zhanJi },
      enemy: { shiQi: enemyShiQi, xingBei: enemyXingBei },
      actionsLeft: { gongJiOrFaShu: actor?.storage?.gongJiOrFaShu ?? 0, gongJi: actor?.storage?.gongJi ?? 0, faShu: actor?.storage?.faShu ?? 0, extra: Array.isArray(actor?.storage?.extraXingDong) ? actor.storage.extraXingDong.length : 0 },
      players: allPlayers().map(player => ({ ...playerRef(player), role_tags: roleTags(player), handCount: typeof player.countCards === 'function' ? player.countCards('h') : null, zhiLiao: player.zhiLiao ?? null, markers: scalarMarks(player), turned: !!player?.isTurned?.(), linked: !!player?.isLinked?.() })).slice(0, 16),
      role_coverage: { team: roleCoverage(allPlayers().filter(player => player?.side === actor?.side)), enemy: roleCoverage(allPlayers().filter(player => player?.side !== actor?.side)) },
      phase: window._status?.currentPhase?.name || window._status?.currentPhase?.name1 || null,
      seating: publicSeating(),
    };
  };
  const selectedCards = event => {
    const actor = event.player;
    let cards = [];
    try { cards = typeof actor?.getCards === 'function' ? actor.getCards(event.position || 'hs') || [] : []; } catch {}
    const filter = typeof event.filterCard === 'function' ? event.filterCard : null;
    const selected = cards.filter(card => !filter || (() => { try { return filter(card, actor, event); } catch { return false; } })());
    if (window.__xbBridgeDebug && isActionEvent?.(event)) console.log(`[xb-bridge] cards ${cards.length}->${selected.length}`);
    return selected;
  };
  const selectableTargets = (event, card = null) => {
    const players = allPlayers();
    const filter = typeof event.filterTarget === 'function' ? event.filterTarget : null;
    return players.filter(target => !filter || (() => { try { return filter(card, event.player, target, event); } catch { return false; } })());
  };
  const isActionEvent = event => /^(gongJiOrFaShu|gongJi|faShu|yingZhan|moDan|qiTa)$/.test(String(event?.name || ''));
  const isDecisionEvent = event => /^choose/.test(String(event?.name || '')) || isActionEvent(event);
  const ensureTeamMetadata = () => {
    const game = window.__nn?.game || window.game;
    const players = allPlayers();
    if (!players.length || players.every(player => typeof player?.side === 'boolean')) return players;
    let sequence = null;
    try { sequence = typeof game?.teamSequenceList === 'function' ? game.teamSequenceList() : null; } catch {}
    if (!Array.isArray(sequence) || sequence.length !== players.length) {
      const half = Math.ceil(players.length / 2);
      sequence = players.map((_, index) => index < half);
    }
    players.forEach((player, index) => {
      if (typeof player?.side !== 'boolean') player.side = sequence[index] === true;
    });
    return players;
  };
  const inferredSide = player => {
    if (typeof player?.side === 'boolean') return player.side;
    const color = String(player?.node?.identity?.dataset?.color || '').toLowerCase();
    if (color.startsWith('true') || color.includes('red') || color.includes('红')) return true;
    if (color.startsWith('false') || color.includes('blue') || color.includes('蓝')) return false;
    const label = String(player?.node?.identity?.firstChild?.innerHTML || '');
    if (label.includes('红')) return true;
    if (label.includes('蓝')) return false;
    return null;
  };
  const actionTargets = (event, card) => {
    ensureTeamMetadata();
    const strict = selectableTargets(event, card);
    if (strict.length) return strict;
    // targetEnabledx consults the live UI selection and can reject every
    // target while the external request is being built.  For action events,
    // recover the card's own target predicate and range check without UI state;
    // cardEnabled/cardUsable were already enforced by selectedCards().
    const players = allPlayers();
    const info = window.get?.info?.(card);
    if (!info || typeof info.filterTarget !== 'function') return [];
    const recovered = players.filter(target => {
      try {
        const actorSide = inferredSide(event.player), targetSide = inferredSide(target);
        const actorArg = actorSide == null ? event.player : Object.assign(Object.create(event.player), { side: actorSide });
        const targetArg = targetSide == null ? target : Object.assign(Object.create(target), { side: targetSide });
        const own = Boolean(info.filterTarget(card, actorArg, targetArg));
        const range = !window.lib?.filter?.targetInRange || window.lib.filter.targetInRange(card, event.player, target);
        if (window.__xbBridgeDebug) console.log(`[xb-bridge] target ${target?.name || ''} side=${target?.side} in=${target?.isIn?.()} own=${own} range=${range}`);
        return own && range;
      } catch (error) { if (window.__xbBridgeDebug) console.log(`[xb-bridge] target error ${String(error?.message || error)}`); return false; }
    });
    if (window.__xbBridgeDebug) console.log(`[xb-bridge] recover ${card?.name || ''} actor=${event.player?.name || ''} side=${event.player?.side} players=${players.length} targets=${recovered.length}`);
    return recovered;
  };
  const actionOptions = event => {
    const cards = selectedCards(event);
    const options = [];
    cards.forEach((card, cardIndex) => {
      const targets = actionTargets(event, card);
      let selectTarget = null;
      try {
        selectTarget = typeof event.selectTarget === 'function' ? event.selectTarget(card, event.player) : event.selectTarget;
      } catch {}
      const minTargets = Array.isArray(selectTarget) ? Number(selectTarget[0]) : 1;
      if (window.__xbBridgeDebug) console.log(`[xb-bridge] card ${card?.name || card?.viewAs || cardIndex} targets=${targets.length} min=${minTargets}`);
      if (targets.length && minTargets > 0) {
        targets.forEach((target, targetIndex) => options.push({
          id: `use#${cardIndex}#${targetIndex}`,
          label: `${String(card?.name || card?.viewAs || `手牌${cardIndex + 1}`)} → ${target?.name1 || target?.name || '目标'}(座位${seatOf(target)})`,
          kind: 'use', cardIndex, targetIndex, target_seat: seatOf(target), card: cardRef(card),
        }));
      } else if (minTargets === 0) {
        options.push({ id: `use#${cardIndex}#none`, label: String(card?.name || card?.viewAs || `手牌${cardIndex + 1}`), kind: 'use', cardIndex, targetIndex: null, card: cardRef(card) });
      }
    });
    return options;
  };
  // chooseCardTarget is a single engine event whose result contains both
  // cards and targets. Expose one stable atomic option per legal card/target
  // pair; splitting it into two requests would allow the policy to select an
  // illegal combination after the card predicate changes.
  const cardTargetOptions = event => {
    const cards = selectedCards(event);
    const options = [];
    cards.forEach((card, cardIndex) => {
      const targets = selectableTargets(event, card);
      let selectTarget = null;
      try { selectTarget = typeof event.selectTarget === 'function' ? event.selectTarget(card, event.player) : event.selectTarget; } catch {}
      const minTargets = Array.isArray(selectTarget) ? Number(selectTarget[0]) : Number.isFinite(Number(selectTarget)) ? Number(selectTarget) : 1;
      if (targets.length && minTargets > 0) {
        targets.forEach((target, targetIndex) => options.push({
          id: `cardtarget#${cardIndex}#${targetIndex}`,
          label: `${String(card?.name || card?.viewAs || `手牌${cardIndex + 1}`)} → ${target?.name1 || target?.name || '目标'}(座位${seatOf(target)})`,
          kind: 'card_target', cardIndex, targetIndex, target_seat: seatOf(target), card: cardRef(card),
        }));
      } else if (minTargets === 0) {
        options.push({ id: `cardtarget#${cardIndex}#none`, label: String(card?.name || card?.viewAs || `手牌${cardIndex + 1}`), kind: 'card_target', cardIndex, targetIndex: null, card: cardRef(card) });
      }
    });
    return options;
  };
  // chooseToMove operates on a list of named zones and returns the complete
  // post-move arrangement (`result.moved`), not a card index. Enumerate the
  // unchanged arrangement plus legal pairwise swaps. This covers the actual
  // star-cup skills (two zones, one/two cards) while keeping the final
  // `filterOk` predicate as the authority; larger permutation spaces remain
  // explicitly partial instead of being guessed.
  const moveState = event => {
    const zones = Array.isArray(event?.list) ? event.list : [];
    const cards = [], buckets = [];
    zones.forEach((zone, zoneIndex) => {
      const raw = Array.isArray(zone?.[1]) ? zone[1] : [];
      const bucket = [];
      raw.forEach(card => { const index = cards.length; cards.push(card); bucket.push(index); });
      buckets.push({ index: zoneIndex, label: String(zone?.[0] || `区域${zoneIndex + 1}`), cards: bucket });
    });
    return { zones, cards, buckets };
  };
  const moveOptions = event => {
    const state = moveState(event);
    if (!state.buckets.length || state.cards.length > 8) return [];
    const arrangements = [];
    const add = (buckets, kind, swap = null) => {
      const moved = buckets.map(bucket => bucket.slice());
      try { if (typeof event.filterOk === 'function' && !event.filterOk(moved)) return; } catch { return; }
      const encoded = moved.map(bucket => bucket.join('.')).join('|');
      if (arrangements.some(item => item.encoded === encoded)) return;
      arrangements.push({ encoded, moved, kind, swap });
    };
    add(state.buckets.map(bucket => bucket.cards), 'keep');
    for (let left = 0; left < state.buckets.length; left++) for (let right = left + 1; right < state.buckets.length; right++) {
      for (let leftIndex = 0; leftIndex < state.buckets[left].cards.length; leftIndex++) for (let rightIndex = 0; rightIndex < state.buckets[right].cards.length; rightIndex++) {
        const moved = state.buckets.map(bucket => bucket.cards.slice());
        const leftCard = moved[left][leftIndex], rightCard = moved[right][rightIndex];
        moved[left][leftIndex] = rightCard; moved[right][rightIndex] = leftCard;
        add(moved, 'swap', { left, right, leftIndex, rightIndex });
      }
    }
    return arrangements.map((item, index) => ({ id: `move#${item.encoded || 'empty'}`, label: item.kind === 'keep' ? '保持当前牌区' : `交换 ${state.buckets[item.swap.left].label} ↔ ${state.buckets[item.swap.right].label}`, kind: 'move', moved_indices: item.moved, zone_labels: state.buckets.map(bucket => bucket.label), move_kind: item.kind, index }));
  };
  const optionsFor = event => {
    const name = String(event?.name || '');
    if (isActionEvent(event)) return actionOptions(event);
    if (name === 'chooseCardTarget') return cardTargetOptions(event);
    if (name === 'chooseToMove') return moveOptions(event);
    if (name === 'chooseControl') return (event.controls || []).map((label, index) => ({ id: `control#${index}`, label: String(label), kind: 'control', index }));
    if (name === 'chooseBool') return [{ id: 'bool#true', label: '是', kind: 'bool', value: true }, { id: 'bool#false', label: '否', kind: 'bool', value: false }];
    if (/Button/i.test(name)) {
      const buttons = Array.isArray(event.dialog?.buttons) ? event.dialog.buttons : [];
      return buttons.map((button, index) => ({ id: `button#${index}`, label: String(button?.link || button?.innerText || `选项${index + 1}`), kind: 'button', index, link: button?.link ?? null }));
    }
    if (/Card|Discard|Move|Give/i.test(name) || /Use|Respond/i.test(name)) return selectedCards(event).map((card, index) => ({ id: `card#${index}`, label: card?.name || card?.viewAs || `手牌${index + 1}`, kind: 'card', index, card: cardRef(card) }));
    if (/Target|Player/i.test(name)) return selectableTargets(event).map((target, index) => ({ id: `target#${index}`, label: `${target?.name1 || target?.name || '目标'}(座位${seatOf(target)})`, kind: 'target', index, target_seat: seatOf(target) }));
    return [];
  };
  const selectorBounds = (event, key, optionCount) => {
    let value = event?.[key];
    if (typeof value === 'function') {
      try { value = value.call(event, event.player, event); } catch { value = 1; }
    }
    let min = 1, max = 1;
    if (Array.isArray(value)) {
      min = Number(value[0]); max = Number(value[1] ?? value[0]);
    } else if (Number.isFinite(Number(value))) {
      min = Number(value); max = Number(value);
    }
    if (min < 0) min = 0;
    if (max < 0 || !Number.isFinite(max)) max = optionCount;
    min = Math.max(0, Math.min(Math.floor(min), optionCount));
    max = Math.max(min, Math.min(Math.floor(max), optionCount));
    return { min, max };
  };
  const selectionSpec = (event, name, optionCount) => {
    if (isActionEvent(event)) return { min: 1, max: 1, ordered: false };
    if (name === 'chooseCardTarget') {
      const cardBounds = selectorBounds(event, 'selectCard', selectedCards(event).length);
      const targetBounds = selectorBounds(event, 'selectTarget', allPlayers().length);
      return { min: 1, max: 1, ordered: false, composition: 'atomic_card_target', card_min: cardBounds.min, card_max: cardBounds.max, target_min: targetBounds.min, target_max: targetBounds.max, multi_supported: cardBounds.max <= 1 && targetBounds.max <= 1 };
    }
    if (name === 'chooseToMove') return { min: 1, max: 1, ordered: false, composition: 'move_assignment', assignment_mode: 'keep_or_pairwise_swap' };
    const key = /Button/i.test(name) ? 'selectButton' : /Target|Player/i.test(name) ? 'selectTarget' : /Card|Discard|Move|Give|Use|Respond/i.test(name) ? 'selectCard' : null;
    const bounds = key ? selectorBounds(event, key, optionCount) : { min: 1, max: 1 };
    return { ...bounds, ordered: /Move|Give/i.test(name) || event?.ordered === true };
  };
  const enrichOptions = (event, options, state) => {
    const actorSide = event?.player?.side === true ? 'red' : event?.player?.side === false ? 'blue' : null;
    const actorSeat = seatOf(event?.player);
    const distance = (targetSeat, total) => {
      const from = Number(actorSeat), to = Number(targetSeat);
      if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(total) || total <= 0) return null;
      const delta = Math.abs(to - from);
      return Math.min(delta, total - delta);
    };
    return options.map((option, index) => {
      const target = state.players.find(player => String(player.seat) === String(option.target_seat)) || null;
      const targetPlayer = allPlayers().find(player => String(seatOf(player)) === String(option.target_seat)) || null;
      const targetSide = target?.side || null;
      const feature = {
        index,
        kind: option.kind || null,
        card_index: Number.isInteger(option.cardIndex) ? option.cardIndex : null,
        target_index: Number.isInteger(option.targetIndex) ? option.targetIndex : null,
        card_element: option.card?.element ?? null,
        card_fate: option.card?.fate ?? null,
        target_seat: option.target_seat ?? null,
        target_side: targetSide,
        target_is_enemy: !!targetSide && !!actorSide && targetSide !== actorSide,
        actor_role_tags: roleTags(event?.player),
        target_role_tags: targetPlayer ? roleTags(targetPlayer) : null,
        seat_distance: distance(option.target_seat, state.players.length),
        team_shiqi: state.team?.shiQi ?? null,
        enemy_shiqi: state.enemy?.shiQi ?? null,
        team_xingbei: state.team?.xingBei ?? null,
        enemy_xingbei: state.enemy?.xingBei ?? null,
        action_remaining: state.actionsLeft || null,
      };
      let score = 0;
      if (feature.target_is_enemy) score += 1;
      if (option.kind === 'use') score += 0.1;
      if (feature.target_seat == null) score += 0.05;
      if (feature.enemy_shiqi != null && feature.enemy_shiqi <= 2) score += 0.5;
      return { ...option, candidate_features: feature, baseline_score: Number(score.toFixed(3)) };
    });
  };
  let decisionSeq = 0;
  const buildRequest = event => {
    ensureTeamMetadata();
    const state = liveState(event?.player);
    const rawOptions = optionsFor(event);
    const legalOptions = enrichOptions(event, rawOptions, state);
    const selection = selectionSpec(event, String(event?.name || ''), legalOptions.length);
    return {
    decision_schema: 'decision.v1',
    match_id: window.__xbMatchId || 'bridge',
    decision_id: `${window.__xbMatchId || 'bridge'}#${event?.id || event?.name || 'event'}#${++decisionSeq}`,
    turn: (window.__nn?.game || window.game)?.phaseNumber ?? null,
    seat: seatOf(event?.player),
    side: event?.player?.side === true ? 'red' : event?.player?.side === false ? 'blue' : null,
    actor: event?.player?.name1 || event?.player?.name || null,
    decision_type: event?.name || 'unknown',
    prompt: typeof event?.prompt === 'string' ? event.prompt : null,
    legal_options: legalOptions,
    selection,
    candidate_features: Object.fromEntries(legalOptions.map(option => [option.id, option.candidate_features || null])),
    candidate_scores: Object.fromEntries(legalOptions.map(option => [option.id, option.baseline_score ?? null])),
    state,
    deadline_ms: Number(window.__xbDeadlineMs || 30000),
    fallback: { strategy: fallbackPolicy },
  };
  };
  const byChoice = (request, response) => {
    const options = request.legal_options || [];
    const choice = response?.choice;
    if (Array.isArray(choice)) return choice.map(id => options.findIndex(option => option.id === id)).filter(index => index >= 0).map(index => options[index]);
    return options.find(option => option.id === choice) || options[0] || null;
  };
  const applyChoice = (event, request, response) => {
    const option = byChoice(request, response);
    const name = String(event?.name || '');
    if (!option) {
      event.result = { confirm: 'cancel', bool: false, buttons: [], cards: [], targets: [], links: [] };
      event.choosing = false;
      try { (window.__nn?.game || window.game)?.uncheck?.(); } catch {}
      return;
    }
    // Card/target movement and discard events may require an ordered set of
    // choices. Preserve the caller's order while resolving every id against
    // this request's legal option list; no synthetic card/target is accepted.
    if (Array.isArray(response?.choice) && !['chooseCardTarget', 'chooseToMove'].includes(name) && /Card|Discard|Move|Give/i.test(name)) {
      const selected = Array.isArray(option) ? option : [];
      const cards = selected.map(item => selectedCards(event)[item.index]).filter(Boolean);
      const targets = /Target|Player|Move|Give/i.test(name) ? selected.map(item => selectableTargets(event)[item.index]).filter(Boolean) : [];
      event.result = { confirm: 'ok', bool: cards.length > 0 || targets.length > 0, cards, targets, buttons: [], links: [] };
      event.choosing = false;
      if (event.dialog?.close) event.dialog.close();
      if (event.controlbar?.close) event.controlbar.close();
      try { (window.__nn?.game || window.game)?.uncheck?.(); } catch {}
      return;
    }
    if (name === 'chooseToMove') {
      const selected = Array.isArray(response?.choice) ? byChoice(request, response) : [option];
      const state = moveState(event);
      const chosen = selected[0];
      const moved = Array.isArray(chosen?.moved_indices) ? chosen.moved_indices.map(bucket => (Array.isArray(bucket) ? bucket : []).map(index => state.cards[index]).filter(Boolean)) : [];
      let legal = moved.length === state.buckets.length;
      try { legal = legal && typeof event.filterOk === 'function' && !!event.filterOk(moved); } catch { legal = false; }
      event.result = legal ? { bool: true, moved } : { bool: false };
      event._xbExternalChoice = true;
      event.choosing = false;
      if (event.dialog?.close) event.dialog.close();
      if (event.controlbar?.close) event.controlbar.close();
      try { (window.__nn?.game || window.game)?.uncheck?.(); } catch {}
      return;
    }
    if (name === 'chooseCardTarget') {
      const selected = Array.isArray(response?.choice) ? byChoice(request, response) : [option];
      const cards = selected.map(item => selectedCards(event)[item?.cardIndex]).filter(Boolean);
      const targets = selected.map(item => {
        if (item?.targetIndex == null) return null;
        const card = selectedCards(event)[item.cardIndex];
        return selectableTargets(event, card)[item.targetIndex];
      }).filter(Boolean);
      const cardBounds = selectorBounds(event, 'selectCard', selectedCards(event).length);
      const targetBounds = selectorBounds(event, 'selectTarget', allPlayers().length);
      const legal = cards.length >= cardBounds.min && cards.length <= cardBounds.max && targets.length >= targetBounds.min && targets.length <= targetBounds.max;
      event.result = { confirm: legal ? 'ok' : 'cancel', bool: legal, cards, card: cards[0] || null, targets, buttons: [], links: cards.slice() };
      event._xbExternalChoice = true;
      event.choosing = false;
      if (event.dialog?.close) event.dialog.close();
      if (event.controlbar?.close) event.controlbar.close();
      try { (window.__nn?.game || window.game)?.uncheck?.(); } catch {}
      return;
    }
    if (name === 'chooseControl') event.result = { confirm: 'ok', bool: true, control: event.controls[option.index], index: option.index };
    else if (name === 'chooseBool') event.result = { bool: option.value };
    else if (/Button/i.test(name)) {
      const button = event.dialog?.buttons?.[option.index];
      event.result = { bool: true, buttons: [[button]], links: button ? [button.link] : [] };
    } else if (/Target|Player/i.test(name)) {
      const targets = Array.isArray(response?.choice) ? byChoice(request, response).map(item => selectableTargets(event)[item.index]).filter(Boolean) : [selectableTargets(event)[option.index]].filter(Boolean);
      event.result = { bool: targets.length > 0, targets };
    } else if (/Card|Discard|Move|Give/i.test(name) || /Use|Respond/i.test(name)) {
      const card = selectedCards(event)[option.index];
      event.result = { bool: !!card, cards: card ? [card] : [], card: card || null };
      if (/Use/i.test(name)) event.result.targets = selectableTargets(event).slice(0, 1);
    } else if (isActionEvent(event)) {
      const card = selectedCards(event)[option.cardIndex];
      const targets = actionTargets(event, card);
      const target = option.targetIndex == null ? null : targets[option.targetIndex];
      event.result = { confirm: 'ok', bool: !!card, cards: card ? [card] : [], card: card ? (window.get?.autoViewAs?.(card) || card) : null, targets: target ? [target] : [], buttons: [], links: [] };
      event._xbExternalChoice = true;
      if (window.__xbBridgeDebug) console.log(`[xb-bridge] apply ${event.name} card=${!!card} targets=${target ? 1 : 0}`);
    } else event.result = { bool: false };
    event.choosing = false;
    if (event.dialog?.close) event.dialog.close();
    if (event.controlbar?.close) event.controlbar.close();
    try { (window.__nn?.game || window.game)?.uncheck?.(); } catch {}
  };
  const handlePausedEvent = event => {
    if (!event || event.__xbBridgePending || !isLLM(event.player) || !isDecisionEvent(event)) return;
    event.__xbBridgePending = true;
    const request = buildRequest(event);
    if (window.__xbBridgeDebug) console.log(`[xb-bridge] request ${request.decision_id} ${request.decision_type} options=${request.legal_options.length} labels=${request.legal_options.map(option => option.label).join('|')}`);
    Promise.resolve(typeof window.xbDecide === 'function' ? window.xbDecide(request) : null)
      .then(response => applyChoice(event, request, response || { choice: request.legal_options[0]?.id }))
      .catch(error => { if (window.__xbBridgeDebug) console.log(`[xb-bridge] apply error ${String(error?.message || error)}`); applyChoice(event, request, { choice: request.legal_options[0]?.id }); })
      .finally(() => { try { (window.__nn?.game || window.game || {}).resume?.(); } catch {} });
  };
  const tryInstall = async () => {
    const nn = window.__nn || await import('/noname.js').catch(() => null);
    if (nn) {
      window.__nn = nn;
      for (const key of ['lib', 'game', 'ui', 'get', 'ai', '_status']) if (!window[key] && nn[key]) window[key] = nn[key];
    }
    if (!window.ai || !window.ai.basic || !window.lib?.element?.GameEvent) return setTimeout(tryInstall, 200);
    const proto = window.lib.element.GameEvent.prototype;
    if (typeof proto.isMine === 'function' && !proto.isMine.__xbBridgeWrapped) {
      const original = proto.isMine;
      const wrapped = function (...args) {
        const mine = isLLM(this.player) || original.apply(this, args);
        if (window.__xbBridgeDebug && isDecisionEvent(this) && isLLM(this.player)) console.log(`[xb-bridge] isMine ${this.name}=${mine}`);
        return mine;
      };
      Object.defineProperty(wrapped, '__xbBridgeWrapped', { value: true });
      proto.isMine = wrapped;
    }
    const game = window.game;
    // The engine's auto-confirm path can consume a choose* event before the
    // pause hook runs (especially for the custom gongJiOrFaShu action).  For
    // seats explicitly owned by the external policy, stop check() before it
    // mutates the selection and let the pause bridge produce the result.
    if (game && typeof game.check === 'function' && !game.check.__xbBridgeWrapped) {
      const originalCheck = game.check;
      const wrappedCheck = function (event, ...args) {
        const current = event || window._status?.event;
        if (current && isDecisionEvent(current) && isLLM(current.player)) {
          current.choosing = true;
          if (window.__xbBridgeDebug) console.log(`[xb-bridge] hold ${current.name} for external policy`);
          return false;
        }
        return originalCheck.call(this, event, ...args);
      };
      Object.defineProperty(wrappedCheck, '__xbBridgeWrapped', { value: true });
      game.check = wrappedCheck;
    }
    if (game && typeof game.pause === 'function' && !game.pause.__xbBridgeWrapped) {
      const originalPause = game.pause;
      const wrappedPause = function (...args) {
        const result = originalPause.apply(this, args);
        setTimeout(() => {
          const paused = window._status?.event;
          if (window.__xbBridgeDebug) console.log(`[xb-bridge] pause event=${paused?.name || 'unknown'} seat=${seatOf(paused?.player)} llm=${isLLM(paused?.player)} choosing=${!!paused?.choosing}`);
          handlePausedEvent(paused);
        }, 0);
        return result;
      };
      Object.defineProperty(wrappedPause, '__xbBridgeWrapped', { value: true });
      game.pause = wrappedPause;
    }
    window.__xbBridgeReady = true;
  };
  tryInstall();
};

// Optional terminal summary recorder for LLM-in-the-loop runs. It is kept
// separate from the decision adapter so enabling it never changes rule or
// choice semantics; Node writes the summary only when XB_RECORD_RESULT=1.
const BRIDGE_RESULT_RECORDER = () => {
  if (window.__xbBridgeResultRecorderInstalled) return;
  window.__xbBridgeResultRecorderInstalled = true;
  window.__xbResult = null;
  const install = async () => {
    const nn = window.__nn || (window.__nn = await import('/noname.js').catch(() => null));
    const g = nn?.game;
    if (!g?.over) return setTimeout(install, 200);
    if (g.__xbBridgeResultWrapped) return;
    g.__xbBridgeResultWrapped = true;
    const original = g.over.bind(g);
    g.over = function (bool) {
      try {
        const stats = (g.players || []).map(p => {
          const acc = { seat: p.dataset?.position, actor: p.name1 || p.name, side: p.side ? 'red' : 'blue', damage: 0, damaged: 0, change_shiqi: 0, changed_shiqi: 0, add_zhanji: 0, add_zhiliao: 0 };
          for (const s of (p.stat || [])) { if (s.damage) acc.damage += s.damage; if (s.damaged) acc.damaged += s.damaged; if (s.changeShiQi) acc.change_shiqi += s.changeShiQi; if (s.changedShiQi) acc.changed_shiqi += s.changedShiQi; if (s.addZhanJi) acc.add_zhanji += s.addZhanJi; if (s.addZhiLiao) acc.add_zhiliao += s.addZhiLiao; }
          acc.is_winner = (bool === true) === (p.side === g.me?.side);
          return acc;
        });
        const seating = (g.players || []).map(p => ({ seat: p.dataset?.position ?? p.seatNum ?? null, actor: p.name1 || p.name || null, side: p.side === true ? 'red' : p.side === false ? 'blue' : null }));
        window.__xbResult = { schema_version: 'result.v1', win_by: (g.hongShiQi <= 0 || g.lanShiQi <= 0) ? 'shiqi0' : 'xingBei5', red_shiqi: g.hongShiQi, blue_shiqi: g.lanShiQi, red_xingbei: g.hongXingBei, blue_xingbei: g.lanXingBei, winner_side: typeof bool === 'boolean' && g.me ? (bool === true ? (g.me.side ? 'red' : 'blue') : (g.me.side ? 'blue' : 'red')) : null, turns: g.phaseNumber || null, stats, seating };
      } catch (error) { window.__xbResult = { schema_version: 'result.v1', error: String(error) }; }
      return original(bool);
    };
  };
  install();
};

const server = await startServer();
const browser = await chromium.launch(browserLaunchOptions({ headless: process.env.XB_HEADFUL ? false : true }));
const page = await browser.newPage();
page.on('console', message => { if (process.env.XB_DEBUG && message.text().includes('[xb-bridge]')) console.log(message.text()); });
page.on('pageerror', error => { if (process.env.XB_DEBUG) console.log(`[xb-bridge] pageerror ${String(error?.message || error)}${error?.stack ? `\n${error.stack}` : ''}`); });
await page.exposeFunction('xbDecide', handleDecision);
await page.addInitScript(INJECT_BRIDGE, { llmSeats: LLM_SEATS, fallbackPolicy: FALLBACK_POLICY });
await page.addInitScript(BRIDGE_RESULT_RECORDER);
if (process.env.XB_DEBUG) await page.addInitScript(() => { window.__xbBridgeDebug = true; });
await page.addInitScript(({ matchId, deadlineMs, rulesProfile }) => { window.__xbMatchId = matchId; window.__xbDeadlineMs = deadlineMs; window.__xbRulesProfile = rulesProfile; }, { matchId: BRIDGE_MATCH_ID, deadlineMs: DEADLINE_MS, rulesProfile: RULE_PROFILE });
await page.addInitScript(() => {
  if (window.__xbBridgeAutopilot) return;
  window.__xbBridgeAutopilot = setInterval(async () => {
    try {
      const nn = window.__nn || (window.__nn = await import('/noname.js'));
      const { _status, ui, lib } = nn;
      if (lib?.config) { lib.config.game_speed = 'vvfast'; lib.config.speed = 'vvfast'; lib.config.duration = 25; lib.config.animation = false; lib.config.low_performance = true; lib.config.video = 0; }
      // Headless bridge runs do not need the replay-video database. Some
      // engine builds enter game.over with videoInited=true but no lib.videos,
      // so disable that optional branch before the terminal event.
      if (lib && !Array.isArray(lib.videos)) lib.videos = [];
      const event = _status?.event;
      const seat = event?.player?.dataset?.position ?? event?.player?.seatNum ?? null;
      const aliases = seat == null ? [] : [String(seat), /^\d+$/.test(String(seat)) ? String(Number(seat) + 1) : null].filter(Boolean);
      const selectedForBridge = aliases.some(value => window.__xbLLMSeats?.map(String).includes(value));
      if (event?.choosing && selectedForBridge) return;
      if (!_status?.auto && ui?.click?.auto) ui.click.auto('forced');
      document.querySelectorAll('.menubutton,.control').forEach(control => { if (/跳过向导|继续|确定|开始/.test(control.innerText || '')) control.click(); });
    } catch {}
  }, 300);
});
if (process.env.XB_MODERN_UI) {
  await page.addInitScript(({ matchId, policyId }) => {
    const install = async () => {
      try { const mod = await import('/__arena/ui-overlay/install.js'); await mod.installModernTheme?.({ matchId, policyId }); }
      catch { setTimeout(install, 500); }
    };
    install();
  }, { matchId: BRIDGE_MATCH_ID, policyId: `bridge-${FALLBACK_POLICY}` });
}
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__xbBridgeReady === true, undefined, { timeout: 30000 });

const RECORD_RESULT = /^(1|true|yes)$/i.test(String(process.env.XB_RECORD_RESULT || ''));
const EXIT_ON_RESULT = /^(1|true|yes)$/i.test(String(process.env.XB_EXIT_ON_RESULT || ''));
let resultPoll = null;
if (RECORD_RESULT) {
  resultPoll = setInterval(async () => {
    const result = await page.evaluate(() => window.__xbResult).catch(() => null);
    if (!result || result.error || result.winner_side == null) return;
    const path = join(RUNTIME, 'matches', `${BRIDGE_MATCH_ID}.jsonl`);
    await appendFile(path, JSON.stringify({ type: 'result', match_id: BRIDGE_MATCH_ID, mode: AUTO_MODE, seed: Number.isInteger(Number(process.env.XB_SEED)) ? Number(process.env.XB_SEED) : null, overlay: false, overlay_side: 'both', rules_profile: RULE_PROFILE, rules_version: RULES_VERSION, policy_id: `bridge-${INLINE_POLICY || FALLBACK_POLICY}`, controlled_seats: LLM_SEATS, inline_policy: INLINE_POLICY || null, ...result }) + '\n').catch(() => {});
    clearInterval(resultPoll);
    resultPoll = null;
    console.log(`[bridge] result recorded ${path}`);
    if (EXIT_ON_RESULT) {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      server.close();
      process.exit(0);
    }
  }, 500);
}

if (AUTO_START) {
  await page.evaluate(async ({ mode, teamSequence }) => {
    const nn = await import('/noname.js');
    const { lib, game, _status } = nn;
    for (let attempt = 0; attempt < 100 && (!lib?.config || typeof game?.saveConfig !== 'function'); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!lib?.config || typeof game?.saveConfig !== 'function') throw new Error('engine config API not ready for auto-start');
    lib.config.mode_config = lib.config.mode_config || {};
    lib.config.mode_config.xingBei = Object.assign(lib.config.mode_config.xingBei || {}, { versus_mode: mode, shiQiMax: mode === 'four' ? 18 : 15, free_choose: false, choose_number: 1, AItiLian: true, phaseswap: false, change_identity: false, ...(teamSequence ? { team_sequence: teamSequence } : {}) });
    lib.config.mode = 'xingBei';
    // Non-LLM seats stay on built-in auto; the injected isMine() override
    // still pauses selected seats and routes them to the external policy.
    _status.auto = true;
    const settings = lib.config.mode_config.xingBei;
    if (game.promises?.saveConfig) {
      await game.promises.saveConfig('mode', 'xingBei');
      for (const key of ['versus_mode', 'shiQiMax', 'free_choose', 'choose_number', 'AItiLian', 'phaseswap', 'change_identity', ...(teamSequence ? ['team_sequence'] : [])]) {
        await game.promises.saveConfig(key, settings[key], 'xingBei');
      }
    } else {
      game.saveConfig('mode', 'xingBei');
      for (const key of ['versus_mode', 'shiQiMax', 'free_choose', 'choose_number', 'AItiLian', 'phaseswap', 'change_identity', ...(teamSequence ? ['team_sequence'] : [])]) {
        game.saveConfig(key, settings[key], 'xingBei');
      }
    }
    setTimeout(() => game.reload(), 100);
  }, { mode: AUTO_MODE, teamSequence: TEAM_SEQUENCE });
}
if (process.env.XB_DEBUG) {
  await page.waitForTimeout(5000);
  try {
    console.log('[bridge] debug state', await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 600),
      bridgeReady: window.__xbBridgeReady,
      module: Object.keys(window.__nn || {}),
      event: window.__nn?._status?.event?.name || null,
      eventPlayer: window.__nn?._status?.event?.player?.dataset?.position || null,
      choosing: !!window.__nn?._status?.event?.choosing,
      isMine: typeof window.__nn?._status?.event?.isMine === 'function' ? window.__nn._status.event.isMine() : null,
      gamePlayers: (() => { const g = window.__nn?.game || window.game; const p = g?.players; return { type: typeof p, ctor: p?.constructor?.name || null, length: p?.length ?? null, keys: p ? Object.keys(p).slice(0, 8) : [] }; })(),
      me: window.__nn?.game?.me?.dataset?.position || null,
      pauseWrapped: !!window.__nn?.game?.pause?.__xbBridgeWrapped,
    })));
  } catch (error) {
    console.log(`[bridge] debug state unavailable: ${String(error?.message || error).slice(0, 200)}`);
  }
  for (let sample = 0; sample < 4; sample++) {
    await page.waitForTimeout(2000);
    try {
      console.log('[bridge] debug tick', await page.evaluate(() => { const e = window.__nn?._status?.event; return { name: e?.name || null, step: e?.step ?? null, paused: !!window.__nn?._status?.paused, result: e?.result ? { bool: e.result.bool, cards: e.result.cards?.length || 0, targets: e.result.targets?.length || 0 } : null, parent: e?.parent?.name || null }; }));
    } catch (error) {
      console.log(`[bridge] debug tick unavailable: ${String(error?.message || error).slice(0, 200)}`);
    }
  }
}

console.log(`[bridge] ready. LLM seats=${LLM_SEATS.join(',')}`);
console.log(`[bridge] inbox=${INBOX}`);
console.log(`[bridge] 让 Copilot CLI 扮演 Player: 处理 inbox/*.req.json → 写 outbox/<id>.res.json`);
console.log('[bridge] 启动对局后, 决策请求将出现在 inbox。Ctrl+C 结束。');
if (AUTO_START) console.log(`[bridge] auto-start requested: mode=${AUTO_MODE}; 等待 Player 智能体处理请求。`);

// 保持进程存活
process.stdin.resume();
