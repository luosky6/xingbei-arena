// Deterministic static inventory for the engine knowledge layer.
// This intentionally reports hypotheses and parse failures instead of
// pretending that source text is a complete or normative rulebook.
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEngineRoot, engineFingerprint } from '../bridge/engine.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const arenaRoot = resolve(here, '..');
const engineRoot = resolveEngineRoot();
const generatedRoot = join(here, 'generated');
const reportsRoot = join(here, 'reports');
const schemaVersion = 'knowledge.v1';
// Keep generated JSON byte-for-byte stable.  CI may opt into a timestamp with
// XB_GENERATED_AT, but ordinary regeneration must not create artificial drift.
const now = process.env.XB_GENERATED_AT || '2026-09-03T00:00:00.000+08:00';

const posix = p => p.split('\\').join('/');
const sourceRef = (file, line, locator, hash) => ({ source_id: 'engine', file: posix(file), line: line ?? null, locator: locator ?? null, sha256: hash ?? null });
const lineAt = (text, index) => text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
const hash = data => createHash('sha256').update(data).digest('hex');

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'image' || entry.name === 'audio' || entry.name === 'font' || entry.name === 'theme') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (['.js', '.mjs', '.ts'].includes(extname(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function skipQuoted(text, i) {
  const quote = text[i];
  if (quote === '`') {
    for (let j = i + 1; j < text.length; j++) { if (text[j] === '\\') { j++; continue; } if (text[j] === '`') return j; }
    return text.length - 1;
  }
  for (let j = i + 1; j < text.length; j++) { if (text[j] === '\\') { j++; continue; } if (text[j] === quote) return j; }
  return text.length - 1;
}

function matchingBrace(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i + 2); i = n < 0 ? text.length : n; continue; }
    if (ch === '/' && text[i + 1] === '*') { const n = text.indexOf('*/', i + 2); i = n < 0 ? text.length : n + 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

function topLevelKeys(text, open) {
  const end = matchingBrace(text, open);
  if (end < 0) return { keys: [], end, parseError: 'unclosed object' };
  const keys = [];
  let depth = 1;
  for (let i = open + 1; i < end; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') { i = skipQuoted(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') { const n = text.indexOf('\n', i + 2); i = n < 0 ? end : n; continue; }
    if (ch === '/' && text[i + 1] === '*') { const n = text.indexOf('*/', i + 2); i = n < 0 ? end : n + 1; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; continue; }
    if (depth !== 1 || !/[A-Za-z_$]/.test(ch)) continue;
    const m = text.slice(i).match(/^([A-Za-z_$][\w$]*)\s*:/);
    if (m) { keys.push({ key: m[1], index: i, valueStart: i + m[0].length }); i += m[0].length - 1; }
  }
  return { keys, end };
}

function firstLine(text, pattern) {
  const m = text.match(pattern);
  return m ? lineAt(text, m.index) : null;
}

function strings(text) { return [...text.matchAll(/["'`]([A-Za-z_$][\w$-]*)["'`]/g)].map(m => m[1]); }
function translatedInfo(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&');
  const re = new RegExp('(?:^|\\n)\\s*' + escaped + '_info\\s*:\\s*(["\\\'])([\\s\\S]*?)\\1\\s*,?', 'm');
  return text.match(re)?.[2] || null;
}
function tags(text) {
  const rules = [
    ['damage', /伤害|攻击|法术伤害|damage|gongJi|faShu/], ['heal', /治疗|回复|zhiLiao|heal/],
    ['draw', /摸牌|抽牌|draw/], ['discard', /弃牌|丢弃|discard/], ['shiqi', /士气|shiQi/],
    ['cup', /星杯|xingBei/], ['gem', /星石|宝石|gem/], ['crystal', /水晶|crystal/],
    ['energy', /能量|energy/], ['extra_action', /额外行动|extraXingDong|addGongJiOrFaShu/],
    ['control', /控制|横置|封印|虚弱|中毒|control/], ['defense', /防御|护盾|圣盾|免疫|defense/],
    ['pierce', /穿透|无视防御|必中|pierce/], ['position', /座位|顺位|相邻|最近|position|nextSeat/],
    ['conversion', /转化|转换|元素|命格|convert/], ['aoe', /所有|每名|范围|全体|aoe/],
  ];
  return rules.filter(([, re]) => re.test(text)).map(([name]) => name);
}

const files = await walk(engineRoot);
const fileData = new Map();
for (const file of files) {
  const data = await readFile(file, 'utf8').catch(() => null);
  if (data !== null) fileData.set(file, { text: data, sha: hash(data), rel: posix(relative(engineRoot, file)) });
}
const fail = [];
const packs = new Map(), characters = new Map(), skills = new Map(), cards = new Map(), events = new Map(), timings = new Map();
function add(map, id, value) {
  if (!map.has(id)) map.set(id, value);
  else {
    const existing = map.get(id);
    existing.source_refs = [...existing.source_refs, ...(value.source_refs || [])];
    if (value.character_ids) existing.character_ids = [...new Set([...(existing.character_ids || []), ...value.character_ids])];
  }
}
function eventFor(name) {
  if (!events.has(name)) events.set(name, { schema_version: schemaVersion, id: `event:${name}`, kind: 'event', name, source_tier: 'engine_implementation', provenance: [], source_refs: [], occurrences: 0, kinds: [], parent_relations: [], key_fields: [], dynamic_test_ids: [], applicable_versions: ['engine-source'], adjudication_status: 'needs_dynamic_test' });
  return events.get(name);
}
function addEvent(name, kind, file, line, snippet) {
  if (!name) return;
  const e = eventFor(name); const ref = sourceRef(fileData.get(file).rel, line, kind, fileData.get(file).sha);
  e.occurrences++; if (!e.kinds.includes(kind)) e.kinds.push(kind); e.source_refs.push(ref); e.provenance.push(ref);
  e.parent_relations.push({ relation: kind === 'createEvent' ? 'current_event_runtime_parent' : kind === 'event.trigger' ? 'current_event_trigger' : 'unknown_static_parent', status: 'hypothesis', source_ref: ref });
  for (const field of snippet.matchAll(/(?:event|trigger)\.([A-Za-z_$][\w$]*)/g)) if (!e.key_fields.includes(field[1])) e.key_fields.push(field[1]);
}

for (const [file, item] of fileData) {
  const { text, rel, sha } = item;
  const importRe = /game\.import\(\s*(["'])([^"']+)\1\s*,/g;
  for (const m of text.matchAll(importRe)) {
    const windowText = text.slice(m.index, m.index + 5000);
    const packName = windowText.match(/\bname\s*:\s*(["'])([^"']+)\1/)?.[2];
    if (packName) add(packs, `${m[2]}:${packName}`, { schema_version: schemaVersion, id: `pack:${packName}`, kind: 'pack', name: packName, pack_type: m[2], source_tier: 'engine_implementation', provenance: [sourceRef(rel, lineAt(text, m.index), 'game.import', sha)], source_refs: [sourceRef(rel, lineAt(text, m.index), 'game.import', sha)], applicable_versions: ['engine-source'], adjudication_status: 'needs_dynamic_test' });
  }

  if (rel.startsWith('character/')) {
    const charRe = /^\s{2,}([A-Za-z_$][\w$]*)\s*:\s*\[\s*(["'])([^"']+)\2\s*,\s*(["'])([^"']+)\4\s*,\s*([^,]+),\s*\[([^\]]*)\]/gm;
    for (const m of text.matchAll(charRe)) {
      const id = m[1]; const skillIds = [...m[7].matchAll(/["']([A-Za-z_$][\w$]*)["']/g)].map(x => x[1]);
      const ref = sourceRef(rel, lineAt(text, m.index), 'character declaration', sha);
      add(characters, id, { schema_version: schemaVersion, id: `character:${id}`, kind: 'character', name_key: m[3], group: m[5], rank: m[6].trim(), skill_ids: skillIds, source_tier: 'engine_implementation', provenance: [ref], source_refs: [ref], applicable_versions: ['engine-source'], semantic_status: 'hypothesis', semantic: { tags: [], role_vector: {}, evidence: 'static source text only' }, adjudication_status: 'hypothesis' });
    }
    const regionRe = /\b(?:skill|pack_skills)\s*[:=]\s*\{/g;
    for (const m of text.matchAll(regionRe)) {
      const open = text.indexOf('{', m.index); const region = topLevelKeys(text, open);
      if (region.end < 0) { fail.push({ kind: 'unclosed_skill_object', file: rel, line: lineAt(text, m.index), locator: 'skill/pack_skills' }); continue; }
      for (const key of region.keys) {
        const valueOpen = text.indexOf('{', key.valueStart);
        const hasObject = valueOpen >= 0 && valueOpen < region.end && text.slice(key.valueStart, valueOpen).trim() === '';
        const blockEnd = hasObject ? matchingBrace(text, valueOpen) : -1;
        const block = blockEnd >= 0 ? text.slice(valueOpen, blockEnd + 1) : text.slice(key.valueStart, Math.min(key.valueStart + 500, region.end));
        const ref = sourceRef(rel, lineAt(text, key.index), 'skill declaration', sha);
        const props = hasObject ? topLevelKeys(text, valueOpen).keys.map(x => x.key) : [];
        const skill = { schema_version: schemaVersion, id: `skill:${key.key}`, kind: 'skill', name: key.key, source_tier: 'engine_implementation', provenance: [ref], source_refs: [ref], trigger: [...block.matchAll(/trigger\s*:\s*([\s\S]{0,400}?)(?:,\s*(?:filter|enable|usable|content|cost|check|ai)\s*:)/g)].map(x => x[1].replace(/\s+/g, ' ').trim()), trigger_events: [...block.matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)].map(x => x[1]).filter(x => /phase|damage|gong|faShu|shiQi|xingBei|zhiLiao|qiDong|teShu|gameStart|After|Before|End|Begin/i.test(x)), properties: props, has_ai: /\bai\s*:/.test(block), has_description: !!translatedInfo(text, key.key), description: translatedInfo(text, key.key), semantic_status: 'hypothesis', semantic: { tags: tags(block + (translatedInfo(text, key.key) || '')), producer_consumer: 'hypothesis' }, adjudication_status: 'hypothesis', applicable_versions: ['engine-source'] };
        add(skills, key.key, skill);
        for (const ev of skill.trigger_events) addEvent(ev, 'skill.trigger_literal', file, lineAt(text, key.index), block.slice(0, 1200));
      }
    }
    if (/\.\.\.|\[[^\]]+\]/.test(text.slice(0, 200000)) && /(?:character|skill|pack_)/.test(text)) fail.push({ kind: 'dynamic_or_spread_structure', file: rel, line: firstLine(text, /\.\.\.|\[[^\]]+\]/), locator: 'character/skill object', reason: 'computed keys or object spread require manual/runtime confirmation' });
  }

  if (rel.startsWith('card/')) {
    for (const m of text.matchAll(/\bcard\s*:\s*\{/g)) {
      const region = topLevelKeys(text, text.indexOf('{', m.index));
      if (region.end < 0) { fail.push({ kind: 'unclosed_card_object', file: rel, line: lineAt(text, m.index), locator: 'card' }); continue; }
      for (const key of region.keys) {
        const open = text.indexOf('{', key.valueStart); const end = open >= 0 && open < region.end ? matchingBrace(text, open) : -1;
        const block = end >= 0 ? text.slice(open, end + 1) : '';
        const ref = sourceRef(rel, lineAt(text, key.index), 'card declaration', sha);
        add(cards, key.key, { schema_version: schemaVersion, id: `card:${key.key}`, kind: 'card', name: key.key, type: block.match(/\btype\s*:\s*(["'])([^"']+)\1/)?.[2] || null, properties: end >= 0 ? topLevelKeys(text, open).keys.map(x => x.key) : [], description: block.match(/(?:cardPrompt|info)\s*:\s*(?:function\s*\([^)]*\)\s*\{[\s\S]{0,500}?return\s*["'`]([\s\S]*?)["'`]|["'`]([\s\S]*?)["'`])/)?.[1] || null, tags: tags(block), source_tier: 'engine_implementation', provenance: [ref], source_refs: [ref], applicable_versions: ['engine-source'], adjudication_status: 'needs_dynamic_test' });
      }
      break;
    }
  }

  for (const m of text.matchAll(/game\.createEvent\(\s*(["'])([^"']+)\1/g)) addEvent(m[2], 'createEvent', file, lineAt(text, m.index), text.slice(m.index, m.index + 1500));
  for (const m of text.matchAll(/\.setContent\(\s*(["'])([^"']+)\1/g)) addEvent(m[2], 'setContent', file, lineAt(text, m.index), text.slice(m.index, m.index + 1000));
  for (const m of text.matchAll(/(?:event|trigger)\.trigger\(\s*(["'])([^"']+)\1/g)) addEvent(m[2], 'event.trigger', file, lineAt(text, m.index), text.slice(Math.max(0, m.index - 500), m.index + 1000));
  for (const m of text.matchAll(/\btrigger\s*:\s*\{/g)) {
    const open = text.indexOf('{', m.index); const end = matchingBrace(text, open);
    if (end < 0) { fail.push({ kind: 'unclosed_trigger_map', file: rel, line: lineAt(text, m.index), locator: 'trigger' }); continue; }
    const body = text.slice(open + 1, end);
    for (const scope of body.matchAll(/\b(player|source|global|target)\s*:\s*(\[[^\]]*\]|["'][^"']+["'])/g)) {
      const names = [...scope[2].matchAll(/["']([A-Za-z_$][\w$]*)["']/g)].map(x => x[1]);
      for (const name of names) {
        const e = eventFor(name); const ref = sourceRef(rel, lineAt(text, m.index), `trigger.${scope[1]}`, sha);
        e.source_refs.push(ref); e.provenance.push(ref); e.occurrences++; if (!e.kinds.includes('trigger_map')) e.kinds.push('trigger_map');
        e.parent_relations.push({ relation: 'skill_trigger_map', owner: scope[1], status: 'hypothesis', source_ref: ref });
        if (!e.key_fields.includes(scope[1])) e.key_fields.push(scope[1]);
        add(timings, `${scope[1]}:${name}`, { schema_version: schemaVersion, id: `timing:${scope[1]}:${name}`, kind: 'timing', event: name, owner_scope: scope[1], source_tier: 'engine_implementation', provenance: [ref], source_refs: [ref], adjudication_status: 'hypothesis', semantic_status: 'hypothesis' });
      }
    }
  }
}

for (const c of characters.values()) {
  const text = `${c.name_key} ${c.group} ${c.skill_ids.join(' ')}`;
  const roleTags = new Set(c.skill_ids.flatMap(id => skills.get(id)?.semantic?.tags || []));
  c.semantic.tags = [...roleTags];
  c.semantic.role_vector = Object.fromEntries(['damage','heal','draw','discard','shiqi','cup','gem','crystal','energy','extra_action','control','defense','pierce','position','conversion','aoe'].map(k => [k, roleTags.has(k) ? 1 : 0]));
  c.semantic.evidence = 'static trigger/content/description keyword heuristic; hypothesis until dynamic evidence';
}
for (const s of skills.values()) {
  s.character_ids = [...characters.values()].filter(c => c.skill_ids.includes(s.name)).map(c => c.id.replace(/^character:/, ''));
}

const stageDefinitions = [
  ['①', 'attack declaration / before', ['shouDaoGongJi','gongJiShi','gongJiSheZhi','gongJiBefore']],
  ['②', 'hit or miss resolution', ['gongJiMingZhong','gongJiWeiMingZhong']],
  ['③', 'spell damage declaration', ['faShuDamage','zaoChengShangHai']],
  ['④', 'damage received before', ['chengShouShangHaiBefore']],
  ['⑤', 'damage resolution', ['chengShouShangHai']],
  ['⑥', 'damage received after', ['chengShouShangHaiAfter','shouDaoShangHaiAfter']],
].map(([stage, label, eventNames]) => ({ stage, label, event_names: eventNames, source_tier: 'difference', adjudication_status: 'hypothesis', note: '静态映射，需以说明书和运行时事件顺序验证', source_refs: eventNames.flatMap(name => events.get(name)?.source_refs || []) }));

const eventArray = [...events.values()].map(e => { e.source_refs = e.source_refs.filter((v, i, a) => i === a.findIndex(x => JSON.stringify(x) === JSON.stringify(v))); e.provenance = e.source_refs; e.key_fields.sort(); return e; }).sort((a,b) => a.name.localeCompare(b.name));
const timingArray = [...timings.values()].sort((a,b) => a.id.localeCompare(b.id));
const charArray = [...characters.values()].sort((a,b) => a.id.localeCompare(b.id));
const skillArray = [...skills.values()].sort((a,b) => a.id.localeCompare(b.id));
const cardArray = [...cards.values()].sort((a,b) => a.id.localeCompare(b.id));
const packArray = [...packs.values()].sort((a,b) => a.id.localeCompare(b.id));

const sourceDocs = [
  { source_id: 'xingbei-10th-anniversary-manual', source_tier: 'normative_rule', path: '../星杯十周年说明书.pdf', pdf_print_pages: ['00-21'], role: '十周年核心规范规则', status: 'provided-local-source', sha256: '5F525E5F691915EAF756383D8E02EE768CB64D6822FE3DF34C6B43FAA5517779' },
  { source_id: 'official-qa-and-supplements', source_tier: 'normative_rule', url: 'https://drive.google.com/drive/folders/1tFEuqt2cjeSkfuYKv7MD9_H2DLI-S8dV?usp=sharing', discovered_from: 'xingbei-10th-anniversary-manual:print-page-20', role: '官方 Q&A、二扩规则、结算时间轴、技能表、改动表与星杯宇宙资料入口', status: 'official-supplement-index' },
  { source_id: 'official-no-action-v25.4.5', source_tier: 'normative_rule', artifact_name: '星杯传说十周年二扩终末的无法行动 v25.4.5', parent_source_id: 'official-qa-and-supplements', role: '逐角色无法行动与恶意抹杀行动可能裁定', status: 'official-supplement-index' },
  { source_id: 'official-timeline-v25', source_tier: 'normative_rule', artifact_name: '十周年二扩用结算时间轴终末', parent_source_id: 'official-qa-and-supplements', role: '阶段顺序与伤害①~⑥结算顺序', status: 'official-supplement-index' },
  { source_id: 'official-skill-table-v25', source_tier: 'normative_rule', artifact_name: '星杯传说十周年至补完包技能表', parent_source_id: 'official-qa-and-supplements', role: '角色、技能、版本和技能类型索引', status: 'official-supplement-index' },
  { source_id: 'official-change-log', source_tier: 'normative_rule', artifact_name: '星杯历届改动', parent_source_id: 'official-qa-and-supplements', role: '版本差异与印刷/技能改动', status: 'official-supplement-index' },
  { source_id: 'official-universe-index', source_tier: 'normative_rule', artifact_name: '星杯宇宙', parent_source_id: 'official-qa-and-supplements', role: '角色包、版本和扩展宇宙索引', status: 'official-supplement-index' },
  { source_id: 'engine', source_tier: 'engine_implementation', path: posix(relative(arenaRoot, engineRoot)), role: '当前运行时实现', engine_fingerprint: await engineFingerprint(engineRoot) },
  { source_id: 'engine-docs', source_tier: 'engine_implementation', path: posix(relative(arenaRoot, join(engineRoot, 'docs'))), role: '开发说明/实现备注，不是规范规则', status: 'reference-only' },
];

const seating = { schema_version: 'seating.v1', kind: 'seating', source_tier: 'engine_implementation', adjudication_status: 'hypothesis', source_refs: [
  sourceRef('mode/xingBei.js', firstLine(fileData.get(resolve(engineRoot, 'mode/xingBei.js'))?.text || '', /_status\.firstAct/), '_status.firstAct'),
  sourceRef('mode/xingBei.js', firstLine(fileData.get(resolve(engineRoot, 'mode/xingBei.js'))?.text || '', /team_sequence/), 'team_sequence'),
  sourceRef('mode/xingBei.js', firstLine(fileData.get(resolve(engineRoot, 'mode/xingBei.js'))?.text || '', /chooseCharacterOLBP/), 'chooseCharacterOLBP'),
  sourceRef('noname/game/index.js', firstLine(fileData.get(resolve(engineRoot, 'noname/game/index.js'))?.text || '', /player\.next/), 'player.next'),
].filter(r => r.line), concepts: [
  { id: 'physical_seat', meaning: '公开物理座位/数据位置；用于顺位和前后座位关系', engine_fields: ['dataset.position'] },
  { id: 'engine_seat_index', meaning: '引擎内部 seatNum；不得与公开物理座位混用', engine_fields: ['seatNum'] },
  { id: 'side', meaning: '红蓝阵营', engine_fields: ['player.side'] },
  { id: 'first_act', meaning: '当前回合循环首行动者', engine_fields: ['_status.firstAct'] },
  { id: 'next_previous', meaning: '顺时针/引擎行动链链接', engine_fields: ['player.next','player.previous'] },
  { id: 'team_sequence', meaning: '队伍选角/行动编排序列', engine_fields: ['team_sequence'] },
  { id: 'bp_pick_order', meaning: 'BP 选角选择顺序，独立于最终座位', engine_fields: ['chooseCharacterOLBP','BP01','BP02'] },
], modes: [
  { id: 'two', players_per_side: 2, seat_order: 'engine prepareArena(4)', first_act: '_status.firstAct or random player', team_sequence: 'mode-dependent', bp_pick_order: 'BP01/BP02 when configured' },
  { id: 'three', players_per_side: 3, seat_order: 'engine prepareArena(6)', first_act: '_status.firstAct or random player', team_sequence: 'mode-dependent', bp_pick_order: 'BP01/BP02 when configured' },
  { id: 'four', players_per_side: 4, seat_order: 'engine prepareArena(8)', first_act: '_status.firstAct or random player', team_sequence: 'mode-dependent', bp_pick_order: 'BP01/BP02 when configured' },
] };

const ruleSeeds = [
  ['game.players_and_victory','08-09','人数、队伍与胜利线','mode/xingBei.js','game.over'], ['game.setup_and_order','10-11','准备、座次、首行动与选角顺位','mode/xingBei.js','_status.firstAct'], ['combat.attack','12','攻击与应战','card/xingBei.js','type:"gongJi"'], ['action.spell_and_special','13','法术与特殊行动','mode/xingBei.js','gouMai'], ['damage.morale','14','伤害、爆牌与士气','noname/game/index.js','changeShiQi'], ['resource.energy_heal_response','15','能量、治疗与响应','noname/library/element/player.js','zhiLiao'], ['resource.limits','16','启动与资源上限','noname/game/index.js','xingBeiMax'], ['skill.unique','17','独有技','character/shiZhouNian.js','pack_skills'], ['timing.attack_stages','18','伤害①~⑥时机','mode/xingBei.js','gongJiBefore'], ['effects.icons_and_overflow','19-20','图标、基础效果、重复响应、条件效果与溢出','card/xingBei.js','card definitions'],
].map(([id, pages, label, file, locator]) => ({ schema_version: schemaVersion, id: `rule:${id}`, kind: 'rule', source_tier: 'difference', label, normative_rule: { source_id: 'xingbei-10th-anniversary-manual', pdf_print_page: pages, pdf_page: Number(pages.split('-')[0]), status: 'source-registered; curated draft available', curated_file: 'knowledge/curated/rules/rule-ontology-draft.json', curated_rule_id: id }, engine_behavior: { source_id: 'engine', file, locator, status: 'static implementation reference' }, difference: { status: 'to_review', notes: '规范资料与当前引擎尚未完成逐条动态裁定' }, adjudication_status: 'needs_dynamic_test', provenance: [{ source_id: 'xingbei-10th-anniversary-manual', source_kind: 'normative_rule', pdf_print_page: pages, pdf_page: Number(pages.split('-')[0]) }, { source_id: 'engine', source_kind: 'engine_implementation', file, locator }], source_refs: [{ source_id: 'engine', file, locator }], dynamic_test_ids: [], applicable_versions: ['manual-10th-anniversary', 'engine-source'] }));

const synergy = [];
for (let i = 0; i < charArray.length; i++) for (let j = i + 1; j < charArray.length; j++) {
  const a = charArray[i], b = charArray[j]; const overlap = a.semantic.tags.filter(t => b.semantic.tags.includes(t));
  const complementary = [['damage','control'],['damage','extra_action'],['damage','defense'],['heal','damage'],['gem','energy'],['draw','discard'],['position','damage']].filter(([x,y]) => (a.semantic.tags.includes(x)&&b.semantic.tags.includes(y)) || (a.semantic.tags.includes(y)&&b.semantic.tags.includes(x))).map(([x,y]) => `${x}->${y}`);
  if (!overlap.length && !complementary.length) continue;
  synergy.push({ schema_version: schemaVersion, id: `synergy:${a.id.replace('character:','')}:${b.id.replace('character:','')}`, kind: 'synergy', characters: [a.id.replace('character:',''), b.id.replace('character:','')], mechanism: { shared_tags: overlap, complementary_tags: complementary }, source_tier: 'difference', adjudication_status: 'hypothesis', evidence: { source: 'static role-vector heuristic', samples: 0, dynamic_validation: 'required' }, source_refs: [...a.source_refs, ...b.source_refs] });
}

const coverage = { schema_version: schemaVersion, generated_at: now, engine_root: engineRoot, engine_fingerprint: sourceDocs.find(s => s.source_id === 'engine').engine_fingerprint, files_scanned: fileData.size, source_documents: sourceDocs, objects: { packs: { total: packArray.length, parsed: packArray.length }, characters: { total: charArray.length, parsed: charArray.length }, skills: { total: skillArray.length, parsed: skillArray.filter(s => s.properties.length || s.trigger_events.length).length, missing_description: skillArray.filter(s => !s.has_description).length, missing_ai: skillArray.filter(s => !s.has_ai).length }, cards: { total: cardArray.length, parsed: cardArray.length }, events: { total: eventArray.length, parsed: eventArray.length }, timings: { total: timingArray.length, parsed: timingArray.length }, synergies: { total: synergy.length, hypothesis: synergy.length } }, parse_failures: fail, docs_and_source_gaps: [{ id: 'manual-text-extraction', status: 'partial', source: '../星杯十周年说明书.pdf', note: '核心规则已进入 curated/rules/rule-ontology-draft.json；仍需逐条与引擎动态行为裁定。' }, { id: 'official-supplements', status: 'registered', source: 'official-qa-and-supplements', note: '官方 Q&A、无法行动专项、结算时间轴和技能表已登记；逐条编译待完成。' }, { id: 'engine-vs-manual', status: 'open', source: 'engine + manual', note: 'Do not promote engine behavior to normative truth without a curated adjudication.' }, { id: 'dynamic-computed-objects', status: fail.length ? 'open' : 'not_detected', note: 'Computed keys, spreads and dynamic registration require runtime confirmation.' }], static_conclusions: 'All role, skill, timing, seat and synergy semantics generated by this script are hypotheses until dynamic evidence is attached.' };

const outputs = { 'packs.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: packArray }, 'characters.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: charArray }, 'skills.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: skillArray }, 'cards.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: cardArray }, 'events.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: eventArray }, 'timings.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, stage_definitions: stageDefinitions, objects: timingArray }, 'seating.json': seating, 'rules.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: ruleSeeds }, 'synergies.json': { schema_version: schemaVersion, generated_at: now, engine_fingerprint: coverage.engine_fingerprint, objects: synergy }, 'sources.json': { schema_version: schemaVersion, generated_at: now, sources: sourceDocs }, 'coverage.json': coverage };

function stable(value) { return JSON.stringify(value, null, 2) + '\n'; }
await mkdir(generatedRoot, { recursive: true });
await mkdir(reportsRoot, { recursive: true });
const checkOnly = process.argv.includes('--check'); let drift = [];
for (const [name, value] of Object.entries(outputs)) {
  const target = join(generatedRoot, name); const rendered = stable(value); const old = await readFile(target, 'utf8').catch(() => null);
  if (checkOnly) { if (old !== rendered) drift.push(name); }
  else await writeFile(target, rendered);
}
const report = `# 规则来源、事件与覆盖报告\n\n生成时间：${now}\n\n- 引擎目录：\`${posix(relative(arenaRoot, engineRoot))}\`\n- 引擎指纹：\`${coverage.engine_fingerprint}\`\n- 扫描源码文件：${fileData.size}\n- 角色：${charArray.length}；技能：${skillArray.length}；卡牌：${cardArray.length}；事件：${eventArray.length}；触发映射：${timingArray.length}\n- 解析失败/待人工队列：${fail.length}\n- 组合候选：${synergy.length}（全部 hypothesis，尚无对局证据）\n\n## 来源治理\n\n规范规则来源是《星杯十周年说明书》（PDF 印刷页 00-21）；源码只记录当前 engine implementation。${coverage.docs_and_source_gaps.map(x => `\n- ${x.id}: ${x.status} — ${x.note}`).join('')}\n\n## 事件目录\n\n事件目录见 [events.json](../generated/events.json)。每项包含 createEvent/setContent/trigger map/event.trigger 来源、关键 event 字段和静态父子关系假设。静态父子关系不能替代运行时事件树。\n\n## 座次与顺位\n\n座位编号、红蓝阵营、firstAct、player.next/previous、team sequence 与 BP pick order 分别建模于 [seating.json](../generated/seating.json)，不能混用一个 seat 字段。\n\n## 解析失败队列\n\n${fail.length ? fail.map(x => `- ${x.kind} — ${x.file}:${x.line || '?'} (${x.locator || 'n/a'})`).join('\n') : '- 当前未检测到失败；仍应由运行时覆盖验证。'}\n`;
if (checkOnly) { if (drift.length) { console.error(`[knowledge] drift: ${drift.join(', ')}`); process.exitCode = 1; } else console.log('[knowledge] generated outputs are up to date'); }
else { await writeFile(join(reportsRoot, 'coverage.md'), report); console.log(`[knowledge] scanned ${fileData.size} files; characters=${charArray.length} skills=${skillArray.length} cards=${cardArray.length} events=${eventArray.length} failures=${fail.length}`); }
