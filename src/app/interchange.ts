import { Vector3 } from 'three';
import { anchorFromNode, type Anchor } from '../network/editing';
import { getClass } from '../network/classes';
import type { Network, NodeId } from '../network/network';
import type { Heightfield } from '../terrain/heightfield';
import { draw, smoothProfile, type Waypoint } from './sketch';

/**
 * 高速道路のインターチェンジ (ダイヤモンド型) を組み立てる。
 *
 * 本線を側道の上に通し、4 本のランプで結ぶ。左側通行なので、走行車線は
 * 本線の左側 = 進行方向から見て左手にあり、出入口もその側に付く。つまり
 *   ・東行き (+u) の出口は交差点の手前 (u < 0) の -v 側
 *   ・東行きの入口は交差点の先 (u > 0) の -v 側
 * となり、-v 側のランプ 2 本が東行き、+v 側の 2 本が西行きを受け持つ。
 * ランプの取り付く先は側道上の 1 つの交差点 (ランプ端末) にまとめる。
 *
 * 座標は「本線に沿う u・本線に直交する v」の局所系で組み立て、最後に
 * 中心と方位でワールドへ移す。
 */
export interface InterchangeOptions {
  /** 本線と側道の交点。 */
  center?: { x: number; z: number };
  /** 本線の方位 [rad] (+X 方向が 0)。 */
  angle?: number;
  /** 本線を側道より持ち上げる高さ [m]。 */
  clearance?: number;
  /** 本線を中心から前後に伸ばす長さ [m]。 */
  mainlineHalf?: number;
  /** 側道を中心から前後に伸ばす長さ [m]。 */
  arterialHalf?: number;
  /** 本線側でランプが分かれる位置 (中心からの距離 [m])。 */
  rampOffset?: number;
  /** 側道側のランプ端末の位置 (中心からの距離 [m])。 */
  terminalOffset?: number;
  /** 本線・側道の種別。 */
  mainlineClass?: string;
  arterialClass?: string;
  rampClass?: string;
}

export interface InterchangeResult {
  /** 本線側のランプ分岐点。 */
  rampNodes: NodeId[];
  /** 側道側のランプ端末。 */
  terminals: NodeId[];
}

export function buildInterchange(
  network: Network,
  field: Heightfield,
  options: InterchangeOptions = {},
): InterchangeResult {
  const center = options.center ?? { x: 0, z: 0 };
  const angle = options.angle ?? 0;
  const clearance = options.clearance ?? 9;
  const mainlineHalf = options.mainlineHalf ?? 400;
  const arterialHalf = options.arterialHalf ?? 300;
  const rampOffset = options.rampOffset ?? 150;
  const terminalOffset = options.terminalOffset ?? 130;
  const mainlineClass = options.mainlineClass ?? 'road_highway';
  const arterialClass = options.arterialClass ?? 'road_medium';
  const rampClass = options.rampClass ?? 'road_ramp';

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  /** 局所座標 (u = 本線方向、v = 本線に直交) をワールドへ。 */
  const at = (u: number, v: number): Waypoint => ({
    x: center.x + u * cos - v * sin,
    z: center.z + u * sin + v * cos,
  });

  // --- 側道。ランプ端末の位置には必ずノードを作る。
  const arterialV = spread(arterialHalf, terminalOffset, 85);
  const arterial = arterialV.map((v) => at(0, v));
  draw(network, field, arterialClass, smoothProfile(field, arterial, arterialClass, { passes: 5 }), {
    straight: true,
  });

  const nodeAt = (u: number, v: number): NodeId | null => {
    const p = at(u, v);
    const node = network.findNodeNear(new Vector3(p.x, 0, p.z), 6);
    return node ? node.id : null;
  };
  const heightAt = (u: number, v: number): number => {
    const p = at(u, v);
    const node = nodeAt(u, v);
    if (node !== null) return network.getNode(node).pos.y;
    return network.findSegmentNear(new Vector3(p.x, 0, p.z), 40)?.pos.y
      ?? field.baseHeightAt(p.x, p.z);
  };

  // --- 本線の高さ。
  //
  // ランプの分岐点は「両側の端末の平均 + 桁下高」に置く。地形が傾いて
  // いても本線と端末の高低差が桁下高のまま保たれるので、ランプの勾配が
  // 規格を超えない。中央は側道との交点なので、そこだけ実際の桁下高で置く。
  const terminalY = [-1, 1].map((side) => heightAt(0, side * terminalOffset));
  const junctionY = (terminalY[0] + terminalY[1]) / 2 + clearance;
  const drop = Math.max(...terminalY.map((y) => Math.abs(junctionY - y)));
  // 勾配が規格に収まる長さまで、分岐点を交差点から遠ざける。
  const reach = Math.max(
    rampOffset,
    Math.sqrt(
      Math.max(0, (drop / (getClass(rampClass).maxGrade * 0.8)) ** 2 - terminalOffset ** 2),
    ),
  );
  const rampAt = Math.min(reach, mainlineHalf - 120);

  const mainlineU = spread(mainlineHalf, rampAt, 120);
  const mainline = mainlineU.map((u) => at(u, 0));
  const fixed = [
    { index: mainlineU.indexOf(0), y: heightAt(0, 0) + clearance },
    { index: mainlineU.indexOf(rampAt), y: junctionY },
    { index: mainlineU.indexOf(-rampAt), y: junctionY },
  ].filter((f) => f.index >= 0);
  draw(
    network,
    field,
    mainlineClass,
    smoothProfile(field, mainline, mainlineClass, { passes: 8, lift: clearance, fixed }),
    { straight: true },
  );

  // --- ランプ。本線の分岐点から側道の端末へ、局所座標で形を決める。
  const result: InterchangeResult = { rampNodes: [], terminals: [] };
  for (const side of [-1, 1] as const) {
    // side = -1 の側 (本線の右手が +v なので、-v は +u 方向の走行車線) は
    // +u 方向を受け持つ。出口は交差点の手前、入口は先に付く。
    const exitFrom = side * rampAt;
    const entryTo = -side * rampAt;
    const terminal = nodeAt(0, side * terminalOffset);
    const exitNode = nodeAt(exitFrom, 0);
    const entryNode = nodeAt(entryTo, 0);
    if (terminal === null || exitNode === null || entryNode === null) continue;
    result.terminals.push(terminal);
    result.rampNodes.push(exitNode, entryNode);

    const shape: [number, number][] = [
      [0.63, 0.32],
      [0.23, 0.77],
      [0, 1],
    ];
    const path = (from: number, reverse: boolean): Waypoint[] => {
      const points = shape.map(([u, v]) => at(from * u, side * terminalOffset * v));
      const line = [at(from, 0), ...points];
      return reverse ? line.reverse() : line;
    };

    connectRamp(network, field, rampClass, path(exitFrom, false), exitNode, terminal);
    connectRamp(network, field, rampClass, path(entryTo, true), terminal, entryNode);
  }
  return result;
}

/**
 * ランプ 1 本を引く。両端は既存のノードに繋ぎ、高さは端から端へ
 * 距離に比例して振り分ける (規格勾配に収まる長さで設計している)。
 */
function connectRamp(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  from: NodeId,
  to: NodeId,
): void {
  const cls = getClass(classId);
  const start = network.nodes.get(from);
  const end = network.nodes.get(to);
  if (!start || !end) return;

  const spans: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    spans.push(
      spans[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z),
    );
  }
  const total = spans[spans.length - 1] || 1;
  const profiled = points.map((p, i) => ({
    ...p,
    y: start.pos.y + ((end.pos.y - start.pos.y) * spans[i]) / total,
  }));

  const startAnchor: Anchor = anchorFromNode(network, start, cls);
  const endAnchor: Anchor = { pos: end.pos.clone(), node: end.id };
  draw(network, field, classId, profiled, { start: startAnchor, end: endAnchor });
}

/**
 * 0 から `half` まで、`key` を必ず含む対称な経由点の並び。
 * 短すぎる区間ができないよう、`key` に近すぎる点は落とす。
 */
function spread(half: number, key: number, step: number): number[] {
  const values = new Set<number>([0, key, -key, half, -half]);
  for (let v = step; v < half; v += step) {
    values.add(v);
    values.add(-v);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    const keep = v === 0 || Math.abs(v) === key || Math.abs(v) === half;
    const near = out.length > 0 && v - out[out.length - 1] < step * 0.55;
    if (near && !keep) continue;
    // 直前の点が落とせるなら、そちらを落として重要な点を残す。
    if (near && keep && out.length > 1) out.pop();
    out.push(v);
  }
  return out;
}
