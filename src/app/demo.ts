import { Vector3 } from 'three';
import { buildInterchange, buildTrumpetInterchange } from './interchange';
import { draw, drawParallel, smoothProfile, type Waypoint } from './sketch';
import { getClass } from '../network/classes';
import { planStationLayout } from '../network/station';
import { anchorFromNode, computePlacement, placeSegment } from '../network/editing';
import type { Network } from '../network/network';
import type { Heightfield } from '../terrain/heightfield';

/**
 * 道路上で、踏切・交差点を置くのに向いた地点を探す。
 *
 * 見るのは 2 つ。**路面が自然地形と同じ高さ**であること (切土・盛土が
 * 少ない) と、**路面が平坦**であること。急勾配の途中に置くと、幅のある
 * 線路の面に道路を合わせるのに何十 m もすり付けることになる。
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
  let bestCost = Infinity;
  for (let x = xRange[0]; x <= xRange[1]; x += 10) {
    if (avoid && Math.abs(x - avoid.x) < avoid.radius) continue;
    const hit = network.findSegmentNear(new Vector3(x, 0, z), 25);
    if (!hit) continue;
    const delta = Math.abs(hit.pos.y - field.baseHeightAt(hit.pos.x, hit.pos.z));
    const grade = Math.abs(network.alignmentOf(hit.segment).vertical.gradeAt(hit.s));
    // 勾配を強く嫌う。踏切では線路は水平で、道路の舗装だけが道路の縦断に
    // 沿うので、勾配のある所に置くと外側のレールの上で舗装が railhead から
    // 浮く (4.5 m 離れた複線では 3% で 13 cm)。
    const cost = delta + grade * 150;
    if (cost < bestCost) {
      bestCost = cost;
      bestDelta = delta;
      best = hit.pos.clone();
    }
  }
  return bestDelta < 4 ? best : null;
}

const TERMINUS_TRACKS = 2;
const TERMINUS_PLATFORMS = 2;
const TERMINUS_LENGTH = 120;
/**
 * 本線の端から構内線の端までの長さ [m] (駅ののど)。
 *
 * 構内線は本線より 2 m ほど外へずれるので、繋ぐ線形はそのぶん横へ振れる。
 * 横へ振るには長さが要る — 詰めて繋ぐと反向曲線がきつくなり、継ぎ目で曲率が
 * 飛ぶ (`findCurveBreaks` の警告に出る)。
 */
const TERMINUS_THROAT = 180;

/**
 * 本線の端に終端駅を繋ぐ。`side` は本線から見て駅を置く向き (+1 = 北)。
 *
 * 駅の構内線は独立した線形なので、本線の端点と 1 本ずつ結ぶ。両端の点を
 * ただ結ぶと継ぎ目が折れるため、**敷設ツールと同じ手順**で置いて両端の
 * 接線・曲率・勾配を引き継ぐ。線路に向きは無いので、繋ぐ向きは考えなくてよい。
 */
function attachTerminus(
  network: Network,
  name: string,
  railX: number,
  mainZ: number,
  side: 1 | -1,
): void {
  const stationZ = mainZ + side * (TERMINUS_THROAT + TERMINUS_LENGTH / 2);
  const ends = [...network.nodes.values()]
    .filter(
      (node) =>
        Math.abs(node.pos.z - mainZ) < 1 &&
        node.segments.some((id) => network.classOf(network.getSegment(id)).kind === 'rail'),
    )
    .sort((a, b) => a.pos.x - b.pos.x);
  if (ends.length === 0) return;
  const y = ends.reduce((sum, node) => sum + node.pos.y, 0) / ends.length;
  // 構内線の並びは本線より広い (間にホームが入る) ので、中心を合わせて置く。
  // 片方の線を真っ直ぐ繋ぐように置くと、もう片方が倍の幅だけ横へ振れる。
  // 駅の向きは +Z で、右手 (`offset` の正) が -X。
  const layout = planStationLayout(TERMINUS_TRACKS, TERMINUS_PLATFORMS);
  const middle = layout.tracks.reduce((sum, t) => sum + t.offset, 0) / layout.tracks.length;
  const station = network.addStation({
    name,
    center: new Vector3(railX + middle, y, stationZ),
    heading: Math.PI / 2,
    length: TERMINUS_LENGTH,
    trackCount: TERMINUS_TRACKS,
    platformCount: TERMINUS_PLATFORMS,
    elevated: false,
  });
  // 構内線のうち、本線に近い側の端点。
  const near = station.tracks
    .map((track) => {
      const seg = network.getSegment(track.segment);
      const nodes = [network.getNode(seg.a), network.getNode(seg.b)].sort(
        (a, b) => a.pos.z - b.pos.z,
      );
      return { track, node: side > 0 ? nodes[0] : nodes[1] };
    })
    .sort((a, b) => a.node.pos.x - b.node.pos.x);

  const cls = getClass('rail_single');
  for (let i = 0; i < Math.min(ends.length, near.length); i++) {
    // 構内線と同じく、南から北へ向かう向きに揃えて敷く。
    const [a, b] = side > 0 ? [ends[i], near[i].node] : [near[i].node, ends[i]];
    const from = anchorFromNode(network, a, cls);
    const to = anchorFromNode(network, b, cls);
    placeSegment(network, cls.id, from, to, computePlacement(from, to, { straight: false, cls }));
  }
}

/**
 * 起動時に置くサンプル。切土・盛土、橋、トンネル、交差点、踏切、分岐器、
 * 立体交差が一通り含まれるように配置する。
 */
export function buildDemoNetwork(
  network: Network,
  field: Heightfield,
  origin: { x: number; z: number } = demoSite(field),
): void {
  network.clear();

  // 幹線道路。自然地形をならした縦断で東西に通す。谷では高架、丘では
  // トンネル、それ以外は切土・盛土で地形に馴染む。
  const roadZ = origin.z - 40;
  const trunk: Waypoint[] = [];
  for (let x = -430; x <= 430; x += 60) trunk.push({ x: origin.x + x, z: roadZ });
  // 縦断は規格 (13.5%) より大幅に緩い 6% までにする。地形をそのまま
  // なぞらせると切土・盛土だけで通ってしまい、谷の高架も丘のトンネルも
  // 出てこない。
  draw(network, field, 'road_medium', smoothProfile(field, trunk, 'road_medium', {
    grade: 0.06,
  }), {
    straight: true,
  });

  // 幹線道路が地面に接している所を探して、そこに踏切を作る。
  const crossing = findAtGradePoint(network, field, roadZ, [origin.x - 300, origin.x + 300]);
  const railX = crossing ? crossing.x : origin.x - 220;
  const railY = crossing ? crossing.y : field.baseHeightAt(railX, roadZ);

  // 線路。踏切の位置だけ道路と同じ高さに固定し、あとは 3% 以内で
  // 地形に沿わせる。
  // 踏切がセグメントの途中に来るよう、交点の手前と先に経由点を置き、
  // その 2 点を道路と同じ高さに固定する。間は水平になる。
  // 前後にも水平区間を取ると、縦断曲線の膨らみで踏切がずれることがない。
  // 分岐器のトリムに耐えるよう、区間長は 60 m 以上にしておく。
  const levelZ = [roadZ - 105, roadZ - 45, roadZ + 45, roadZ + 105];
  const railZ: number[] = [...levelZ];
  const railEnd = 300;
  for (let z = roadZ - 195; z >= origin.z - railEnd; z -= 90) railZ.push(Math.max(z, origin.z - railEnd));
  for (let z = roadZ + 195; z <= origin.z + railEnd; z += 90) railZ.push(Math.min(z, origin.z + railEnd));
  railZ.push(origin.z - railEnd, origin.z + railEnd);
  railZ.sort((a, b) => a - b);
  // 近すぎる点を落として、短いセグメントができないようにする。
  for (let i = railZ.length - 1; i > 0; i--) {
    if (railZ[i] - railZ[i - 1] < 40) railZ.splice(i, 1);
  }
  const railPoints: Waypoint[] = railZ.map((z) => ({ x: railX, z }));
  const fixedIndices = levelZ.map((z) => ({ index: railZ.indexOf(z), y: railY }));
  // 複線は 2 本の線路を並べて敷く。1 本ずつ独立した線形なので、
  // 片側だけ分岐させたり橋にしたりできる。
  drawParallel(
    network,
    field,
    'rail_single',
    smoothProfile(field, railPoints, 'rail_single', {
      passes: 6,
      lift: 0,
      fixed: fixedIndices,
      // 側線 (最大 3%) が本線から分かれてしばらく同じ縦断で走れるよう、
      // 本線もその範囲に収める。規格 (5.5%) いっぱいまで使うと地形を
      // そのままなぞってしまい、丘のトンネルも出てこない。
      grade: 0.03,
    }),
    { straight: true, count: 2 },
  );

  // 起動直後から路線を引けるよう、本線の両端の先に駅を 1 つずつ繋ぐ。
  attachTerminus(network, 'みどり台', railX, origin.z + railEnd, 1);
  attachTerminus(network, '南浜', railX, origin.z - railEnd, -1);

  // 側線への分岐。分岐器ができる。
  // 側線は本線の勾配をそのまま引き継ぐので、本線が側線の規格 (3%) に収まる
  // 所から分ける。踏切の近くは避ける (分岐器と踏切が重なると置けない)。
  const branchNode = flattestNodeAlong(network, railX, origin.z - 240, origin.z + 240, roadZ);
  if (branchNode) {
    // 分岐器として成り立つよう、本線からごく浅い角度で分ける。
    const yard: Waypoint[] = [
      { x: branchNode.pos.x, z: branchNode.pos.z },
      { x: railX + 22, z: branchNode.pos.z + 110 },
      { x: railX + 90, z: branchNode.pos.z + 180 },
    ];
    // 側線は本線と同じ縦断で通す。地形に沿わせると、本線が勾配の途中に
    // あるときに縦断が分かれ、分岐器のすぐ先で側線の道床が本線の軌道面より
    // 上に出る (分かれてしばらくは道床が重なっているので、そのまま埋まる)。
    // 構内の線路が一定勾配なのは実際の作りでもある。
    const beside = network.findSegmentNear(new Vector3(railX, branchNode.pos.y, yard[1].z), 60);
    const span1 = Math.hypot(yard[1].x - yard[0].x, yard[1].z - yard[0].z);
    const limit = getClass('rail_yard').maxGrade * 0.9;
    const wanted = beside ? (beside.pos.y - branchNode.pos.y) / span1 : 0;
    const grade = Math.max(-limit, Math.min(limit, wanted));
    let along = 0;
    const yardProfile: Waypoint[] = yard.map((p, i) => {
      if (i > 0) along += Math.hypot(p.x - yard[i - 1].x, p.z - yard[i - 1].z);
      return { ...p, y: branchNode.pos.y + grade * along };
    });
    draw(network, field, 'rail_yard', yardProfile);
  }

  // 線路を跨ぐ道路。桁下を確保しているので立体交差になる。
  // 側線の終端 (z = branchNode.z + 180 ≒ 245) から離しておく。9 m の
  // 盛土の裾がかかると、側線の道床が盛土に埋まる。
  const overpassZ = origin.z + 270;
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
  const junction = findAtGradePoint(network, field, roadZ, [origin.x - 330, origin.x + 330], {
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
export function buildInterchangeDemo(
  network: Network,
  field: Heightfield,
  kind: 'diamond' | 'trumpet' = 'diamond',
): void {
  network.clear();
  const spot = flattestSpot(field);
  const options = { center: spot.center, angle: spot.angle };
  if (kind === 'trumpet') buildTrumpetInterchange(network, field, options);
  else buildInterchange(network, field, options);
}

/** 本線と側道が通る十字の範囲で、いちばん起伏の小さい場所と向きを選ぶ。 */
function flattestSpot(field: Heightfield): { center: { x: number; z: number }; angle: number } {
  const site = demoSite(field);
  let best = { center: site, angle: 0 };
  let bestRange = Infinity;
  for (const angle of [0, Math.PI / 2]) {
    for (let x = site.x - 120; x <= site.x + 120; x += 60) {
      for (let z = site.z - 120; z <= site.z + 120; z += 60) {
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

/**
 * その区間で、本線の勾配がいちばん緩いノードを選ぶ。
 *
 * 側線は分かれてからしばらく本線のすぐ脇を走る。本線が勾配の途中だと、
 * 地形に沿う側線と縦断が分かれて、側線の道床が本線の軌道面より上に出る。
 */
function flattestNodeAlong(
  network: Network,
  x: number,
  z0: number,
  z1: number,
  avoidZ: number,
): ReturnType<Network['findNodeNear']> {
  let best: ReturnType<Network['findNodeNear']> = null;
  let bestGrade = Infinity;
  for (let z = z0; z <= z1; z += 20) {
    if (Math.abs(z - avoidZ) < 130) continue;
    const node = network.findNodeNear(new Vector3(x, 0, z), 30);
    if (!node) continue;
    const hit = network.findSegmentNear(node.pos, 6);
    const grade = hit ? Math.abs(network.alignmentOf(hit.segment).vertical.gradeAt(hit.s)) : 1;
    if (grade < bestGrade) {
      bestGrade = grade;
      best = node;
    }
  }
  return best;
}

/** 見本の道路と線路が伸びる範囲 [m]。マップの端からこれだけ内側を探す。 */
const DEMO_REACH = 700;

/** 陸と見なす高さ [m]。海面ぎりぎりの砂浜には敷かない。 */
const DRY_Y = 1.5;

/**
 * 見本のネットワークを置く場所を選ぶ。
 *
 * 地形は生成のたびに変わるので、原点が海の底ということもある。見本は
 * 「交差点・踏切・分岐器・橋・トンネルが一通り出る」ことを見せるものなので、
 * それが成り立つ場所を地形から探す。
 */
export function demoSite(field: Heightfield): { x: number; z: number } {
  const margin = DEMO_REACH + field.cell * 2;
  const lo = field.worldMin + margin;
  const hi = field.worldMax - margin;
  const center = { x: 0, z: 0 };
  if (hi <= lo) return center;
  const step = Math.max(120, field.cell * 16);
  let best = center;
  let bestScore = -Infinity;
  for (let z = lo; z <= hi; z += step) {
    for (let x = lo; x <= hi; x += step) {
      const score = siteScore(field, x, z);
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
  }
  return best;
}

/**
 * 見本の場所の点数。
 *
 * 「起伏がある」だけでは橋にもトンネルにもならない。線形は規格の勾配までしか
 * 折れないので、**その勾配で追いつけない所**が谷なら橋、丘ならトンネルになる。
 * 中心から外へ勾配を制限しながら地形を追う縦断を引いて、そこから地形が
 * どれだけ離れるかで見る。起伏が大きすぎるのも困る (切土・盛土で路面が地面から
 * 離れ、踏切と交差点を置ける「地面と同じ高さの所」が無くなる) ので、
 * 足りない分は強く、余る分は弱く引く。
 */
function siteScore(field: Heightfield, x: number, z: number): number {
  const roadZ = z - 40;
  const railX = x - 220;
  const trunk = corridorGap(field, x, roadZ, 1, 0, 430, 0.06);
  if (!trunk) return -Infinity;
  const rail = corridorGap(field, railX, z, 0, 1, 320, 0.03);
  if (!rail) return -Infinity;
  /** 幅から外れた分。足りなくても余っても引く。 */
  const miss = (value: number, min: number, max: number): number =>
    value < min ? min - value : value > max ? value - max : 0;
  return -(
    // 中ほどは路面が地面と同じ高さで通ること。踏切・交差点・分岐器はここに
    // 置くので、切土・盛土で路面が地面から離れていると場所が見つからない。
    (miss(trunk.innerAbove, 0, 3) + miss(trunk.innerBelow, 0, 3)) * 2 +
    (miss(rail.innerAbove, 0, 5) + miss(rail.innerBelow, 0, 5)) * 2 +
    // 外側に、道路が渡る谷 (橋) と線路が抜ける丘 (トンネル) が 1 つずつ。
    // 40 m の谷や 50 m の丘だと見本が延々と高架・トンネルになる。
    miss(trunk.outerBelow, 10, 24) * 2 +
    miss(rail.outerAbove, 16, 30) * 3 +
    // 逆向きの起伏は少ないほどよい。
    miss(trunk.outerAbove, 0, 16) * 0.5 +
    miss(rail.outerBelow, 0, 14) * 0.5
  );
}

/** 中ほどと見なす範囲 [m]。踏切・交差点・分岐器がここに入る。 */
const SITE_INNER = 150;
/**
 * 端として数えない範囲 [m]。
 *
 * 谷や丘が線形の端に掛かっていると、橋やトンネルが端で切れて「戻ってくる
 * 継ぎ目」ができない。両端をこのぶん除いて数えることで、橋とトンネルが
 * 線形の途中に収まる場所を選ぶ。
 */
const SITE_TAIL = 70;

interface CorridorGap {
  innerAbove: number;
  innerBelow: number;
  outerAbove: number;
  outerBelow: number;
}

/**
 * 中心から両側へ勾配を制限して地形を追い、地形が縦断からどれだけ離れるかを
 * 返す。`above` は追いつけない丘 (トンネル)、`below` は谷 (橋)。
 * 中ほど (`SITE_INNER` 以内) と外側で分けて数える。
 * 通る範囲に水があれば null。
 */
function corridorGap(
  field: Heightfield,
  x: number,
  z: number,
  ux: number,
  uz: number,
  half: number,
  grade: number,
): CorridorGap | null {
  const step = 25;
  const start = field.baseHeightAt(x, z);
  if (start < DRY_Y) return null;
  const gap: CorridorGap = { innerAbove: 0, innerBelow: 0, outerAbove: 0, outerBelow: 0 };
  for (const side of [1, -1]) {
    let profile = start;
    for (let t = step; t <= half; t += step) {
      const y = field.baseHeightAt(x + ux * t * side, z + uz * t * side);
      if (y < DRY_Y) return null;
      const reach = grade * step;
      profile = Math.min(profile + reach, Math.max(profile - reach, y));
      const above = y - profile;
      const below = profile - y;
      if (t <= SITE_INNER) {
        if (above > gap.innerAbove) gap.innerAbove = above;
        if (below > gap.innerBelow) gap.innerBelow = below;
      } else if (t <= half - SITE_TAIL) {
        if (above > gap.outerAbove) gap.outerAbove = above;
        if (below > gap.outerBelow) gap.outerBelow = below;
      }
    }
  }
  return gap;
}
