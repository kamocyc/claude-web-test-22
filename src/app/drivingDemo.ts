import { Vector3 } from 'three';
import type { Network, SegmentId } from '../network/network';
import {
  applyStationRetrofit,
  isAdoptable,
  planStationRetrofit,
} from '../network/stationRetrofit';
import type { StationId } from '../network/station';
import type { Heightfield } from '../terrain/heightfield';
import { draw, smoothProfile, type Waypoint } from './sketch';

/**
 * 運転して確かめるための路線。
 *
 * 「一通り出てくる長さと順序」で並べる。運転してみたいのは次の 5 つで、
 * それが**この順に**現れるように敷く。
 *
 * 1. 加速し切れるだけの直線 (起動加速度と定トルク→定出力の移り変わり)
 * 2. 惰行できる長さ (走行抵抗だけで速度がどう落ちるか)
 * 3. 勾配 (登りで速度が落ち、下りで抑速が要る)
 * 4. 制限のかかる曲線 (落として、抜けて、また上げる)
 * 5. 駅 (きちんと止まれるか)
 *
 * 全長 4〜5 km。橋とトンネルは地形任せで、谷を渡り丘を抜けるように通せば
 * 自然に出てくる (`computeStructureProfile` が決める)。
 */

/** 駅のホーム長 [m]。4 両編成 (80 m) が収まる長さ。 */
const PLATFORM_LENGTH = 120;

/** 途中駅の番線数。待避線を 1 本足して、行き違いができるようにする。 */
const PASSING_TRACKS = 2;
const PASSING_PLATFORMS = 1;

export interface DrivingDemoResult {
  /** 置いた駅。始発 → 途中 → 終点の順。 */
  stations: StationId[];
  /** 置けなかった駅の理由。 */
  warnings: string[];
}

/**
 * 運転デモ路線を敷く。
 *
 * 駅は**既設の線路への後付け**で置く。線路を先に通してから駅を差し込むので、
 * ホームが曲線に沿う所も待避線の分岐も、敷設の道具が実際にやるのと同じ経路を
 * 通ることになる。
 */
export function buildDrivingDemo(network: Network, field: Heightfield): DrivingDemoResult {
  network.clear();

  const points = demoWaypoints();
  // 縦断は地形を 3 回ならしたもの。規格 (5%) より緩い 2.5% で頭を打たせて
  // あるが、この地形では滅多に当たらない。効いているのはならしのほうで、
  // 地形をそのままなぞらせると勾配が細かく上下して「登りで速度が落ちる」が
  // 分からなくなる。谷はならした線の下に残るので橋になり、丘は上に残るので
  // トンネルになる。
  draw(
    network,
    field,
    'rail_single',
    smoothProfile(field, points, 'rail_single', { passes: 3, lift: 0, grade: 0.025 }),
    {},
  );

  const stations: StationId[] = [];
  const warnings: string[] = [];
  const targets: { name: string; along: number; tracks: number; platforms: number }[] = [
    { name: '西ヶ丘', along: 0.04, tracks: 1, platforms: 1 },
    { name: '中原', along: 0.55, tracks: PASSING_TRACKS, platforms: PASSING_PLATFORMS },
    { name: '東浜', along: 0.96, tracks: 1, platforms: 1 },
  ];
  // 置く場所は**先に全部決めてから**駅を作る。1 つ置くたびに線路は分割され、
  // 構内線と待避線が増えるので、そのあとで割合から場所を探し直すと、番号の
  // 付け替わった線路の上で見当違いの所を指すことになる。
  //
  // 狙った所がトンネルや橋に当たることもあるので、前後にも候補を用意して
  // おき、置ける所が見つかるまでずらす。地形は種ごとに違うので、1 点だけ
  // 決め打ちにすると種によって駅が欠ける。
  const chain = railChain(network);
  const candidates = targets.map((target) =>
    STATION_NUDGES.map((nudge) => pointAlong(network, chain, target.along, nudge)).filter(
      (p): p is Vector3 => p !== null,
    ),
  );

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const placed = placeStation(network, field, target, candidates[i] ?? []);
    if (typeof placed === 'string') warnings.push(`${target.name}: ${placed}`);
    else stations.push(placed);
  }
  return { stations, warnings };
}

/**
 * 狙った所から順に試して、置けた駅の id を返す。置けなければ最初の理由を返す。
 */
function placeStation(
  network: Network,
  field: Heightfield,
  target: { name: string; length?: number; tracks: number; platforms: number },
  candidates: readonly Vector3[],
): StationId | string {
  let firstReason: string | null = null;
  for (const point of candidates) {
    const spot = adoptableNear(network, point);
    if (!spot) {
      firstReason ??= '線路の上に置く場所が見つかりません';
      continue;
    }
    const result = planStationRetrofit(
      network,
      {
        name: target.name,
        length: PLATFORM_LENGTH,
        trackCount: target.tracks,
        platformCount: target.platforms,
        adopt: spot,
        trackIndex: 0,
        reversed: false,
      },
      field,
    );
    const blocker = result.blockers[0] ?? result.plan?.blockers[0];
    if (!result.plan || blocker !== undefined) {
      firstReason ??= blocker ?? '置けません';
      continue;
    }
    return applyStationRetrofit(network, result.plan).id;
  }
  return firstReason ?? '線路がありません';
}

/**
 * 狙った所から前後へずらして試す距離 [m]。
 *
 * ホーム長 (120 m) より広く振ると別の場所の駅になってしまうので、
 * トンネルの坑口や橋の桁を外せるぶんだけにする。
 */
const STATION_NUDGES: readonly number[] = [0, 90, -90, 180, -180, 280, -280];

/**
 * 路線の平面線形。
 *
 * **経由点は少なく、間隔は広く**。この道具の繋ぎ方は「前の区間の終わりの
 * 向きから次の点へ」で、線路では緩和曲線を挟んで解く。曲線を細かく刻んで
 * 置くと、区間ごとに緩和曲線が入り切らないまま曲率を引き継ぐことになり、
 * 行き過ぎと引き戻しが交互に出て曲率が振動する。半径 400 m のつもりで
 * 5 度ずつ刻んだところ、出来上がったのは半径 26 m と 28 m が交互に並ぶ線形
 * だった (規格の最小半径 50 m を割る)。同じ形を 8 点で引けば、実際の最小半径は
 * 300 m になり、警告は 1 つも出ない。
 *
 * 出てくるものの順序:
 *
 * | 区間 | ねらい |
 * | --- | --- |
 * | -2100 → -900 | 直線 1200 m。加速し切って惰行も試せる。 |
 * | -900 → 300 | 緩い曲線。制限はかからない。 |
 * | 300 → 900 | 直線。途中駅 (待避線つき) を置く。 |
 * | 900 → 1800 | 半径 300 m 級の曲線。50 km/h まで落とさないと通れない。 |
 * | 1800 → 2200 | 終点へ。 |
 *
 * 勾配は地形任せ。谷を渡れば橋に、丘を抜ければトンネルになる。
 */
function demoWaypoints(): Waypoint[] {
  return [
    { x: -2100, z: 100 },
    { x: -900, z: 100 },
    { x: -300, z: -20 },
    { x: 300, z: -260 },
    { x: 900, z: -300 },
    { x: 1400, z: -120 },
    { x: 1800, z: 180 },
    { x: 2200, z: 240 },
  ];
}

/**
 * 路線の `fraction` の位置から `nudge` [m] だけずらした点。
 *
 * セグメントは敷設のときに曲率で切れているので、番号順ではなく**繋がりを
 * 辿って**長さで測る。
 */
function pointAlong(
  network: Network,
  chain: readonly SegmentId[],
  fraction: number,
  nudge = 0,
): Vector3 | null {
  if (chain.length === 0) return null;
  const lengths = chain.map((id) => network.alignmentOf(id).length);
  const total = lengths.reduce((a, b) => a + b, 0);
  let want = Math.max(0, Math.min(total, total * Math.max(0, Math.min(1, fraction)) + nudge));
  for (let i = 0; i < chain.length; i++) {
    if (want <= lengths[i]! || i === chain.length - 1) {
      const s = Math.max(0, Math.min(want, lengths[i]!));
      return network.alignmentOf(chain[i]!).sampleAt(s).pos.clone();
    }
    want -= lengths[i]!;
  }
  return null;
}

/** その点のいちばん近くにある、駅を取り込める線路。 */
function adoptableNear(
  network: Network,
  point: Vector3,
): { segment: SegmentId; s: number } | null {
  for (const radius of [40, 120, 300]) {
    const hit = network.findSegmentNear(point, radius);
    if (hit && isAdoptable(network, hit.segment)) return { segment: hit.segment, s: hit.s };
  }
  return null;
}

/**
 * 線路のセグメントを、端から端まで繋がりの順に並べる。
 *
 * 端 (枝が 1 本しか出ていないノード) から辿る。分岐では最初の枝を採る。
 */
function railChain(network: Network): SegmentId[] {
  const rails = [...network.segments.values()].filter(
    (seg) => network.classOf(seg).kind === 'rail',
  );
  if (rails.length === 0) return [];
  const railIds = new Set(rails.map((seg) => seg.id));
  const endNode = [...network.nodes.values()].find(
    (node) => node.segments.filter((id) => railIds.has(id)).length === 1,
  );
  if (!endNode) return rails.map((seg) => seg.id);

  const chain: SegmentId[] = [];
  const seen = new Set<SegmentId>();
  let node = endNode.id;
  for (let guard = 0; guard < rails.length + 1; guard++) {
    const current = network.getNode(node);
    const next = current.segments.find((id) => railIds.has(id) && !seen.has(id));
    if (next === undefined) break;
    seen.add(next);
    chain.push(next);
    const seg = network.getSegment(next);
    node = seg.a === node ? seg.b : seg.a;
  }
  return chain;
}

/** デモ路線の始発駅のあたり (視点を置く先)。 */
export function drivingDemoOrigin(): Vector3 {
  return new Vector3(-2200, 0, 0);
}
