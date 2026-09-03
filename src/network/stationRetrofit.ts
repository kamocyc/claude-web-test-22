import { Vector3 } from 'three';
import { Alignment } from '../core/alignment';
import { VerticalProfile } from '../core/profile';
import { DEG, TUNNEL_THRESHOLD, clamp } from '../core/units';
import type { Heightfield } from '../terrain/heightfield';
import { SPEED_FACTOR, getClass, type NetworkClass } from './classes';
import {
  anchorFromNode,
  anchorFromSegment,
  computePlacement,
  placeSegment,
  type Anchor,
} from './editing';
import type { Network, NodeId, SegmentId } from './network';
import { parallelAlignment, previewFromAlignments } from './parallel';
import { checkPlacement } from './rules';
import { CURVE_BREAK_ACCEL } from './validation';
import {
  planStationLayout,
  stationAt,
  type PlannedStationLayout,
  type Station,
  type StationLength,
  type StationTrack,
} from './station';
import { checkStationPlacement } from './stationPlacement';

/**
 * 既にある線路に、あとから駅を設置する。
 *
 * 空き地に置く駅 (`Network.addStation`) は自分の構内線を作るが、こちらは
 * **既にある線路をそのまま取り込む**。指した所を中心に駅長ぶんの区間を切り出し、
 * その区間を構内線に変える。線路は 1 mm も動かないので、曲線でも勾配でも
 * そのまま駅になり、ホームが線路に沿って曲がる。
 *
 * 足りない番線 (待避線) は取り込んだ線の脇に平行に作り、駅の前後で本線に
 * 合流させる。合流は敷設ツールとまったく同じ手順 (`computePlacement` →
 * `placeSegment`) を通すので、接線に沿った分岐器になる。
 *
 * 立案 (`planStationRetrofit`) はネットワークを一切変えない。プレビューの間は
 * 毎フレーム呼ばれ、置けない理由を出すのに使う。実際に置くのは
 * `applyStationRetrofit`。
 */

/** 継ぎ目を越えて 1 本の構内線にまとめてよい折れ角。 */
const SEAM_DEFLECTION = 5 * DEG;

/**
 * まとめた縦断が元の高さから外れてよい量 [m]。
 *
 * 複数の区間を 1 本にまとめると、縦断は両端の高さと勾配で決まる 3 次曲線 1 本に
 * なる (`Network.alignmentOf`)。途中に山や谷があるとそこが均されてしまう。
 * 平坦地や一定勾配ではぴたりと一致するので、ふつうは引っかからない。
 */
const PROFILE_TOLERANCE = 0.3;

/**
 * 敷地が曲線の内側で折り返さないための、半径と敷地幅の比。
 *
 * 半径より広い敷地を曲線に沿わせると、内側の縁が自分と交わって多角形が破れる。
 * 破れると整地が虫食いになり、原因の追いにくい壊れ方をする。
 */
const CURVE_MARGIN = 1.3;

/** のどの長さの下限・上限 [m]。 */
const THROAT_MIN = 40;
const THROAT_MAX = 420;
/** 同じ側の待避線どうしで、本線への取り付き点をずらす量 [m]。 */
const THROAT_STAGGER = 25;
/** 短くしていくときの縮め率。 */
const THROAT_SHRINK = 1.3;
/** 高架とみなす、地形からの浮き [m]。 */
const ELEVATED_RISE = 6;

export interface StationRetrofitSpec {
  name: string;
  length: StationLength;
  trackCount: number;
  platformCount: number;
  /** 取り込む既設線と、その上の駅の中心。 */
  adopt: { segment: SegmentId; s: number };
  /** 既設線を何番目の番線にするか (0 … trackCount-1)。 */
  trackIndex: number;
  /** 中心線の向きを既設線と逆にする (駅舎と待避線が反対側に来る)。 */
  reversed: boolean;
}

/** 取り込む区間の 1 セグメントぶん。`s1 < s0` なら逆向きに辿る。 */
interface SpanPart {
  segment: SegmentId;
  s0: number;
  s1: number;
}

/** 待避線 1 本の片端を本線に繋ぐ計画。 */
interface ThroatPlan {
  index: number;
  /** 駅のどちら側か (`false` = 中心線の始点側)。 */
  atEnd: boolean;
  /** 駅端から本線を辿る距離 [m]。 */
  reach: number;
}

/** 増設する番線 1 本。`spread` は取り込んだ線からの横距 [m]。 */
interface ExtraTrack {
  index: number;
  alignment: Alignment;
  spread: number;
}

/** 中心線と、そこから決まる番線の線形。 */
interface Layout {
  path: Alignment;
  extras: ExtraTrack[];
}

/**
 * 立案の結果。
 *
 * `plan` が null なのは区間すら割り出せなかったとき (線路の端を越えた、途中に
 * 分岐があるなど)。そのときもプレビューは出せないが、理由は出せる。
 */
export interface StationRetrofitResult {
  plan: StationRetrofitPlan | null;
  blockers: string[];
  places: Vector3[];
}

export interface StationRetrofitPlan {
  spec: StationRetrofitSpec;
  /** 取り込む区間。 */
  parts: SpanPart[];
  /** 取り込んだ線路の線形 (駅の向きに揃えたもの)。 */
  adopted: Alignment;
  path: Alignment;
  layout: PlannedStationLayout;
  elevated: boolean;
  extras: ExtraTrack[];
  throats: ThroatPlan[];
  /** プレビュー用の駅 (id = 0、構内線はまだ無い)。 */
  preview: Station;
  blockers: string[];
  /** 置けない理由の場所。赤い印を出すのに使う。 */
  places: Vector3[];
}

/** その線形に駅を後付けできるか (指した相手の見分け)。 */
export function isAdoptable(network: Network, segment: SegmentId): boolean {
  const seg = network.segments.get(segment);
  if (!seg) return false;
  if (seg.stationTrack || seg.stationThroat !== undefined) return false;
  return network.classOf(seg).kind === 'rail';
}

/** 既設の線路に駅を置く計画を立てる。ネットワークは変更しない。 */
export function planStationRetrofit(
  network: Network,
  spec: StationRetrofitSpec,
  field?: Heightfield,
): StationRetrofitResult {
  const seed = network.segments.get(spec.adopt.segment);
  if (!seed || !isAdoptable(network, spec.adopt.segment)) {
    return { plan: null, blockers: ['ここには駅を置けません'], places: [] };
  }
  const cls = network.classOf(seed);

  const planned = planStationLayout(spec.trackCount, spec.platformCount);
  const layout = spec.reversed ? mirror(planned) : planned;
  const trackIndex = clamp(spec.trackIndex, 0, layout.tracks.length - 1);
  const blockers: string[] = [];
  const places: Vector3[] = [];

  // --- 取り込む区間を割り出す -------------------------------------------
  const half = spec.length / 2;
  const back = walk(network, spec.adopt, half, false, cls);
  const ahead = walk(network, spec.adopt, half, true, cls);
  if ('blocker' in back || 'blocker' in ahead) {
    const failed = 'blocker' in back ? back : (ahead as { blocker: string; at?: Vector3 });
    return { plan: null, blockers: [failed.blocker], places: failed.at ? [failed.at] : [] };
  }

  // 後ろ向きに辿った分を反転して繋ぐと、駅の始点から終点までの順になる。
  const parts: SpanPart[] = [
    ...back.parts.map((part) => ({ segment: part.segment, s0: part.s1, s1: part.s0 })).reverse(),
    ...ahead.parts,
  ];
  const legs = alignmentsOf(network, parts);
  if (legs.length === 0) {
    return { plan: null, blockers: ['駅の範囲を割り出せません'], places: [] };
  }
  const adopted = concat(legs);

  const drift = profileDrift(legs, adopted);
  if (drift > PROFILE_TOLERANCE) {
    blockers.push(
      `駅の範囲で線路の縦断がまとめられません (${drift.toFixed(1)} m ずれます)。` +
        '起伏の少ない区間を選んでください',
    );
    places.push(adopted.sampleAt(adopted.length / 2).pos.clone());
  }

  // --- 中心線と番線 -------------------------------------------------------
  const shaped = deriveLayout(adopted, layout, trackIndex);
  if (!shaped) {
    return { plan: null, blockers: ['駅の線形を作れません'], places: [] };
  }
  const { path, extras } = shaped;

  const width = Math.max(Math.abs(layout.minOffset), Math.abs(layout.maxOffset));
  if (path.horizontal.extremeCurvature(64).minRadius <= width * CURVE_MARGIN) {
    blockers.push('曲線がきつすぎて駅の敷地が内側で折り返します。もっと緩い曲線を選んでください');
    places.push(path.sampleAt(path.length / 2).pos.clone());
  }

  const elevated = field ? rise(path, field) > ELEVATED_RISE : false;
  if (field && buriedDepth(path, field) > TUNNEL_THRESHOLD) {
    blockers.push('トンネル区間には駅を設置できません');
    places.push(path.sampleAt(path.length / 2).pos.clone());
  }

  const preview = previewStation(spec, trackIndex, layout, path, elevated);

  // 敷地に他の線形・駅が掛かっていないか。取り込む区間は当然掛かるので外す。
  blockers.push(
    ...checkStationPlacement(
      network,
      {
        name: spec.name,
        center: preview.center,
        heading: preview.heading,
        length: spec.length,
        trackCount: preview.trackCount,
        platformCount: preview.platformCount,
        elevated,
      },
      { path, ignore: new Set(parts.map((part) => part.segment)), opening: 1 },
    ),
  );

  // --- 待避線を本線に繋げるか --------------------------------------------
  const throats: ThroatPlan[] = [];
  let stagger = 0;
  for (const extra of extras) {
    for (const atEnd of [false, true]) {
      const solved = planThroat(network, cls, path, extra, atEnd, stagger, outerEnd(parts, atEnd));
      if ('blocker' in solved) {
        blockers.push(solved.blocker);
        if (solved.at) places.push(solved.at);
      } else {
        throats.push(solved.plan);
      }
    }
    stagger++;
  }

  const plan: StationRetrofitPlan = {
    spec: { ...spec, trackIndex },
    parts,
    adopted,
    path,
    layout,
    elevated,
    extras,
    throats,
    preview,
    blockers,
    places,
  };
  return { plan, blockers, places };
}

/**
 * 断面を左右反転する。
 *
 * 中心線の向きは既設線に合わせたまま、**横距の符号だけ**を入れ替える。線形の
 * 向きを反転して同じことをすると、駅の前後が入れ替わって「駅の端」の意味が
 * 場所によって変わってしまう。符号を返すだけなら、駅舎と待避線が反対側に
 * 来るだけで、他は何も変わらない。
 */
function mirror(layout: PlannedStationLayout): PlannedStationLayout {
  return {
    tracks: layout.tracks.map((track) => ({ ...track, offset: -track.offset })),
    platforms: layout.platforms.map((platform) => ({ ...platform, offset: -platform.offset })),
    minOffset: -layout.maxOffset,
    maxOffset: -layout.minOffset,
  };
}

/** 中心線と待避線の線形を、取り込んだ線から導く。 */
function deriveLayout(
  adopted: Alignment,
  shape: PlannedStationLayout,
  trackIndex: number,
): Layout | null {
  const hostOffset = shape.tracks[trackIndex].offset;
  const path = parallelAlignment(adopted, 0, adopted.length, -hostOffset);
  if (!path) return null;

  const extras: ExtraTrack[] = [];
  for (const track of shape.tracks) {
    if (track.index === trackIndex) continue;
    // 増設線は中心線ではなく**取り込んだ線から**ずらす。ずらしを 1 回で済ませた
    // 方が誤差が小さく、実際の線間隔もこちらで決まる。
    const spread = track.offset - hostOffset;
    const alignment = parallelAlignment(adopted, 0, adopted.length, spread);
    if (!alignment) return null;
    extras.push({ index: track.index, alignment, spread: Math.abs(spread) });
  }
  return { path, extras };
}

function previewStation(
  spec: StationRetrofitSpec,
  trackIndex: number,
  layout: PlannedStationLayout,
  path: Alignment,
  elevated: boolean,
): Station {
  const middle = path.sampleAt(path.length / 2);
  return {
    id: 0,
    name: spec.name,
    center: middle.pos.clone(),
    heading: Math.atan2(middle.forwardXZ.y, middle.forwardXZ.x),
    length: spec.length,
    trackCount: layout.tracks.length,
    platformCount: layout.platforms.length,
    elevated,
    tracks: layout.tracks.map((track) => ({ ...track, segment: -1 })),
    platforms: layout.platforms,
    minOffset: layout.minOffset,
    maxOffset: layout.maxOffset,
    path,
    adopted: trackIndex,
  };
}

// ------------------------------------------------------------- 区間を辿る

type WalkResult = { parts: SpanPart[] } | { blocker: string; at?: Vector3 };

/**
 * 指した点から、線路を `distance` [m] 辿る。
 *
 * 越えてよいのは**継ぎ目 (枝が 2 本のノード)** だけ。分岐器・交差・他の駅・
 * 種別の変わり目・大きく折れた継ぎ目に当たったら、そこで止めて理由を返す。
 */
function walk(
  network: Network,
  from: { segment: SegmentId; s: number },
  distance: number,
  forward: boolean,
  cls: NetworkClass,
): WalkResult {
  const parts: SpanPart[] = [];
  let segment = from.segment;
  let at = from.s;
  let heading = forward;
  let left = distance;

  for (let guard = 0; guard < 64; guard++) {
    const seg = network.getSegment(segment);
    const length = network.alignmentOf(segment).length;
    const available = heading ? length - at : at;
    if (available >= left) {
      parts.push({ segment, s0: at, s1: heading ? at + left : at - left });
      return { parts };
    }
    parts.push({ segment, s0: at, s1: heading ? length : 0 });
    left -= available;

    const node = heading ? seg.b : seg.a;
    const pos = network.getNode(node).pos.clone();
    const branches = network.branchesAt(node);
    const here = branches.find((branch) => branch.segment === segment);
    const next = branches.find((branch) => branch.segment !== segment);
    if (branches.length < 2 || !here || !next) {
      return { blocker: OUT_OF_TRACK, at: pos };
    }
    if (branches.length > 2) {
      return { blocker: '駅の範囲に分岐があります。分岐のない区間を選んでください', at: pos };
    }
    if (stationAt(network.stations.values(), pos.x, pos.z, 2)) {
      return { blocker: '駅の範囲に別の駅があります', at: pos };
    }
    const nextSeg = network.getSegment(next.segment);
    if (nextSeg.classId !== cls.id) {
      return { blocker: '駅の範囲で線路の種別が変わります', at: pos };
    }
    if (nextSeg.stationTrack || nextSeg.stationThroat !== undefined) {
      return { blocker: '駅の範囲に別の駅があります', at: pos };
    }
    // 継ぎ目の折れ。折れた所を 1 本にまとめるとホームが折れる。
    const deflection = Math.PI - Math.acos(clamp(here.dir.dot(next.dir), -1, 1));
    if (deflection > SEAM_DEFLECTION) {
      return { blocker: '駅の範囲に線路の折れ目があります', at: pos };
    }

    segment = next.segment;
    heading = next.atStart;
    at = heading ? 0 : network.alignmentOf(segment).length;
  }
  return { blocker: '駅の範囲を割り出せません' };
}

const OUT_OF_TRACK =
  '駅の範囲が線路の端を越えています。駅長を短くするか、線路を延ばしてください';

/** 区間の各パートを、辿る向きに揃えた線形にする。 */
function alignmentsOf(network: Network, parts: readonly SpanPart[]): Alignment[] {
  const out: Alignment[] = [];
  for (const part of parts) {
    const leg = parallelAlignment(network.alignmentOf(part.segment), part.s0, part.s1, 0);
    if (leg) out.push(leg);
  }
  return out;
}

/**
 * 区間を 1 本の線形に繋ぐ。
 *
 * 平面は連結ベジエ (`HorizontalCurve` の分割ベジエ) なので、制御点をそのまま
 * 並べるだけで誤差なく繋がる。縦断は両端の高さと勾配で決まる 1 本になる。
 */
function concat(legs: readonly Alignment[]): Alignment {
  const merged = previewFromAlignments(legs);
  return new Alignment(
    merged.horizontal,
    new VerticalProfile(
      merged.start.y,
      merged.end.y,
      merged.startGrade,
      merged.endGrade,
      merged.horizontal.length,
    ),
  );
}

/** まとめた縦断が、元の区間の高さからどれだけ外れるか [m]。 */
function profileDrift(legs: readonly Alignment[], merged: Alignment): number {
  let worst = 0;
  let base = 0;
  for (const leg of legs) {
    const steps = Math.max(1, Math.ceil(leg.length / 5));
    for (let i = 0; i <= steps; i++) {
      const s = (leg.length * i) / steps;
      const want = leg.vertical.yAt(s);
      const got = merged.vertical.yAt(clamp(base + s, 0, merged.length));
      worst = Math.max(worst, Math.abs(want - got));
    }
    base += leg.length;
  }
  return worst;
}

/** 中央での、地形からの浮き [m]。 */
function rise(path: Alignment, field: Heightfield): number {
  const middle = path.sampleAt(path.length / 2).pos;
  return middle.y - field.baseHeightAt(middle.x, middle.z);
}

/** 地形にどれだけ埋まっているか [m]。 */
function buriedDepth(path: Alignment, field: Heightfield): number {
  let worst = 0;
  const steps = Math.max(2, Math.ceil(path.length / 8));
  for (let i = 0; i <= steps; i++) {
    const p = path.sampleAt((path.length * i) / steps).pos;
    worst = Math.max(worst, field.baseHeightAt(p.x, p.z) - p.y);
  }
  return worst;
}

// ----------------------------------------------------------------- のど

type ThroatResult = { plan: ThroatPlan } | { blocker: string; at?: Vector3 };

/**
 * 待避線を本線に繋ぐ、のどの長さを決める。
 *
 * 両端の接線が平行なまま横に `d` ずれる 3 次ベジエの最小半径は `L² / (6d)` に
 * なるので、目標半径 `R` を満たす長さは `L = √(6dR)`。ここを起点に、実際に
 * 線形を解いて規格に収まるまで伸ばす。曲線上では両端の接線が平行でないので
 * この式どおりにはならないが、出発点としては十分に近い。
 */
function planThroat(
  network: Network,
  cls: NetworkClass,
  path: Alignment,
  extra: { index: number; alignment: Alignment; spread: number },
  atEnd: boolean,
  stagger: number,
  from: SpanCursor | null,
): ThroatResult {
  const at = path.sampleAt(atEnd ? path.length : 0).pos;
  if (!from) {
    return { blocker: `待避線 (${extra.index + 1}番線) を本線につなげません`, at: at.clone() };
  }
  // **長い方から試す**。短いと置けはするが、継ぎ目で曲率が飛んで警告が出る。
  let reach = clamp(idealThroat(cls, extra.spread) + stagger * THROAT_STAGGER, THROAT_MIN, THROAT_MAX);
  let last = '曲線が急すぎます';
  for (let attempt = 0; attempt < 6 && reach >= THROAT_MIN; attempt++) {
    const main = mainLineAt(network, from, reach, cls);
    if ('blocker' in main) {
      last = main.blocker;
      reach /= THROAT_SHRINK;
      continue;
    }
    const branch = anchorFromSegment(network, main.segment, main.s);
    const to = throatEnd(extra.alignment, atEnd);
    const preview = computePlacement(branch, to, { straight: false, cls });
    const alignment = new Alignment(
      preview.horizontal,
      new VerticalProfile(
        preview.start.y,
        preview.end.y,
        preview.startGrade,
        preview.endGrade,
        preview.horizontal.length,
      ),
    );
    const check = checkPlacement({ network, cls, alignment, start: branch, end: to });
    if (check.blockers.length === 0) return { plan: { index: extra.index, atEnd, reach } };
    last = check.blockers[0];
    reach /= THROAT_SHRINK;
  }
  return {
    blocker: `待避線 (${extra.index + 1}番線) を本線につなげません: ${last}`,
    at: at.clone(),
  };
}

/**
 * 継ぎ目で曲率が飛ばないのどの長さ [m]。
 *
 * 両端の接線が平行なまま横に `d` ずれる 3 次ベジエは、端の曲率が `6d/L²` に
 * なる。待避線側は直線なので、その値がそのまま継ぎ目の飛びになる。飛びの
 * 上限は `findCurveBreaks` と同じ「縦方向の加速度」で決まるので、そこから
 * 必要な長さ `L = √(6dR)` を出す。`app/demo.ts` の終端駅が横距 2 m に対して
 * 180 m の喉を取っているのと同じ勘定。
 */
function idealThroat(cls: NetworkClass, spread: number): number {
  const speed = (cls.designSpeed / 3.6) * SPEED_FACTOR;
  const radius = Math.max(speed * speed, 1) / CURVE_BREAK_ACCEL;
  return Math.sqrt(6 * Math.max(spread, 0.5) * radius);
}

/**
 * 待避線の端に向かうアンカー。
 *
 * まだノードが無いので線形から組み立てる。枝 1 本のノードに対する
 * `anchorFromNode` と同じ符号 (外向き) に揃える。
 */
function throatEnd(alignment: Alignment, atEnd: boolean): Anchor {
  const sample = alignment.sampleAt(atEnd ? alignment.length : 0);
  const sign = atEnd ? 1 : -1;
  return {
    pos: sample.pos.clone(),
    tangent: sample.forwardXZ.clone().multiplyScalar(sign),
    grade: sample.grade * sign,
    curvature: sample.curvature * sign,
  };
}

/** 本線の上の位置と、そこから駅の外へ向かう向き。 */
interface SpanCursor {
  segment: SegmentId;
  s: number;
  /** 弧長が増える向きが駅の外か。 */
  forward: boolean;
}

/**
 * 駅の端から外へ出る所。
 *
 * 立案のときはまだ本線を切っていないので、取り込む区間の**外側の端**が
 * そのまま出口になる。区間を辿った向きの逆が外向き。
 */
function outerEnd(parts: readonly SpanPart[], atEnd: boolean): SpanCursor | null {
  const part = atEnd ? parts[parts.length - 1] : parts[0];
  if (!part) return null;
  return atEnd
    ? { segment: part.segment, s: part.s1, forward: part.s1 > part.s0 }
    : { segment: part.segment, s: part.s0, forward: part.s0 > part.s1 };
}

/** 駅端から本線を `reach` [m] 辿った所。 */
function mainLineAt(
  network: Network,
  from: SpanCursor,
  reach: number,
  cls: NetworkClass,
): { segment: SegmentId; s: number } | { blocker: string } {
  const step = walk(network, { segment: from.segment, s: from.s }, reach, from.forward, cls);
  if ('blocker' in step) {
    return { blocker: `本線が駅の先に ${Math.round(reach)} m 足りません` };
  }
  const tail = step.parts[step.parts.length - 1];
  return { segment: tail.segment, s: tail.s1 };
}

// --------------------------------------------------------------- 実際に置く

/** 立案どおりに駅を置く。`blockers` があるときは呼ばない。 */
export function applyStationRetrofit(network: Network, plan: StationRetrofitPlan): Station {
  const cls = getClass(network.getSegment(plan.parts[0].segment).classId);
  const id = network.allocateStationId();

  // 1. 既設の区間を切り出して 1 本にまとめ、構内線にする。
  const host = adoptSpan(network, plan, id, cls);
  // 切り出したあとの実際の線形から作り直す。分割の丸め (端から 0.5 m) で
  // 立案時と数十 cm ずれることがあるので、ホームは実物に合わせる。
  const shaped = deriveLayout(host.alignment, plan.layout, plan.spec.trackIndex);
  const path = shaped?.path ?? plan.path;
  const extras = shaped?.extras ?? plan.extras;

  const tracks: StationTrack[] = [
    { ...plan.layout.tracks[plan.spec.trackIndex], segment: host.segment },
  ];

  // 2. 増設する番線。
  const ends = new Map<number, { a: NodeId; b: NodeId }>();
  for (const extra of extras) {
    const a = network.addNode(extra.alignment.sampleAt(0).pos);
    const b = network.addNode(extra.alignment.sampleAt(extra.alignment.length).pos);
    const segment = network.addSegment({
      classId: cls.id,
      a: a.id,
      b: b.id,
      ctrlA: extra.alignment.horizontal.c0,
      ctrlB: extra.alignment.horizontal.c1,
      via: extra.alignment.horizontal.via,
      gradeA: extra.alignment.vertical.m0,
      gradeB: extra.alignment.vertical.m1,
      stationTrack: { station: id, index: extra.index },
    });
    ends.set(extra.index, { a: a.id, b: b.id });
    tracks.push({ ...plan.layout.tracks[extra.index], segment: segment.id });
  }

  // 3. のど。本線は前ののどの分割で ID が変わるので、毎回辿り直す。
  const skip = new Set(tracks.map((track) => track.segment));
  for (const throat of plan.throats) {
    const pair = ends.get(throat.index);
    if (!pair) continue;
    const exit = mainLineExit(network, host.segment, throat.atEnd, skip);
    if (!exit) continue;
    const main = mainLineAt(network, exit, throat.reach, cls);
    if ('blocker' in main) continue;
    const from = anchorFromSegment(network, main.segment, main.s);
    const to = anchorFromNode(network, network.getNode(throat.atEnd ? pair.b : pair.a), cls);
    const result = placeSegment(
      network,
      cls.id,
      from,
      to,
      computePlacement(from, to, { straight: false, cls }),
    );
    const seg = network.segments.get(result.segment);
    if (seg) seg.stationThroat = id;
  }

  tracks.sort((a, b) => a.index - b.index);
  return network.registerStation({
    id,
    name: plan.spec.name,
    path,
    length: plan.spec.length,
    trackCount: plan.layout.tracks.length,
    platformCount: plan.layout.platforms.length,
    elevated: plan.elevated,
    tracks,
    layout: plan.layout,
    adopted: plan.spec.trackIndex,
  });
}

/**
 * 取り込む区間を切り出して、1 本の構内線にする。
 *
 * 両端で本線を分割し、その間にあったセグメントを 1 本に置き換える。区間は
 * 複数のセグメントに跨りうるが、番線はセグメント 1 本しか持てない。平面は
 * 連結ベジエ (`via`) にそのまま入るので、形は誤差なく残る。
 */
function adoptSpan(
  network: Network,
  plan: StationRetrofitPlan,
  id: number,
  cls: NetworkClass,
): { segment: SegmentId; alignment: Alignment } {
  const startAt = plan.adopted.sampleAt(0).pos;
  const endAt = plan.adopted.sampleAt(plan.adopted.length).pos;
  // 分割で ID が変わるので、位置から引き直しながら 1 つずつ切る。
  const a = cutAt(network, startAt);
  const b = cutAt(network, endAt);
  if (a === null || b === null) {
    throw new Error('駅の範囲を切り出せません');
  }

  const between = segmentsBetween(network, a, b);
  if (!between) throw new Error('駅の範囲を切り出せません');
  const alignment = concat(alignmentsOf(network, between));

  for (const part of between) network.removeSegmentOnly(part.segment);
  const keepA = network.nodes.get(a) ?? network.addNode(startAt);
  const keepB = network.nodes.get(b) ?? network.addNode(endAt);

  const segment = network.addSegment({
    classId: cls.id,
    a: keepA.id,
    b: keepB.id,
    ctrlA: alignment.horizontal.c0,
    ctrlB: alignment.horizontal.c1,
    via: alignment.horizontal.via,
    gradeA: alignment.vertical.m0,
    gradeB: alignment.vertical.m1,
    stationTrack: { station: id, index: plan.spec.trackIndex },
  });
  return { segment: segment.id, alignment };
}

/**
 * 構内線の端から、本線側へ出る所。
 *
 * 置いたあとは駅の端がノードになっているので、そこに集まる枝のうち駅の
 * 持ち物でないものが本線。
 */
function mainLineExit(
  network: Network,
  host: SegmentId,
  atEnd: boolean,
  skip: ReadonlySet<SegmentId>,
): SpanCursor | null {
  const seg = network.segments.get(host);
  if (!seg) return null;
  const node = atEnd ? seg.b : seg.a;
  for (const branch of network.branchesAt(node)) {
    if (branch.segment === host || skip.has(branch.segment)) continue;
    const other = network.getSegment(branch.segment);
    if (other.stationTrack || other.stationThroat !== undefined) continue;
    const length = network.alignmentOf(branch.segment).length;
    return {
      segment: branch.segment,
      s: branch.atStart ? 0 : length,
      forward: branch.atStart,
    };
  }
  return null;
}

/** その位置にノードを作る (既にあればそれを使う)。 */
function cutAt(network: Network, pos: Vector3): NodeId | null {
  const node = network.findNodeNear(pos, 1.5);
  if (node) return node.id;
  const hit = network.findSegmentNear(pos, 4, { y: pos.y, tolerance: 6 });
  if (!hit) return null;
  return network.splitSegment(hit.segment, hit.s).id;
}

/**
 * 2 つのノードの間にある区間を、辿る向きつきで返す。
 *
 * 分割のたびにセグメントの ID が変わるので、ID を控えておく代わりに
 * 「繋がり」から引き直す。
 */
function segmentsBetween(network: Network, a: NodeId, b: NodeId): SpanPart[] | null {
  for (const start of network.branchesAt(a)) {
    const parts: SpanPart[] = [];
    let node = a;
    let branch = start;
    for (let guard = 0; guard < 64; guard++) {
      const seg = network.segments.get(branch.segment);
      if (!seg) break;
      const length = network.alignmentOf(seg.id).length;
      const forward = seg.a === node;
      parts.push({ segment: seg.id, s0: forward ? 0 : length, s1: forward ? length : 0 });
      const next = forward ? seg.b : seg.a;
      if (next === b) return parts;
      const onward = network.branchesAt(next).filter((x) => x.segment !== branch.segment);
      if (onward.length !== 1) break;
      node = next;
      branch = onward[0];
    }
  }
  return null;
}
