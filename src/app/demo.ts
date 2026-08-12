import { Vector3 } from 'three';
import { getClass } from '../network/classes';
import {
  anchorFromNode,
  computePlacement,
  placeSegment,
  type Anchor,
} from '../network/editing';
import type { Network } from '../network/network';
import type { Heightfield } from '../terrain/heightfield';

interface Waypoint {
  x: number;
  z: number;
  /** 絶対高さ。省略時は自然地形の高さ。 */
  y?: number;
}

/**
 * 経由点を順に繋いで線形を引く。建設ツールと同じ手順を通るので、
 * 接線の引き継ぎ・自動交差点生成も同じように働く。
 * 始点の近くに既存ノードがあればそれに接続する。
 */
function draw(
  network: Network,
  field: Heightfield,
  classId: string,
  points: Waypoint[],
  options: { straight?: boolean } = {},
): void {
  const cls = getClass(classId);
  const toVec = (p: Waypoint): Vector3 =>
    new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);

  const first = toVec(points[0]);
  const existing = network.findNodeNear(first, 3);
  let anchor: Anchor = existing
    ? anchorFromNode(network, existing, cls)
    : { pos: first };

  for (let i = 1; i < points.length; i++) {
    const target = toVec(points[i]);
    const preview = computePlacement(anchor, target, {
      straight: options.straight ?? false,
      cls,
    });
    const result = placeSegment(network, classId, anchor, { pos: target }, preview);
    const endNode = network.nodes.get(result.endNode);
    if (!endNode) break;
    anchor = {
      pos: endNode.pos.clone(),
      node: endNode.id,
      tangent: preview.endTangent.clone(),
      grade: preview.endGrade,
    };
  }
}

/**
 * 経由点に縦断高さを与える。自然地形をならしたうえで、規格勾配を
 * 超えないよう前後から高さを制限する。
 */
function smoothProfile(
  field: Heightfield,
  points: Waypoint[],
  classId: string,
  options: {
    passes?: number;
    lift?: number;
    startY?: number;
    /** 高さを固定する経由点 (踏切など、他の線形と高さを合わせたい点)。 */
    fixed?: { index: number; y: number }[];
  } = {},
): Waypoint[] {
  const cls = getClass(classId);
  const passes = options.passes ?? 3;
  const lift = options.lift ?? 1.5;
  const heights = points.map((p) => field.baseHeightAt(p.x, p.z));

  for (let pass = 0; pass < passes; pass++) {
    const next = heights.slice();
    for (let i = 1; i + 1 < heights.length; i++) {
      next[i] = (heights[i - 1] + heights[i] * 2 + heights[i + 1]) / 4;
    }
    heights.splice(0, heights.length, ...next);
  }

  // 高さを固定したい点 (接続点や踏切) を反映する。
  const locked = new Set<number>();
  if (options.startY !== undefined) {
    heights[0] = options.startY - lift;
    locked.add(0);
  }
  for (const fix of options.fixed ?? []) {
    heights[fix.index] = fix.y - lift;
    locked.add(fix.index);
  }

  // 経由点間の勾配は規格の 9 割までに抑える。区間内の最大勾配は
  // computePlacement 側でも規格に収まるよう調整される。
  const limit = cls.maxGrade * 0.9;
  const spans = points.map((p, i) =>
    i === 0 ? 0 : Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z),
  );
  for (let pass = 0; pass < 6; pass++) {
    for (let i = 1; i < heights.length; i++) {
      if (locked.has(i)) continue;
      heights[i] = clampDelta(heights[i], heights[i - 1], limit * spans[i]);
    }
    for (let i = heights.length - 2; i >= 0; i--) {
      if (locked.has(i)) continue;
      heights[i] = clampDelta(heights[i], heights[i + 1], limit * spans[i + 1]);
    }
  }

  return points.map((p, i) => ({ ...p, y: heights[i] + lift }));
}

function clampDelta(value: number, reference: number, max: number): number {
  if (value > reference + max) return reference + max;
  if (value < reference - max) return reference - max;
  return value;
}

/**
 * 道路上で、路面が自然地形といちばん近い高さになっている地点を探す。
 * 踏切や交差点は、切土・盛土の少ない所に置きたい。
 */
function findAtGradePoint(
  network: Network,
  field: Heightfield,
  z: number,
  xRange: [number, number],
  avoid?: { x: number; radius: number },
): Vector3 | null {
  let best: Vector3 | null = null;
  let bestDelta = Infinity;
  for (let x = xRange[0]; x <= xRange[1]; x += 10) {
    if (avoid && Math.abs(x - avoid.x) < avoid.radius) continue;
    const hit = network.findSegmentNear(new Vector3(x, 0, z), 25);
    if (!hit) continue;
    const delta = Math.abs(hit.pos.y - field.baseHeightAt(hit.pos.x, hit.pos.z));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = hit.pos.clone();
    }
  }
  return bestDelta < 4 ? best : null;
}

/**
 * 起動時に置くサンプル。切土・盛土、橋、トンネル、交差点、踏切、分岐器、
 * 立体交差が一通り含まれるように配置する。
 */
export function buildDemoNetwork(network: Network, field: Heightfield): void {
  network.clear();

  // 幹線道路。自然地形をならした縦断で東西に通す。谷では高架、丘では
  // トンネル、それ以外は切土・盛土で地形に馴染む。
  const roadZ = -40;
  const trunk: Waypoint[] = [];
  for (let x = -430; x <= 430; x += 60) trunk.push({ x, z: roadZ });
  draw(network, field, 'road_medium', smoothProfile(field, trunk, 'road_medium'), {
    straight: true,
  });

  // 幹線道路が地面に接している所を探して、そこに踏切を作る。
  const crossing = findAtGradePoint(network, field, roadZ, [-300, 300]);
  const railX = crossing ? crossing.x : -220;
  const railY = crossing ? crossing.y : field.baseHeightAt(railX, roadZ);

  // 線路。踏切の位置だけ道路と同じ高さに固定し、あとは 3% 以内で
  // 地形に沿わせる。
  // 踏切がセグメントの途中に来るよう、交点の手前と先に経由点を置き、
  // その 2 点を道路と同じ高さに固定する。間は水平になる。
  // 前後にも水平区間を取ると、縦断曲線の膨らみで踏切がずれることがない。
  // 分岐器のトリムに耐えるよう、区間長は 60 m 以上にしておく。
  const levelZ = [roadZ - 105, roadZ - 45, roadZ + 45, roadZ + 105];
  const railZ: number[] = [...levelZ];
  for (let z = roadZ - 195; z >= -300; z -= 90) railZ.push(Math.max(z, -300));
  for (let z = roadZ + 195; z <= 300; z += 90) railZ.push(Math.min(z, 300));
  railZ.push(-300, 300);
  railZ.sort((a, b) => a - b);
  // 近すぎる点を落として、短いセグメントができないようにする。
  for (let i = railZ.length - 1; i > 0; i--) {
    if (railZ[i] - railZ[i - 1] < 40) railZ.splice(i, 1);
  }
  const railPoints: Waypoint[] = railZ.map((z) => ({ x: railX, z }));
  const fixedIndices = levelZ.map((z) => ({ index: railZ.indexOf(z), y: railY }));
  draw(
    network,
    field,
    'rail_double',
    smoothProfile(field, railPoints, 'rail_double', {
      passes: 6,
      lift: 0,
      fixed: fixedIndices,
    }),
    { straight: true },
  );

  // 側線への分岐。分岐器ができる。
  const branchNode = network.findNodeNear(new Vector3(railX, railY, roadZ + 120), 40);
  if (branchNode) {
    // 分岐器として成り立つよう、本線からごく浅い角度で分ける。
    const yard: Waypoint[] = [
      { x: branchNode.pos.x, z: branchNode.pos.z },
      { x: railX + 22, z: branchNode.pos.z + 110 },
      { x: railX + 90, z: branchNode.pos.z + 180 },
    ];
    draw(
      network,
      field,
      'rail_yard',
      smoothProfile(field, yard, 'rail_yard', { passes: 4, lift: 0, startY: branchNode.pos.y }),
    );
  }

  // 線路を跨ぐ道路。桁下を確保しているので立体交差になる。
  const overpassZ = 250;
  const railUnder = network.findSegmentNear(new Vector3(railX, 0, overpassZ), 30);
  const overpassY = (railUnder ? railUnder.pos.y : railY) + 9;
  draw(
    network,
    field,
    'road_small',
    [
      { x: railX - 130, z: overpassZ, y: overpassY },
      { x: railX, z: overpassZ, y: overpassY },
      { x: railX + 130, z: overpassZ, y: overpassY },
    ],
    { straight: true },
  );

  // 幹線道路から分かれる生活道路。4 叉路の交差点と信号ができる。
  // 踏切から十分離れた、地面に近い所を選ぶ。
  const junction = findAtGradePoint(network, field, roadZ, [-330, 330], {
    x: railX,
    radius: 140,
  });
  const hit = junction ? network.findSegmentNear(junction, 25) : null;
  if (junction && hit) {
    // 交差点の前後に取り付け長が残るよう、区間の中ほどで分割する。
    const length = network.alignmentOf(hit.segment).length;
    const cut = Math.min(Math.max(hit.s, length * 0.4), length * 0.6);
    const node = network.splitSegment(hit.segment, cut);
    const base = { x: node.pos.x, z: node.pos.z };
    const branch = (dz: number, dx: number): Waypoint[] => {
      const pts: Waypoint[] = [base];
      for (let i = 1; i <= 4; i++) {
        pts.push({ x: base.x + (dx * i) / 4, z: roadZ + (dz * i) / 4 });
      }
      return smoothProfile(field, pts, 'road_small', {
        passes: 6,
        lift: 1.2,
        startY: node.pos.y,
      });
    };
    draw(network, field, 'road_small', branch(240, 80));
    draw(network, field, 'road_small', branch(-230, -70));
  }
}
