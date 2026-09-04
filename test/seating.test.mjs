import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTeamSequence, deriveDraftPickOrder, normalizeTeamSequence, seatingSnapshot, teamSequenceForMode, TEAM_SEQUENCE_PATTERNS } from '../rules/seating.mjs';

test('team sequence preserves official 4/6-seat patterns and distinguishes custom layouts', () => {
  assert.deepEqual(normalizeTeamSequence(TEAM_SEQUENCE_PATTERNS[4].CM, 4), [true, false, false, true]);
  assert.equal(classifyTeamSequence([true, false, false, true]), 'CM');
  assert.equal(classifyTeamSequence([true, false, false, true, true, false]), 'CM');
  assert.equal(classifyTeamSequence([true, true, true, false, false, true]), 'custom_or_random');
  assert.equal(normalizeTeamSequence([true, null], 2), null);
});

test('seating snapshot separates physical seats, side assignment, first actor and turn order', () => {
  const snapshot = seatingSnapshot({
    players: [
      { seat: 3, playerid: 'p3', side: false, name: '蓝三' },
      { seat: 1, playerid: 'p1', side: true, name: '红一' },
      { seat: 4, playerid: 'p4', side: true, name: '红四' },
      { seat: 2, playerid: 'p2', side: false, name: '蓝二' },
    ],
    firstAct: { seat: 2, playerid: 'p2' },
    teamSequence: [true, false, false, true],
    bpPickOrder: ['p2', 'p1'],
  });
  assert.deepEqual(snapshot.seat_order, [1, 2, 3, 4]);
  assert.equal(snapshot.first_act_seat, 2);
  assert.deepEqual(snapshot.turn_order_from_first_act, [2, 3, 4, 1]);
  assert.deepEqual(snapshot.next_by_seat, { 1: 2, 2: 3, 3: 4, 4: 1 });
  assert.equal(snapshot.team_sequence_kind, 'CM');
  assert.equal(snapshot.invariants.balanced_sides, true);
  assert.deepEqual(snapshot.bp_pick_order, ['p2', 'p1']);
});

test('seating snapshot does not invent seat order when seats are missing or duplicated', () => {
  const snapshot = seatingSnapshot({ players: [{ side: true }, { seat: 1, side: false }, { seat: 1, side: true }] });
  assert.deepEqual(snapshot.seat_order, []);
  assert.equal(snapshot.invariants.explicit_unique_seats, false);
  assert.deepEqual(snapshot.turn_order_from_first_act, []);
});

test('mode mapping and BP pick order follow inspected xingBei.js branches', () => {
  assert.equal(teamSequenceForMode({ playerCount: 8, chooseMode: 'BP01', configured: 'near' }), 'random');
  assert.equal(teamSequenceForMode({ playerCount: 6, chooseMode: 'CM02', configured: 'near' }), 'CM');
  const players = [
    { seat: 1, playerid: 'r1', side: true }, { seat: 2, playerid: 'b1', side: false },
    { seat: 3, playerid: 'r2', side: true }, { seat: 4, playerid: 'b2', side: false },
  ];
  assert.deepEqual(deriveDraftPickOrder({ players, firstAct: { seat: 1 }, chooseMode: 'BP01' }).map(row => row.playerid), ['r1', 'b1', 'r2', 'b2']);
  assert.deepEqual(deriveDraftPickOrder({ players, firstAct: { seat: 1 }, chooseMode: 'BP02' }).map(row => row.playerid), ['r1', 'b1', 'b2', 'r2']);
  assert.equal(deriveDraftPickOrder({ players, firstAct: { seat: 1 }, chooseMode: 'CM01' }), null);
});
