// 座次/顺位规范层（纯函数）。
//
// 引擎里的 `game.players` 是环形链表，且在换位、自由选边、阶段交换后
// 可能改变遍历起点。AI 不能把数组下标误当成座位或行动顺序；本模块只
// 接受已经观测到的公开座位、阵营、首行动者和团队序列，并输出稳定的
// 可审计关系。未知值保持 null，不根据“常见桌位”臆造规则。

export const SEATING_SCHEMA = 'seating.v1';

export const TEAM_SEQUENCE_PATTERNS = Object.freeze({
  4: Object.freeze({
    CM: Object.freeze([true, false, false, true]),
    near: Object.freeze([true, true, false, false]),
    crossed: Object.freeze([true, false, true, false]),
    BP: Object.freeze([true, false, true, false]),
  }),
  6: Object.freeze({
    CM: Object.freeze([true, false, false, true, true, false]),
    near: Object.freeze([true, true, true, false, false, false]),
    crossed: Object.freeze([true, false, true, false, true, false]),
    BP: Object.freeze([true, false, false, true, false, true]),
  }),
});

function normalizeSide(value) {
  if (value === true || value === 'red' || value === 'true') return 'red';
  if (value === false || value === 'blue' || value === 'false') return 'blue';
  return null;
}

function normalizeSeat(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function normalizeTeamSequence(sequence, expectedLength = null) {
  if (!Array.isArray(sequence)) return null;
  if (expectedLength != null && sequence.length !== expectedLength) return null;
  const normalized = sequence.map(value => {
    if (value === true || value === false) return value;
    if (value === 'true' || value === 'red' || value === 1 || value === '1') return true;
    if (value === 'false' || value === 'blue' || value === 0 || value === '0') return false;
    return null;
  });
  return normalized.every(value => value !== null) ? normalized : null;
}

export function classifyTeamSequence(sequence) {
  const normalized = normalizeTeamSequence(sequence);
  if (!normalized) return 'invalid';
  const patterns = TEAM_SEQUENCE_PATTERNS[normalized.length] || {};
  for (const [name, expected] of Object.entries(patterns)) {
    if (expected.length === normalized.length && expected.every((value, index) => value === normalized[index])) return name;
  }
  return 'custom_or_random';
}

export function teamSequenceForMode({ playerCount, chooseMode = null, configured = null } = {}) {
  const mode = String(chooseMode || '').toUpperCase();
  if (Number(playerCount) === 8) return 'random';
  if (mode === 'CM01' || mode === 'CM02') return 'CM';
  if (mode === 'BP01' || mode === 'BP02') return 'BP';
  return configured == null ? null : String(configured);
}

function sameActor(left, right) {
  if (left == null || right == null) return false;
  if (typeof left !== 'object' && typeof right !== 'object') return String(left) === String(right);
  const leftSeat = normalizeSeat(left?.seat ?? left?.seatNum ?? left?.dataset?.position);
  const rightSeat = normalizeSeat(right?.seat ?? right?.seatNum ?? right?.dataset?.position);
  if (leftSeat != null && rightSeat != null) return leftSeat === rightSeat;
  const leftId = left?.playerid ?? left?.id;
  const rightId = right?.playerid ?? right?.id;
  return leftId != null && rightId != null && String(leftId) === String(rightId);
}

function playerRecord(player, index) {
  const seat = normalizeSeat(player?.seat ?? player?.seatNum ?? player?.dataset?.position ?? player?.position ?? (typeof player === 'number' || typeof player === 'string' ? player : null));
  return {
    seat,
    engine_seat_num: normalizeSeat(player?.engine_seat_num ?? player?.seatNum),
    side: normalizeSide(player?.side ?? player?.team),
    playerid: player?.playerid ?? player?.id ?? null,
    actor: player?.actor ?? player?.name1 ?? player?.name ?? null,
    source_index: index,
  };
}

/**
 * BP 选将顺序 as implemented by xingBei.js. `players` must be the current
 * ring order and `firstAct` must identify a member of that ring. Only BP01/02
 * have a deterministic pick list in the inspected source; other modes return
 * null instead of pretending that CM/random is the same draft.
 */
export function deriveDraftPickOrder({ players = [], firstAct = null, chooseMode = null } = {}) {
  const mode = String(chooseMode || '').toUpperCase();
  if (mode !== 'BP01' && mode !== 'BP02') return null;
  const records = (Array.isArray(players) ? players : []).map(playerRecord);
  if (!records.length) return null;
  let firstIndex = records.findIndex(record => sameActor(record, firstAct));
  if (firstIndex < 0) {
    const seat = normalizeSeat(firstAct?.seat ?? firstAct?.seatNum ?? firstAct);
    firstIndex = records.findIndex(record => record.seat === seat);
  }
  if (firstIndex < 0) return null;
  const ring = records.slice(firstIndex).concat(records.slice(0, firstIndex));
  const red = ring.filter(record => record.side === 'red');
  const blue = ring.filter(record => record.side === 'blue');
  if (red.length !== blue.length || !red.length) return null;
  const order = [];
  const push = record => order.push({ seat: record.seat, playerid: record.playerid, actor: record.actor, side: record.side });
  if (mode === 'BP01') {
    for (let index = 0; index < red.length; index++) { push(red[index]); push(blue[index]); }
  } else {
    // xingBei.js inserts blue[index] before red[index] after the first pair.
    push(red[0]); push(blue[0]);
    for (let index = 1; index < red.length; index++) { if (blue[index]) push(blue[index]); if (red[index]) push(red[index]); }
  }
  return order;
}

/**
 * Build a public seating snapshot. `players` must be in the engine's current
 * ring order; the returned `seat_order` is sorted by explicit seat number and
 * never silently substitutes array indexes when a seat is missing.
 */
export function seatingSnapshot({ players = [], firstAct = null, teamSequence = null, bpPickOrder = null } = {}) {
  const records = (Array.isArray(players) ? players : []).map(playerRecord);
  const withSeat = records.filter(player => player.seat != null).sort((a, b) => a.seat - b.seat || a.source_index - b.source_index);
  const seats = withSeat.map(player => player.seat);
  const uniqueSeats = new Set(seats).size === seats.length;
  const validSeatOrder = uniqueSeats && seats.length === records.length;
  const firstActSeat = withSeat.find(player => sameActor(player, firstAct))?.seat ?? normalizeSeat(firstAct?.seat ?? firstAct?.seatNum ?? firstAct);
  const turnOrder = firstActSeat == null || !validSeatOrder ? [] : seats.slice(seats.indexOf(firstActSeat)).concat(seats.slice(0, seats.indexOf(firstActSeat)));
  const nextBySeat = {};
  const previousBySeat = {};
  if (validSeatOrder && seats.length) seats.forEach((seat, index) => {
    nextBySeat[String(seat)] = seats[(index + 1) % seats.length];
    previousBySeat[String(seat)] = seats[(index - 1 + seats.length) % seats.length];
  });
  const normalizedSequence = normalizeTeamSequence(teamSequence, seats.length || null);
  const sequenceKind = normalizedSequence ? classifyTeamSequence(normalizedSequence) : null;
  const sideBySeat = Object.fromEntries(withSeat.filter(player => player.seat != null).map(player => [String(player.seat), player.side]));
  const redCount = withSeat.filter(player => player.side === 'red').length;
  const blueCount = withSeat.filter(player => player.side === 'blue').length;
  return {
    schema_version: SEATING_SCHEMA,
    seat_order: validSeatOrder ? seats : [],
    players: withSeat.map(({ source_index, ...player }) => player),
    side_by_seat: sideBySeat,
    first_act: firstAct == null ? null : playerRecord(firstAct, -1),
    first_act_seat: firstActSeat ?? null,
    turn_order_from_first_act: turnOrder,
    next_by_seat: nextBySeat,
    previous_by_seat: previousBySeat,
    team_sequence: normalizedSequence,
    team_sequence_kind: sequenceKind,
    bp_pick_order: Array.isArray(bpPickOrder) ? bpPickOrder.slice() : null,
    invariants: {
      seat_count: records.length,
      explicit_unique_seats: validSeatOrder,
      balanced_sides: redCount > 0 && redCount === blueCount,
      red_count: redCount,
      blue_count: blueCount,
    },
  };
}
