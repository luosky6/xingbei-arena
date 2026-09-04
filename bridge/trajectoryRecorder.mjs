// Runtime-only, public-API trajectory recorder.
//
// This file is intentionally injected from the arena page.  It does not
// import or edit the engine checkout.  The engine already exposes
// game.createEvent and GameEvent lifecycle methods; wrapping those methods
// gives us a stable event stream while leaving rule execution untouched.
// Only public/observable fields are serialized. Hidden card identities are
// redacted to counts for draw/gain/lose/shuffle-like events.

const INSTALL = function installTrajectory({ matchId, seed, mode, overlaySide, rulesProfile, rulesVersion, engineFingerprint, configHash, policyId } = {}) {
  // addInitScript runs before the engine's module import.  Keep a tiny
  // polling hook so a subsequent game.reload() is recorded as well.
  window.__xbTrajectoryInstaller = installTrajectory;
  if (!window.__nn?.lib?.element?.GameEvent) {
    if (!window.__xbTrajectoryInstallTimer) {
      window.__xbTrajectoryInstallTimer = setInterval(() => {
        if (window.__nn?.lib?.element?.GameEvent) {
          clearInterval(window.__xbTrajectoryInstallTimer);
          window.__xbTrajectoryInstallTimer = null;
          installTrajectory(window.__xbTrajectoryInstallMeta || {});
        }
      }, 100);
    }
    window.__xbTrajectoryInstallMeta = { matchId, seed, mode, overlaySide, rulesProfile, rulesVersion, engineFingerprint, configHash, policyId };
    return null;
  }
  const existing = window.__xbTrajectoryRegistry;
  if (existing?.state) {
    existing.state.match = { match_id: matchId ?? null, seed: seed ?? null, mode: mode ?? null, overlay_side: overlaySide ?? null, rules_profile: rulesProfile ?? null, rules_version: rulesVersion ?? null, engine_fingerprint: engineFingerprint ?? null, config_hash: configHash ?? null, policy_id: policyId ?? null };
    existing.install_count++;
    return existing.state.snapshot();
  }

  const registry = {
    eventIds: new WeakMap(),
    eventSeq: 0,
    install_count: 1,
    state: null,
  };
  const state = {
    schema_version: 'trajectory.v1',
    match: { match_id: matchId ?? null, seed: seed ?? null, mode: mode ?? null, overlay_side: overlaySide ?? null, rules_profile: rulesProfile ?? null, rules_version: rulesVersion ?? null, engine_fingerprint: engineFingerprint ?? null, config_hash: configHash ?? null, policy_id: policyId ?? null },
    records: [],
    actionOrder: [],
    dropped_count: 0,
    max_records: 120000,
    listeners: { event: [], api: [] },
    snapshot() {
      return {
        schema_version: this.schema_version,
        match: this.match,
        records: this.records.slice(),
        dropped_count: this.dropped_count,
        record_count: this.records.length,
        action_order_count: this.actionOrder.length,
        install_count: registry.install_count,
      };
    },
    on(kind, fn) {
      if (!this.listeners[kind] || typeof fn !== 'function') return () => {};
      this.listeners[kind].push(fn);
      return () => { this.listeners[kind] = this.listeners[kind].filter(item => item !== fn); };
    },
  };
  registry.state = state;
  window.__xbTrajectoryRegistry = registry;
  window.__xbTrajectory = state;

  const isObject = value => value && typeof value === 'object';
  const playerRef = value => {
    if (!isObject(value)) return value == null ? null : value;
    const side = value.side === true ? 'red' : value.side === false ? 'blue' : typeof value.side === 'string' ? value.side : null;
    return { seat: value.dataset?.position ?? value.seatNum ?? value.seat ?? null, playerid: value.playerid ?? null, actor: value.name1 || value.name || value.actor || null, side };
  };
  const cardRef = value => {
    if (!isObject(value)) return value == null ? null : value;
    return { name: value.name || value.viewAs || null, element: value.element || value.nature || null, fate: value.fate || null, virtual: !!value.isCard }; 
  };
  const valueRef = value => {
    if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 16).map(valueRef) };
    if (!isObject(value)) return value == null ? null : value;
    if (value.dataset?.position != null || value.playerid || value.name1 || value.side !== undefined) return playerRef(value);
    if (value.isCard || value.cardid || value.element || value.fate) return cardRef(value);
    return { type: value.constructor?.name || 'object', name: typeof value.name === 'string' ? value.name : null };
  };
  const privateValueRef = value => {
    if (Array.isArray(value)) return { count: value.length };
    if (!isObject(value)) return value == null ? null : value;
    if (value.dataset?.position != null || value.playerid || value.name1 || value.side !== undefined) return playerRef(value);
    if (value.isCard || value.cardid || value.element || value.fate) return { card: true, element: value.element || value.nature || null, fate: value.fate || null, virtual: !!value.isCard };
    return { type: value.constructor?.name || 'object' };
  };
  const apiArgRef = (name, value) => /^(draw|discard|gain|lose|showCards|viewCards|cardsGoto|replaceHandcards|wash|shuffle)/i.test(String(name || '')) ? privateValueRef(value) : valueRef(value);
  const eventId = event => {
    if (!isObject(event)) return null;
    if (!registry.eventIds.has(event)) registry.eventIds.set(event, `e${String(++registry.eventSeq).padStart(7, '0')}`);
    return registry.eventIds.get(event);
  };
  const hiddenCards = name => /^(draw|gain|lose|discard|cardsGoto|replaceHandcards|wash|shuffle|showCards|viewCards)/i.test(String(name || ''));
  const summarizeChoice = result => {
    if (!isObject(result)) return result == null ? null : result;
    const out = {};
    for (const key of ['bool', 'control', 'index', 'confirm', 'skill', 'name', 'num']) {
      if (result[key] !== undefined && (typeof result[key] !== 'object' || result[key] === null)) out[key] = result[key];
    }
    for (const key of ['cards', 'links', 'buttons', 'targets', 'players']) {
      if (Array.isArray(result[key])) {
        // Keep decision outcomes useful without turning a global trajectory
        // into a hidden-hand leak. Card identities are intentionally omitted;
        // public useCard events still carry the played card identity.
        out[`${key}_count`] = result[key].length;
        if (key === 'targets' || key === 'players') out[key] = result[key].slice(0, 16).map(playerRef);
      }
    }
    if (result.card) out.card = cardRef(result.card);
    return out;
  };
  const decisionOptions = (event, method) => {
    if (!isObject(event)) return { completeness: 'unknown', controls: [], targets: [], cards: { count: 0 }, buttons: { count: 0 } };
    const name = String(method || event.name || '');
    const actionMethod = /^(gongJiOrFaShu|gongJi|faShu|yingZhan|moDan|qiTa)$/i.test(name);
    const cardTargetMethod = name === 'chooseCardTarget';
    const moveMethod = name === 'chooseToMove';
    const out = { completeness: 'candidate_only', controls: [], targets: [], cards: { count: 0 }, buttons: { count: 0 }, selection: { min: 1, max: 1, ordered: false } };
    if (actionMethod) out.selection = { min: 1, max: 1, ordered: false };
    else if (cardTargetMethod) {
      const resolveSelector = value => {
        if (typeof value !== 'function') return value;
        try { return value.call(event, event.player, event); } catch { return 1; }
      };
      const rawCardSelect = resolveSelector(event.selectCard);
      const rawTargetSelect = resolveSelector(event.selectTarget);
      const cardSelect = Array.isArray(rawCardSelect) ? rawCardSelect : [rawCardSelect ?? 1, rawCardSelect ?? 1];
      const targetSelect = Array.isArray(rawTargetSelect) ? rawTargetSelect : [rawTargetSelect ?? 1, rawTargetSelect ?? 1];
      out.selection = { min: 1, max: 1, ordered: false, composition: 'atomic_card_target', card_min: Number(cardSelect[0]) || 0, card_max: Number(cardSelect[1] ?? cardSelect[0]) || 0, target_min: Number(targetSelect[0]) || 0, target_max: Number(targetSelect[1] ?? targetSelect[0]) || 0, multi_supported: Number(cardSelect[1] ?? cardSelect[0]) <= 1 && Number(targetSelect[1] ?? targetSelect[0]) <= 1 };
    }
    else if (moveMethod) out.selection = { min: 1, max: 1, ordered: false, composition: 'move_assignment', assignment_mode: 'keep_or_pairwise_swap' };
    else {
      const key = /Button/i.test(name) ? 'selectButton' : /Target|Player/i.test(name) ? 'selectTarget' : /Card|Discard|Move|Give|Use|Respond/i.test(name) ? 'selectCard' : null;
      let selector = key ? event[key] : null;
      if (typeof selector === 'function') {
        try { selector = selector.call(event, event.player, event); } catch { selector = 1; }
      }
      let min = 1, max = 1;
      if (Array.isArray(selector)) { min = Number(selector[0]); max = Number(selector[1] ?? selector[0]); }
      else if (Number.isFinite(Number(selector))) min = max = Number(selector);
      if (min < 0) min = 0;
      if (max < 0 || !Number.isFinite(max)) max = Number.MAX_SAFE_INTEGER;
      out.selection = { min: Math.max(0, Math.floor(min)), max: Math.max(Math.max(0, Math.floor(min)), Math.floor(max)), ordered: /Move|Give/i.test(name) || event.ordered === true };
    }
    if (Array.isArray(event.controls)) {
      out.controls = event.controls.slice(0, 64).map((label, index) => ({ id: `control#${index}`, index, label: String(label) }));
      out.completeness = 'complete';
    }
    const buttons = event.dialog?.buttons;
    if (Array.isArray(buttons)) {
      out.buttons = { count: buttons.length, items: buttons.slice(0, 64).map((button, index) => ({ id: `button#${index}`, index, link: valueRef(button?.link) })) };
      if (out.completeness !== 'complete') out.completeness = 'complete';
    }
    const actor = event.player;
    const liveGame = window.__nn?.game;
    if (actor && Array.isArray(liveGame?.players) && (/Target|Use|Respond|Give|PlayerCard/i.test(method || '') || actionMethod)) {
      const filter = typeof event.filterTarget === 'function' ? event.filterTarget : null;
      const targets = liveGame.players.filter(target => {
        if (!filter) return true;
        try { return filter(null, actor, target, event); } catch { return false; }
      });
      out.targets = targets.slice(0, 32).map((target, index) => ({ id: `target#${index}`, ...playerRef(target) }));
      if (filter) out.completeness = out.completeness === 'complete' ? 'complete' : 'complete';
    }
    if (actor && (/Card|Use|Respond|Discard|Give/i.test(method || '') || actionMethod)) {
      let cards = [];
      try { cards = typeof actor.getCards === 'function' ? actor.getCards(event.position || 'hs') || [] : []; } catch {}
      const filter = typeof event.filterCard === 'function' ? event.filterCard : null;
      let selectable = cards;
      if (filter) selectable = cards.filter(card => { try { return filter(card, actor, event); } catch { return false; } });
      out.cards = { count: selectable.length, hidden: true, ids: selectable.slice(0, 64).map((_, index) => `card#${index}`) };
      if (filter && out.completeness !== 'complete') out.completeness = 'complete';
    }
    if (actionMethod && actor) {
      const players = Array.isArray(liveGame?.players) ? liveGame.players : [];
      const cards = [];
      try {
        const raw = typeof actor.getCards === 'function' ? actor.getCards(event.position || 'hs') || [] : [];
        const filter = typeof event.filterCard === 'function' ? event.filterCard : null;
        raw.forEach(card => { if (!filter || (() => { try { return filter(card, actor, event); } catch { return false; } })()) cards.push(card); });
      } catch {}
      const actions = [];
      cards.forEach((card, cardIndex) => {
        const filterTarget = typeof event.filterTarget === 'function' ? event.filterTarget : null;
        const targets = players.filter(target => !filterTarget || (() => { try { return filterTarget(card, actor, target, event); } catch { return false; } })());
        let selectTarget = null;
        try { selectTarget = typeof event.selectTarget === 'function' ? event.selectTarget(card, actor) : event.selectTarget; } catch {}
        const minTargets = Array.isArray(selectTarget) ? Number(selectTarget[0]) : 1;
        if (targets.length && minTargets > 0) targets.slice(0, 32).forEach((target, targetIndex) => actions.push({ id: `use#${cardIndex}#${targetIndex}`, card_index: cardIndex, target: playerRef(target) }));
        else if (minTargets === 0) actions.push({ id: `use#${cardIndex}#none`, card_index: cardIndex, target: null });
      });
      out.actions = { count: actions.length, items: actions.slice(0, 128) };
      if (out.completeness !== 'complete') out.completeness = 'complete';
    }
    if (cardTargetMethod && actor) {
      const players = Array.isArray(liveGame?.players) ? liveGame.players : [];
      let cards = [];
      try {
        const raw = typeof actor.getCards === 'function' ? actor.getCards(event.position || 'hs') || [] : [];
        const filter = typeof event.filterCard === 'function' ? event.filterCard : null;
        cards = raw.filter(card => !filter || (() => { try { return filter(card, actor, event); } catch { return false; } })());
      } catch {}
      const pairs = [];
      cards.forEach((card, cardIndex) => {
        const filterTarget = typeof event.filterTarget === 'function' ? event.filterTarget : null;
        players.forEach((target, targetIndex) => {
          let legal = true;
          if (filterTarget) { try { legal = !!filterTarget(card, actor, target, event); } catch { legal = false; } }
          if (legal) pairs.push({ id: `cardtarget#${cardIndex}#${targetIndex}`, card_index: cardIndex, target: playerRef(target) });
        });
      });
      out.card_targets = { count: pairs.length, items: pairs.slice(0, 128) };
      if (out.completeness !== 'complete') out.completeness = 'complete';
    }
    if (moveMethod) {
      const zones = Array.isArray(event.list) ? event.list : [];
      const zoneSummary = zones.map((zone, index) => ({ index, label: String(zone?.[0] || `区域${index + 1}`), card_count: Array.isArray(zone?.[1]) ? zone[1].length : 0 }));
      const totalCards = zoneSummary.reduce((sum, zone) => sum + zone.card_count, 0);
      out.cards = { count: totalCards, hidden: true, ids: [] };
      out.move = { assignment_mode: 'keep_or_pairwise_swap', zone_count: zoneSummary.length, zones: zoneSummary, total_cards: totalCards, max_enumerated_cards: 8 };
      if (zoneSummary.length && totalCards <= 8 && typeof event.filterOk === 'function') out.completeness = 'complete';
    }
    return out;
  };
  const eventFields = (event, includeResult = false) => {
    if (!isObject(event)) return null;
    const out = { name: event.name || null, type: event.type || null, step: typeof event.step === 'number' ? event.step : null, skill: event.skill || null, triggername: event.triggername || null, player: playerRef(event.player), source: playerRef(event.source), target: playerRef(event.target), targets: Array.isArray(event.targets) ? event.targets.slice(0, 32).map(playerRef) : null, num: typeof event.num === 'number' ? event.num : null, damageNum: typeof event.damageNum === 'number' ? event.damageNum : null, original_num: typeof event.original_num === 'number' ? event.original_num : null, nature: event.nature || null, finished: event.finished === true };
    if (!hiddenCards(event.name)) {
      out.card = cardRef(event.card);
      out.cards_count = Array.isArray(event.cards) ? event.cards.length : null;
    } else {
      out.card = null;
      out.cards_count = Array.isArray(event.cards) ? event.cards.length : null;
      out.redacted = ['card', 'cards'];
    }
    if (event._trigger) out.trigger_event_id = eventId(event._trigger);
    if (event.parent) out.parent_event_id = eventId(event.parent);
    if (Array.isArray(event.next)) out.next_count = event.next.length;
    if (Array.isArray(event.choose_list)) out.draft_pick_order = event.choose_list.slice(0, 32).map(playerRef);
    if (Array.isArray(event.red_list)) out.draft_red_order = event.red_list.slice(0, 16).map(playerRef);
    if (Array.isArray(event.blue_list)) out.draft_blue_order = event.blue_list.slice(0, 16).map(playerRef);
    if (includeResult && /^(choose|yingZhan|respond|useCard)/i.test(String(event.name || ''))) {
      out.result = summarizeChoice(event.result);
    }
    return out;
  };
  const publicState = nn => {
    const game = nn?.game;
    if (!game) return null;
    const list = Array.isArray(game.players) ? game.players : (game.players && typeof game.players[Symbol.iterator] === 'function' ? Array.from(game.players) : []);
    // `dataset.position` is the public physical seat (1-based in this mode);
    // `seatNum` is an engine-internal index and is kept separate to avoid
    // shifting firstAct/next relations by one.
    const players = list.map((player, sourceIndex) => ({ player, sourceIndex, seat: Number.isInteger(Number(player?.dataset?.position)) ? Number(player.dataset.position) : Number.isInteger(player?.seatNum) ? player.seatNum : null, engine_seat_num: Number.isInteger(player?.seatNum) ? player.seatNum : null }));
    const explicitSeats = players.every(item => item.seat != null) && new Set(players.map(item => item.seat)).size === players.length;
    const ordered = players.slice().sort((left, right) => (left.seat ?? Number.MAX_SAFE_INTEGER) - (right.seat ?? Number.MAX_SAFE_INTEGER) || left.sourceIndex - right.sourceIndex);
    const seatOrder = explicitSeats ? ordered.map(item => item.seat) : [];
    const firstAct = nn._status?.firstAct || null;
    const firstActSeat = firstAct ? (Number.isInteger(Number(firstAct?.dataset?.position)) ? Number(firstAct.dataset.position) : Number.isInteger(firstAct?.seatNum) ? firstAct.seatNum : null) : null;
    const firstIndex = firstActSeat == null ? -1 : seatOrder.indexOf(firstActSeat);
    const turnOrder = firstIndex < 0 ? [] : seatOrder.slice(firstIndex).concat(seatOrder.slice(0, firstIndex));
    const nextBySeat = {}, previousBySeat = {};
    if (explicitSeats && seatOrder.length) seatOrder.forEach((seat, index) => {
      nextBySeat[String(seat)] = seatOrder[(index + 1) % seatOrder.length];
      previousBySeat[String(seat)] = seatOrder[(index - 1 + seatOrder.length) % seatOrder.length];
    });
    let teamSequence = null;
    try { teamSequence = typeof game.teamSequenceList === 'function' ? game.teamSequenceList() : null; } catch {}
    if (!list.length || !Array.isArray(teamSequence) || teamSequence.length !== list.length || !teamSequence.every(value => typeof value === 'boolean')) teamSequence = null;
    let draftEvent = nn._status?.event || null;
    let draftGuard = 0;
    while (draftEvent && draftGuard++ < 12 && !Array.isArray(draftEvent.choose_list) && !Array.isArray(draftEvent.red_list) && !Array.isArray(draftEvent.blue_list)) draftEvent = draftEvent.parent || null;
    const playerRefs = values => Array.isArray(values) ? values.slice(0, 32).map(playerRef) : null;
    const modeConfig = nn.lib?.config?.mode_config?.xingBei || {};
    const chooseMode = modeConfig.choose_mode ?? nn.lib?.configOL?.choose_mode ?? null;
    const configuredSequence = modeConfig.team_sequence ?? nn.lib?.configOL?.team_sequence ?? null;
    const sequencePatterns = {
      '4:CM': [true, false, false, true], '4:near': [true, true, false, false], '4:crossed': [true, false, true, false], '4:BP': [true, false, true, false],
      '6:CM': [true, false, false, true, true, false], '6:near': [true, true, true, false, false, false], '6:crossed': [true, false, true, false, true, false], '6:BP': [true, false, false, true, false, true],
    };
    const sequenceKind = teamSequence ? Object.entries(sequencePatterns).find(([, pattern]) => pattern.length === teamSequence.length && pattern.every((value, index) => value === teamSequence[index]))?.[0]?.split(':')[1] || 'custom_or_random' : null;
    const sideBySeat = Object.fromEntries(ordered.filter(item => item.seat != null).map(item => [String(item.seat), item.player?.side === true ? 'red' : item.player?.side === false ? 'blue' : null]));
    return {
      phase_number: typeof game.phaseNumber === 'number' ? game.phaseNumber : null,
      current_phase: playerRef(nn._status?.currentPhase),
      hong_shiqi: game.hongShiQi ?? null,
      lan_shiqi: game.lanShiQi ?? null,
      hong_xingbei: game.hongXingBei ?? null,
      lan_xingbei: game.lanXingBei ?? null,
      players: list.map(p => ({ ...playerRef(p), engine_seat_num: Number.isInteger(p?.seatNum) ? p.seatNum : null, hand_count: Array.isArray(p.getCards?.('h')) ? p.getCards('h').length : null, zhi_liao: p.zhiLiao ?? null, energy: p.energy ?? p.nengLiang ?? null })).slice(0, 16),
      seating: {
        schema_version: 'seating.v1',
        seat_order: seatOrder,
        side_by_seat: sideBySeat,
        engine_seat_num_by_seat: Object.fromEntries(ordered.filter(item => item.seat != null && item.engine_seat_num != null).map(item => [String(item.seat), item.engine_seat_num])),
        first_act: playerRef(firstAct),
        first_act_seat: firstActSeat,
        turn_order_from_first_act: turnOrder,
        next_by_seat: nextBySeat,
        previous_by_seat: previousBySeat,
        team_sequence: teamSequence,
        team_sequence_kind: sequenceKind,
        configured_team_sequence: configuredSequence,
        choose_mode: chooseMode,
        phase_swap: modeConfig.phaseswap ?? nn.lib?.configOL?.phaseswap ?? null,
        draft_pick_order: playerRefs(draftEvent?.choose_list),
        draft_red_order: playerRefs(draftEvent?.red_list),
        draft_blue_order: playerRefs(draftEvent?.blue_list),
        actual_action_order: state.actionOrder.slice(-256),
        actual_action_order_count: state.actionOrder.length,
        invariants: { seat_count: list.length, explicit_unique_seats: explicitSeats, red_count: ordered.filter(item => item.player?.side === true).length, blue_count: ordered.filter(item => item.player?.side === false).length },
      },
    };
  };
  const record = (kind, payload, hook = 'GameEvent') => {
    if (state.records.length >= state.max_records) { state.dropped_count++; return null; }
    const nn = window.__nn;
    const important = /^(phase|xingDong|gongJi|faShu|damage|changeShiQi|changeXingBei|zhiLiao|heCheng|gouMai|tiLian|choose)/i.test(payload?.event?.name || '');
    if (kind === 'event_start' && payload?.event?.name === 'phase' && payload?.event?.player) {
      let actor = playerRef(payload.event.player);
      // Some phase events are created before `dataset.position` is attached;
      // recover the public seat from the stable playerid without exposing any
      // private state.
      if (actor?.seat == null && actor?.playerid != null) {
        const roster = Array.isArray(nn?.game?.players) ? nn.game.players : (nn?.game?.players && typeof nn.game.players.length === 'number' ? Array.from(nn.game.players) : (nn?.game?.players && typeof nn.game.players[Symbol.iterator] === 'function' ? Array.from(nn.game.players) : []));
        const found = roster.find(player => String(player?.playerid) === String(actor.playerid));
        if (found) actor = playerRef(found);
      }
      state.actionOrder.push({ order: state.actionOrder.length + 1, phase_number: typeof nn?.game?.phaseNumber === 'number' ? nn.game.phaseNumber : null, event_id: payload.event_id || null, actor });
      if (state.actionOrder.length > 4096) state.actionOrder.splice(0, state.actionOrder.length - 4096);
    }
    const includeState = kind === 'api_call' || kind === 'decision_request' || (kind === 'event_finish' && important) || (state.records.length % 128 === 0);
    const item = {
      schema_version: state.schema_version,
      match_id: state.match.match_id,
      rules_version: state.match.rules_version,
      seq: state.records.length + state.dropped_count + 1,
      ts_ms: Date.now(),
      kind,
      hook,
      ...payload,
    };
    if (includeState) item.public_state = publicState(nn);
    state.records.push(item);
    const listeners = state.listeners[kind === 'api_call' ? 'api' : 'event'] || [];
    for (const fn of listeners) { try { fn(item); } catch {} }
    return item;
  };
  const eventPayload = (event, includeResult = false) => ({ event_id: eventId(event), event: eventFields(event, includeResult), parent_event_id: event?.parent ? eventId(event.parent) : null });
  const decisionArg = value => {
    if (typeof value === 'function') return { type: 'function' };
    if (Array.isArray(value)) return { count: value.length, items: value.slice(0, 12).map(decisionArg) };
    if (!isObject(value)) return value == null ? null : value;
    if (value.dataset?.position != null || value.playerid || value.name1 || value.side !== undefined) return playerRef(value);
    if (value.isCard || value.cardid || value.element || value.fate) return { card: true, element: value.element || value.nature || null, fate: value.fate || null, virtual: !!value.isCard };
    if (value.name && typeof value.name === 'string') return { name: value.name };
    return { type: value.constructor?.name || 'object' };
  };
  const wrapMethod = (object, name, handler) => {
    if (!object || typeof object[name] !== 'function' || object[name].__xbTrajectoryWrapped) return false;
    const original = object[name];
    function wrapped(...args) { return handler.call(this, original, args); }
    Object.defineProperty(wrapped, '__xbTrajectoryWrapped', { value: true });
    Object.defineProperty(wrapped, '__xbOriginal', { value: original });
    object[name] = wrapped;
    return true;
  };
  const installFor = nn => {
    const game = nn?.game;
    const proto = nn?.lib?.element?.GameEvent?.prototype;
    if (!game || !proto) return false;
    wrapMethod(game, 'createEvent', function (original, args) {
      const event = original.apply(this, args); record('event_create', { ...eventPayload(event), requested_name: args[0] ?? null, trigger_flag: args[1] ?? null, explicit_parent_id: args[2] ? eventId(args[2]) : null }); return event;
    });
    wrapMethod(proto, 'setContent', function (original, args) {
      const result = original.apply(this, args); record('event_set_content', { ...eventPayload(this), content_kind: typeof args[0], content_name: typeof args[0] === 'string' ? args[0] : null }); return result;
    });
    wrapMethod(proto, 'trigger', function (original, args) {
      record('event_trigger', { ...eventPayload(this), trigger_name: args[0] ?? null }); const result = original.apply(this, args); return result;
    });
    wrapMethod(proto, 'start', function (original, args) {
      record('event_start', { ...eventPayload(this) }); const result = original.apply(this, args); return result;
    });
    wrapMethod(proto, 'finish', function (original, args) {
      const result = original.apply(this, args); record('event_finish', { ...eventPayload(this, true) }); return result;
    });
    for (const name of ['changeShiQi', 'changeXingBei', 'over']) {
        wrapMethod(game, name, function (original, args) {
        const result = original.apply(this, args); record('api_call', { api: `game.${name}`, args: args.map(valueRef), result_event_id: eventId(result), result_kind: typeof result }); return result;
      });
    }
    const playerProto = nn?.lib?.element?.Player?.prototype;
    for (const name of ['damage', 'faShuDamage', 'changeShiQi', 'changeXingBei', 'addZhiLiao', 'addZhanJi', 'draw', 'discard', 'useCard', 'respond']) {
      wrapMethod(playerProto, name, function (original, args) {
        const result = original.apply(this, args); record('api_call', { api: `player.${name}`, actor: playerRef(this), args: args.map(value => apiArgRef(name, value)), result_event_id: eventId(result), result_kind: typeof result }); return result;
      });
    }
    for (const name of ['chooseToUse', 'chooseToRespond', 'chooseToDiscard', 'chooseToCompare', 'chooseButton', 'chooseButtonOL', 'chooseCard', 'chooseTarget', 'chooseCardTarget', 'chooseControl', 'chooseBool', 'choosePlayerCard', 'discardPlayerCard', 'gainPlayerCard', 'chooseToMove', 'chooseToGive', 'chooseUseTarget', 'gongJiOrFaShu', 'gongJi', 'faShu', 'yingZhan', 'moDan', 'qiTa']) {
      wrapMethod(playerProto, name, function (original, args) {
        const parent = nn?._status?.event;
        const result = original.apply(this, args);
        const payload = () => ({
          decision: { method: name, actor: playerRef(this), parent_event_id: eventId(parent), args: args.map(decisionArg), option_summary: decisionOptions(result, name) },
          result_event_id: eventId(result),
        });
        // Callers populate chooseToMove.list immediately after receiving the
        // event object. Defer one microtask so the recorder sees the actual
        // named zones instead of an empty placeholder.
        if (name === 'chooseToMove') Promise.resolve().then(() => record('decision_request', payload(), 'Player'));
        else record('decision_request', payload(), 'Player');
        return result;
      });
    }
    for (const name of ['addVideo', 'log']) {
      wrapMethod(game, name, function (original, args) {
        const result = original.apply(this, args);
        record('public_hook', { api: `game.${name}`, args: args.slice(0, 4).map(valueRef), result_kind: typeof result }, `game.${name}`);
        return result;
      });
    }
    return true;
  };
  window.__xbHooks = { onEvent: fn => state.on('event', fn), onApi: fn => state.on('api', fn), snapshot: () => state.snapshot(), schema_version: state.schema_version };
  installFor(window.__nn);
  return state.snapshot();
};

export async function installTrajectoryRecorder(page, metadata = {}) {
  // The next navigation is game.reload(), so register the same hook for the
  // fresh document before installing it in the current one.
  await page.addInitScript(INSTALL, metadata);
  // The engine may be completing its own startup reload at this point. Retry
  // only the transient execution-context error instead of losing the whole
  // match; addInitScript above guarantees the next document is still covered.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await page.evaluate(INSTALL, metadata);
      return;
    } catch (error) {
      if (!/Execution context was destroyed|navigation/i.test(String(error)) || attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

export async function readTrajectory(page) {
  return page.evaluate(() => window.__xbTrajectory?.snapshot?.() || { schema_version: 'trajectory.v1', records: [], record_count: 0, dropped_count: 0, missing: true });
}
