import { Vector3 } from 'three';
import { type Anchor } from '../network/editing';
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

  const { at, nodeAt, heightAt } = frameOf(network, field, center, angle);

  // --- 側道。ランプ端末の位置には必ずノードを作る。
  const arterialV = spread(arterialHalf, terminalOffset, 85);
  const arterial = arterialV.map((v) => at(0, v));
  draw(network, field, arterialClass, smoothProfile(field, arterial, arterialClass, { passes: 5 }), {
    straight: true,
  });

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
 * 本線に沿う局所座標 (u = 本線方向、v = 本線に直交) の枠。
 * インターチェンジの形は全てこの座標で組み立て、最後に中心と方位で
 * ワールドへ移す。
 */
function frameOf(
  network: Network,
  field: Heightfield,
  center: { x: number; z: number },
  angle: number,
): {
  at: (u: number, v: number) => Waypoint;
  nodeAt: (u: number, v: number) => NodeId | null;
  heightAt: (u: number, v: number) => number;
} {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const at = (u: number, v: number): Waypoint => ({
    x: center.x + u * cos - v * sin,
    z: center.z + u * sin + v * cos,
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
    return (
      network.findSegmentNear(new Vector3(p.x, 0, p.z), 40)?.pos.y ??
      field.baseHeightAt(p.x, p.z)
    );
  };
  return { at, nodeAt, heightAt };
}

/**
 * ランプ 1 本を引く。両端は既存のノードに繋ぎ、高さは端から端へ
 * 距離に比例して振り分ける (規格勾配に収まる長さで設計している)。
 * 経由点に高さが入っていれば、そちらを優先する (立体交差の桁下確保など)。
 */
function connectRamp(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  from: NodeId,
  to: NodeId,
): void {
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
    y: p.y ?? start.pos.y + ((end.pos.y - start.pos.y) * spans[i]) / total,
  }));

  // 接線は引き継がない。ランプの向きは経由点で決めているので、繋ぐ先の
  // 線形の延長に引きずられると、出口の直後で無理に曲がることになる。
  const startAnchor: Anchor = { pos: start.pos.clone(), node: start.id };
  const endAnchor: Anchor = { pos: end.pos.clone(), node: end.id };
  draw(network, field, classId, profiled, { start: startAnchor, end: endAnchor });
}

/**
 * 2 点を大回り (180° 超) の円弧で結ぶ経由点。ループランプの形を作る。
 *
 * 弦の垂直二等分線上に中心を取り、`bulge` で膨らみを決める。0.3 なら
 * 半径は弦長の 0.52 倍・掃引角は約 213° になり、ランプの最小半径 45 m を
 * 大きく上回る (弦長 200 m なら半径 105 m)。
 */
function loopArc(
  from: { u: number; v: number },
  to: { u: number; v: number },
  steps: number,
  bulge = 0.3,
): { u: number; v: number }[] {
  const du = to.u - from.u;
  const dv = to.v - from.v;
  const chord = Math.hypot(du, dv);
  if (chord < 1e-3) return [to];
  // 弦の右手側の法線。中心はその逆側に取ると、円弧は外 (+v 側) を回る。
  const nu = -dv / chord;
  const nv = du / chord;
  const centre = {
    u: (from.u + to.u) / 2 - nu * chord * bulge,
    v: (from.v + to.v) / 2 - nv * chord * bulge,
  };
  const radius = Math.hypot(from.u - centre.u, from.v - centre.v);
  const a0 = Math.atan2(from.v - centre.v, from.u - centre.u);
  const a1 = Math.atan2(to.v - centre.v, to.u - centre.u);
  let delta = a1 - a0;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta <= -Math.PI) delta += Math.PI * 2;
  // 短い方ではなく、必ず大回りする側を通る。
  const sweep = delta - Math.sign(delta || 1) * Math.PI * 2;
  const out: { u: number; v: number }[] = [];
  for (let i = 1; i <= steps; i++) {
    const angle = a0 + (sweep * i) / steps;
    out.push({
      u: centre.u + Math.cos(angle) * radius,
      v: centre.v + Math.sin(angle) * radius,
    });
  }
  return out;
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
    // 交差点のトリムに耐える長さ (区間長の 45%) を確保するため、
    // 近すぎる点は落とす。
    const near = out.length > 0 && v - out[out.length - 1] < step * 0.75;
    if (near && !keep) continue;
    // 直前の点が落とせるなら、そちらを落として重要な点を残す。
    if (near && keep && out.length > 1) out.pop();
    out.push(v);
  }
  return out;
}

/**
 * トランペット型インターチェンジを組み立てる。
 *
 * 側道が本線に**突き当たって終わる** T 字のインターで、行き止まりにせずに
 * 4 方向へ行けるようにするため、片方のランプが 270° 近く回り込む
 * (これがループランプ = トランペットの朝顔に見える部分)。
 *
 * 左側通行なので、本線の走行車線は
 *   ・+u 方向 (東行き) が -v 側
 *   ・-u 方向 (西行き) が +v 側
 * にある。出入口は必ず走行車線の側に付けなければならないので、東行きの
 * 2 本は側道と同じ -v 側で済むが、西行きの 2 本は本線の反対側 (+v) に
 * 回らなければならない。そこで側道を本線の下でそのまま +v 側へ抜けさせ
 * (`U`)、そこから西行きの 2 本を出す。こうするとランプどうしは 1 か所も
 * 平面交差せず、立体交差は「本線が側道を跨ぐ」1 か所だけで済む。
 *
 *        (+v) U ── A ─→ M1 本線 M2 ←─ B ─┐   B: ループランプ
 *              │                          │
 *   本線 ══════╪══════════════════════════╪═══
 *              │                          │
 *        (-v) T ── E-out ← M1 ／ E-in → M2
 *              │
 *            側道
 */
export interface TrumpetOptions extends InterchangeOptions {
  /** 側道が本線をくぐったあと、+v 側へ伸ばす長さ [m]。 */
  stubOffset?: number;
}

export function buildTrumpetInterchange(
  network: Network,
  field: Heightfield,
  options: TrumpetOptions = {},
): InterchangeResult {
  const center = options.center ?? { x: 0, z: 0 };
  const angle = options.angle ?? 0;
  const clearance = options.clearance ?? 9;
  const mainlineHalf = options.mainlineHalf ?? 400;
  const arterialHalf = options.arterialHalf ?? 300;
  const rampOffset = options.rampOffset ?? 170;
  const terminalOffset = options.terminalOffset ?? 130;
  const stubOffset = options.stubOffset ?? 100;
  const mainlineClass = options.mainlineClass ?? 'road_highway';
  const arterialClass = options.arterialClass ?? 'road_medium';
  const rampClass = options.rampClass ?? 'road_ramp';

  const { at, nodeAt, heightAt } = frameOf(network, field, center, angle);

  // --- 側道。本線の下をくぐって +v 側へ抜け、そこで終わる。
  const arterialV = spread(arterialHalf, terminalOffset, 85).filter((v) => v <= 0);
  arterialV.push(stubOffset);
  const arterial = arterialV.map((v) => at(0, v));
  draw(network, field, arterialClass, smoothProfile(field, arterial, arterialClass, { passes: 5 }), {
    straight: true,
  });

  const terminal = nodeAt(0, -terminalOffset);
  const stub = nodeAt(0, stubOffset);
  if (terminal === null || stub === null) return { rampNodes: [], terminals: [] };

  // --- 本線。ランプの分岐点は、側道の高さ + 桁下高に置く。
  const junctionY = (heightAt(0, -terminalOffset) + heightAt(0, stubOffset)) / 2 + clearance;
  const drop = Math.max(
    Math.abs(junctionY - network.getNode(terminal).pos.y),
    Math.abs(junctionY - network.getNode(stub).pos.y),
  );
  const reach = Math.max(
    rampOffset,
    Math.sqrt(
      Math.max(0, (drop / (getClass(rampClass).maxGrade * 0.75)) ** 2 - terminalOffset ** 2),
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

  const west = nodeAt(-rampAt, 0);
  const east = nodeAt(rampAt, 0);
  if (west === null || east === null) return { rampNodes: [], terminals: [terminal, stub] };

  // --- -v 側 (東行き) の 2 本。側道の突き当たりに直接取り付く。
  //
  // ランプはまっすぐ引く。経由点を増やして曲げると、区間ごとに
  // 「前の接線に接する円弧」を解く都合で接線が振動し、本線に取り付く
  // 角度が浅くなりすぎて交差点が長くなる。直線なら取り付き角がそのまま
  // 弦の向き (約 37°) になり、交差点の形が素直に決まる。
  connectRamp(network, field, rampClass, [at(-rampAt, 0), at(0, -terminalOffset)], west, terminal);
  connectRamp(network, field, rampClass, [at(0, -terminalOffset), at(rampAt, 0)], terminal, east);

  // --- +v 側 (西行き) の 2 本。側道の抜けた先から出す。
  // A: 側道 → 西行き本線。同じくまっすぐ引き、約 30° で合流する。
  connectRamp(network, field, rampClass, [at(0, stubOffset), at(-rampAt, 0)], stub, west);
  // B: 西行き本線 → 側道 (ループランプ)。左に浅く出てから大きく回り込み、
  // 側道の抜けた先へ南向きに戻る。
  // 分岐の直後も同じ理由で長さを取る。
  const diverge = { u: rampAt + 75, v: stubOffset * 0.36 };
  connectRamp(
    network,
    field,
    rampClass,
    [
      at(rampAt, 0),
      at(diverge.u, diverge.v),
      ...loopArc(diverge, { u: 0, v: stubOffset }, 6, 0.18).map((p) => at(p.u, p.v)),
    ],
    east,
    stub,
  );

  return { rampNodes: [west, east], terminals: [terminal, stub] };
}
