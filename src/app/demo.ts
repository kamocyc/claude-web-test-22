import { Vector3 } from 'three';
import { buildInterchange } from './interchange';
import { draw, smoothProfile, type Waypoint } from './sketch';
import type { Network } from '../network/network';
import type { Heightfield } from '../terrain/heightfield';

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

/**
 * インターチェンジのサンプル。
 *
 * 高低差の少ない所を選んで置く。本線は側道より 9 m 高いので、平らな所に
 * 置けば橋と盛土だけで収まり、ランプの勾配も規格に収まる。
 */
export function buildInterchangeDemo(network: Network, field: Heightfield): void {
  network.clear();
  const spot = flattestSpot(field);
  buildInterchange(network, field, { center: spot.center, angle: spot.angle });
}

/** 本線と側道が通る十字の範囲で、いちばん起伏の小さい場所と向きを選ぶ。 */
function flattestSpot(field: Heightfield): { center: { x: number; z: number }; angle: number } {
  let best = { center: { x: 0, z: 0 }, angle: 0 };
  let bestRange = Infinity;
  for (const angle of [0, Math.PI / 2]) {
    for (let x = -120; x <= 120; x += 60) {
      for (let z = -120; z <= 120; z += 60) {
        const range = crossRange(field, x, z, angle);
        if (range < bestRange) {
          bestRange = range;
          best = { center: { x, z }, angle };
        }
      }
    }
  }
  return best;
}

/** 十字に伸ばした線上の、地形の高低差 [m]。 */
function crossRange(field: Heightfield, x: number, z: number, angle: number): number {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let lo = Infinity;
  let hi = -Infinity;
  for (const [du, dv] of [
    [1, 0],
    [0, 1],
  ] as const) {
    const reach = du === 1 ? 400 : 300;
    for (let t = -reach; t <= reach; t += 40) {
      const u = t * du;
      const v = t * dv;
      const y = field.baseHeightAt(x + u * cos - v * sin, z + u * sin + v * cos);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  return hi - lo;
}
