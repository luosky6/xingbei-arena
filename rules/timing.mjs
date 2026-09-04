// 规范时间轴的最小、无引擎依赖表达。
// 这里只冻结顺序与同一时点的座次 tie-break，不把某个源码事件名
// 自动提升为规范时点；具体 event-name 映射必须由版本化时间轴资料裁定。

export const TIMING_STAGES = Object.freeze([
  Object.freeze({ id: '①', name: '发动前/发动时', order: 1 }),
  Object.freeze({ id: '②', name: '命中判定', order: 2 }),
  Object.freeze({ id: '③', name: '造成伤害', order: 3 }),
  Object.freeze({ id: '④', name: '治疗响应', order: 4 }),
  Object.freeze({ id: '⑤', name: '实际产生伤害', order: 5 }),
  Object.freeze({ id: '⑥', name: '实际承受伤害', order: 6 }),
]);

const INDEX = new Map(TIMING_STAGES.map(stage => [stage.id, stage.order]));

export function timingIndex(stage) {
  const index = INDEX.get(String(stage));
  if (!index) throw new RangeError(`unknown timing stage: ${stage}`);
  return index;
}

export function compareTiming(a, b) {
  return timingIndex(a) - timingIndex(b);
}

/**
 * 对同一时点的插入效果做稳定排序：先按规范时点，再按调用方提供的
 * seatOrder（从当前行动者开始），最后保留输入顺序，避免隐式猜测。
 */
export function orderTimingItems(items, { seatOrder = [] } = {}) {
  const seatIndex = new Map(seatOrder.map((seat, index) => [String(seat), index]));
  return [...items].map((item, index) => ({ item, index })).sort((left, right) => {
    const stage = compareTiming(left.item.stage, right.item.stage);
    if (stage) return stage;
    const leftSeat = seatIndex.get(String(left.item.seat));
    const rightSeat = seatIndex.get(String(right.item.seat));
    if (leftSeat != null && rightSeat != null && leftSeat !== rightSeat) return leftSeat - rightSeat;
    if (leftSeat != null && rightSeat == null) return -1;
    if (leftSeat == null && rightSeat != null) return 1;
    return left.index - right.index;
  }).map(entry => entry.item);
}
