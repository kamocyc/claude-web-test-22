import { Vector2, Vector3 } from 'three';
import type { Alignment, AlignmentSample } from '../core/alignment';
import type { MeshBuilder } from '../core/meshbuilder';
import { UP } from '../core/meshbuilder';
import { MARKING_LIFT, RAIL_GAUGE, SURFACE_LIFT, clamp, smoothstep } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Crossing } from '../network/crossings';
import type { SegmentId } from '../network/network';
import { RAIL_HEAD_HALF_WIDTH } from './rail';
import type { RGB } from './surface';

const PANEL: RGB = [0.44, 0.44, 0.45];

/** 踏切パネルの、線路中心からの余裕 [m]。 */
const PANEL_MARGIN = 1.6;
/** 遮断機を線路から離す距離 [m]。 */
const GATE_STANDOFF = 1.6;
/**
 * 舗装面をレール頭頂面より下げる量 [m]。
 * 差が小さすぎると Z ファイティングでレールが点線になる。
 */
export const PAVEMENT_BELOW_RAILHEAD = 0.06;
/** 舗装を線路に合わせた分を、道路の本来の高さへ戻すのにかける最短距離 [m]。 */
const BLEND_RAMP = 14;
/**
 * すり付けで道路の勾配に足してよい量。
 *
 * 戻す距離を固定にすると、変形が大きいほど繋ぎ目が急になり、踏切の前後に
 * こぶができる。逆に**変形の大きさに応じて距離を伸ばせば**、勾配の足し前は
 * 一定に保てる。実物の踏切も、急な道路では前後を長く取り直して線路の面に
 * すり付ける。重み関数 (smoothstep) の傾きは平均の 1.5 倍まで立つので、
 * その分を見込んで長さを決める。
 */
const RAMP_SLOPE = 0.06;
const RAMP_PEAK = 1.5;
/** すり付けにかけてよい距離の上限 [m]。 */
const MAX_RAMP = 60;
/**
 * 踏切に合わせて道路を持ち上げ / 下げてよい量 [m]。
 *
 * 交差角が浅く道路の勾配が急な踏切ほど、線路の面に合わせるのに道路を
 * 大きく変形させることになる。`MAX_RAMP` の距離を使ってもすり付けが
 * `RAMP_SLOPE` に収まらない量が上限で、それを超える配置は `rules.ts` が
 * そもそも禁止する。
 */
export const MAX_CROSSING_LIFT = (MAX_RAMP * RAMP_SLOPE) / RAMP_PEAK;
/**
 * これを超える変形は、道路の縦断を目に見えて作り直すことになる [m]。
 * 敷設は止めないが、そうなっていることを警告で知らせる。
 */
export const GENTLE_CROSSING_LIFT = 0.8;

/**
 * 描画高さを局所的にずらす指定。
 *
 * 踏切では**線路を動かさず、道路の方を線路に合わせる**。列車は舗装より上に
 * 出ていないと走れないし、線路は道路よりはるかに勾配・線形の自由度が低い。
 * 道路側は多少きつい勾配を飲んでもよい、という優先順位にしている。
 *
 * 高さの補正は中心線の上下 (`deltaY`, `slope`) だけでは足りない。線路が
 * 勾配を持って斜めに横切ると、舗装の幅の中でレール頭頂面が上下するので、
 * 断面を横に傾ける (`roll`) 必要がある。
 */
export interface SurfaceBlend {
  /** 基準となる弧長 [m]。 */
  s: number;
  /**
   * 基準点での**目標の路面高さ** [m]。
   *
   * 「線形の高さからの差」ではなく絶対値で持つ。踏切が近接したとき、差で
   * 平均するとどちらの線路の高さにも合わない面ができてしまう。目標の高さ
   * で平均すれば、同じ高さの線路が 2 本並んでいれば路面はその高さで平らに
   * なる (実際の複線の踏切と同じ)。
   */
  targetY: number;
  /** 目標面の、道路の弧長方向の勾配。 */
  targetSlope: number;
  /**
   * 道路自身の縦断勾配。
   *
   * `core` の外では、目標面をこの勾配で伸ばす (道路と平行に走らせる)。
   * 線路の面をどこまでも伸ばすと、平坦部から離れるほど目標が道路から
   * 離れていき、戻す量が距離とともに増える。すり付けを長く取っても
   * 繋ぎ目が急なままになるのはそのためで、実物の踏切の形 (線路に合わせた
   * 平坦部 + 元の勾配に戻すすり付け) とも合わない。
   */
  roadGrade: number;
  /** 横断勾配。中心線から右へ 1 m につき上がる量。 */
  roll: number;
  /** 補正を全量かける範囲 (片側) [m]。舗装が線路に接している範囲。 */
  core: number;
  /** ここまでで補正を 0 に戻す [m]。 */
  halfLength: number;
}

export interface GateSpec {
  base: Vector3;
  across: Vector3;
  facing: Vector3;
  length: number;
}

/**
 * 道路上の 1 点。踏切がセグメントの端に来ることがあるので、隣の
 * セグメントまで辿れるようにしてある。
 */
export interface RoadSample {
  pos: Vector3;
  right: Vector3;
  forward: Vector3;
  segment: SegmentId;
  s: number;
  /** 横断勾配 (踏切で線路に合わせて傾けた分)。 */
  roll: number;
}

/** 弧長で道路をたどる手段。範囲外はノードを越えて隣のセグメントを返す。 */
export interface RoadPath {
  sampleAt(s: number): RoadSample | null;
}

export interface LevelCrossingBuild {
  /** 道路の弧長で見た踏切の範囲。 */
  sRoad0: number;
  sRoad1: number;
  gates: GateSpec[];
  /** 停止線を引く位置。 */
  stopStations: { segment: SegmentId; s: number; forward: boolean }[];
}

/**
 * 踏切 1 箇所分の形状を組み立てる。
 *
 * 高さは線路が優先で、道路の方が線路に合わせて上下・傾斜する
 * (`computeCrossingBlend`)。舗装はレール頭頂面より少し低い所に来るので、
 * 道床と枕木は舗装の下に隠れ、レールだけが頭を出す。
 */
export interface LevelCrossingOptions {
  /**
   * 舗装を敷く道路の弧長の範囲。複線を渡る踏切のように、複数の交差を
   * 1 か所の踏切としてまとめるときに渡す。省略すると交差 1 つぶん。
   */
  span?: { s0: number; s1: number };
  /** 遮断機を置いてよい場所か (線路や他の道路と重ならないか)。 */
  canPlace?: (x: number, z: number, y: number) => boolean;
  /** 足元の地面の高さ。 */
  groundY?: (x: number, z: number, surfaceY: number) => number;
  /**
   * その地点の構造形式。橋の上では床版の外に地面がないので、遮断機を
   * 高欄の内側に寄せる。トンネルの中には立てない。
   */
  modeAt?: (sample: RoadSample) => 'ground' | 'bridge' | 'tunnel';
}

export function buildLevelCrossing(
  mb: MeshBuilder,
  crossing: Crossing,
  roadPath: RoadPath,
  roadClass: NetworkClass,
  railClass: NetworkClass,
  options: LevelCrossingOptions = {},
): LevelCrossingBuild {
  const road = crossing.road!;
  const canPlace = options.canPlace ?? (() => true);
  const groundY = options.groundY ?? ((_x, _z, surfaceY) => surfaceY);

  const halfLength = panelHalfLength(crossing, railClass);
  // まとめた踏切では、いちばん外の線路の外側までが 1 枚の舗装になる。
  const sRoad0 = Math.min(options.span?.s0 ?? Infinity, road.s - halfLength);
  const sRoad1 = Math.max(options.span?.s1 ?? -Infinity, road.s + halfLength);

  paintPanel(mb, roadPath, sRoad0, sRoad1, roadClass);

  const gates: GateSpec[] = [];
  const stopStations: { segment: SegmentId; s: number; forward: boolean }[] = [];
  const modeAt = options.modeAt ?? (() => 'ground' as const);
  const boomLength = roadClass.carriagewayHalfWidth + 0.8;

  for (const forward of [true, false]) {
    // forward = true は弧長が増える向きに走る車。左側通行では自車線は
    // 進行方向の左 = 断面オフセットが負の側。
    const side = forward ? -1 : 1;
    // 線路や他の道路に当たる場合は、踏切から遠ざかる向きに置き直す。
    let placed: { base: Vector3; sample: RoadSample; station: number } | null = null;
    for (const extra of [0, 1.5, 3, 5]) {
      // 遮断機は舗装の外側。まとめた踏切では、線路の間ではなく
      // まとまり全体の外に立つ。
      const station = forward ? sRoad0 - GATE_STANDOFF - extra : sRoad1 + GATE_STANDOFF + extra;
      const sample = roadPath.sampleAt(station);
      if (!sample) continue;

      const mode = modeAt(sample);
      if (mode === 'tunnel') continue;
      const onBridge = mode === 'bridge';
      // 橋の上では高欄の内側に寄せる。歩道の余地がなければ諦める。
      if (onBridge && roadClass.halfWidth - 0.6 <= roadClass.carriagewayHalfWidth + 0.2) continue;
      const offset = onBridge ? roadClass.halfWidth - 0.6 : roadClass.halfWidth + 0.5;

      const x = sample.pos.x + sample.right.x * side * offset;
      const z = sample.pos.z + sample.right.z * side * offset;
      const surfaceY = sample.pos.y + roadClass.curbHeight;
      const baseY = onBridge ? surfaceY : groundY(x, z, surfaceY);
      if (!canPlace(x, z, baseY)) continue;
      placed = { base: new Vector3(x, baseY, z), sample, station };
      break;
    }
    if (!placed) continue;

    const sample = placed.sample;
    const across = sample.right.clone().multiplyScalar(-side);
    const facing = sample.forward.clone().multiplyScalar(forward ? -1 : 1).setY(0).normalize();
    gates.push({ base: placed.base, across, facing, length: boomLength });

    // 停止線は遮断機の少し手前。ノードを跨いだ場合はその先のセグメントに引く。
    const stop = roadPath.sampleAt(placed.station + (forward ? -0.8 : 0.8));
    if (stop) {
      stopStations.push({
        segment: stop.segment,
        s: stop.s,
        // 隣のセグメントでは弧長の向きが反転していることがある。
        forward: sample.forward.dot(stop.forward) >= 0 ? forward : !forward,
      });
    }
  }

  return { sRoad0, sRoad1, gates, stopStations };
}

/**
 * 踏切パネル (舗装が線路に接している範囲) の、道路の弧長で見た半長。
 * 斜め踏切では道路方向に長くなる。
 */
export function panelHalfLength(crossing: Crossing, railClass: NetworkClass): number {
  const road = crossing.road!;
  const rail = crossing.rail!;
  const sinTheta = Math.abs(road.dir.x * rail.dir.y - road.dir.y * rail.dir.x);
  const skew = 1 / Math.max(0.26, sinTheta);
  return clamp(railClass.halfWidth * skew + PANEL_MARGIN, 2.5, 40);
}

/**
 * 踏切に合わせた**道路側**の高さ補正を求める。
 * メッシュを作らずに済むよう、整地より前の段階で単独に呼べるようにしている。
 *
 * 目標は「舗装面がレール頭頂面の `PAVEMENT_BELOW_RAILHEAD` [m] 下を通る」
 * こと。線路が勾配を持っていれば、その面は傾いた平面になるので、道路の
 * 弧長方向の傾き (`slope`) と横断方向の傾き (`roll`) の両方を返す。中心線の
 * 高さだけを合わせると、舗装の幅の中でレールが潜ってしまう。
 */
export function computeCrossingBlend(
  crossing: Crossing,
  railAlignment: Alignment,
  roadAlignment: Alignment,
  /** 線路のカント (横断勾配)。踏切では 0 に戻してあるが、念のため見る。 */
  railRoll = 0,
): SurfaceBlend & { segment: SegmentId; lift: number } {
  const road = crossing.road!;
  const rail = crossing.rail!;
  const railSample = railAlignment.sampleAt(rail.s);
  const roadSample = roadAlignment.sampleAt(road.s);

  // レール頭頂面の勾配ベクトル (水平 1 m あたりの上がり)。縦断勾配だけで
  // なく**横断勾配 (カント) も足す**。線路方向の傾きしか見ないと、カントが
  // 付いている所で舗装が片方のレールに潜り、もう片方から浮く。
  const gradient = new Vector2(railSample.forwardXZ.x, railSample.forwardXZ.y)
    .multiplyScalar(railSample.grade)
    .addScaledVector(new Vector2(railSample.right.x, railSample.right.z), railRoll);
  const forward = roadSample.forwardXZ;
  const right = new Vector2(roadSample.right.x, roadSample.right.z);

  // 補正を全量かける範囲。舗装が線路に接するのは踏切パネルの範囲だが、
  // 斜め踏切では道路の幅の中で線路が道路方向にも進むので、その分も含める。
  // ここを狭くすると、路端に近い所だけ補正が効かずレールが潜る。
  const panel = panelHalfLength(crossing, rail.cls);
  const geometric = Math.min(40, panel + crossingReach(crossing) + 1);

  const targetY = railSample.pos.y - PAVEMENT_BELOW_RAILHEAD;
  const targetSlope = gradient.dot(forward);
  const deltaY = targetY - roadSample.pos.y;
  const slope = targetSlope - roadSample.grade;
  // 変形が大きくなりすぎる所で頭を打たせる。舗装が線路に接している範囲
  // (パネル) だけは、切り詰めるとレールが舗装から出なくなるので残す。
  const budget = Math.max(0, MAX_CROSSING_LIFT - Math.abs(deltaY));
  const limit = Math.abs(slope) > 1e-4 ? budget / Math.abs(slope) : Infinity;
  const core = Math.max(panel, Math.min(geometric, limit));
  // 全量かける範囲の端で、道路の本来の高さからどれだけ離れるか。これを
  // 元に戻すのがすり付けなので、長さもこれで決める。
  const lift = Math.abs(deltaY) + core * Math.abs(slope);
  const ramp = clamp((RAMP_PEAK * lift) / RAMP_SLOPE, BLEND_RAMP, MAX_RAMP);

  return {
    segment: road.segment,
    s: road.s,
    targetY,
    targetSlope,
    roadGrade: roadSample.grade,
    roll: gradient.dot(right),
    core,
    halfLength: core + ramp,
    lift,
  };
}

/**
 * 舗装が線路に接する範囲の、道路の弧長で見た広がり [m]。
 *
 * 斜め踏切では、道路の幅の中で線路が道路方向にも進む。ここを狭くすると
 * 路端に近い所だけ補正が効かず、レールが舗装に潜る。
 */
export function crossingReach(crossing: Crossing): number {
  const road = crossing.road!;
  const rail = crossing.rail!;
  const sin = Math.max(0.26, Math.abs(road.dir.x * rail.dir.y - road.dir.y * rail.dir.x));
  const cos = Math.min(1, Math.abs(road.dir.dot(rail.dir)));
  return road.cls.halfWidth * (cos / sin);
}

const FLANGEWAY: RGB = [0.1, 0.1, 0.11];
/** フランジ溝の幅と、レール頭頂面からの下げ量 [m]。 */
const FLANGEWAY_WIDTH = 0.09;
const FLANGEWAY_DEPTH = 0.045;

/**
 * 踏切のフランジ溝 (レールの内側に開ける車輪のつば用の溝) を描く。
 *
 * レールは舗装から 6 cm ほどしか頭を出さないので、真上から見ると
 * 舗装に紛れてどこが線路か分かりにくい。実物と同じように溝を入れると、
 * 線路が通っていることが一目で分かる。
 */
export function buildFlangeways(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  /**
   * その地点の舗装面の高さ。溝は舗装に開けるものなので、線路ではなく
   * 舗装に載せる。舗装のない所 (踏切の外) では null を返すこと。
   */
  pavementY: (x: number, z: number) => number | null,
): void {
  if (samples.length < 2) return;
  const half = RAIL_GAUGE / 2;
  const tracks = cls.tracks.length > 0 ? cls.tracks : [0];
  for (const track of tracks) {
    for (const side of [-1, 1]) {
      const inner = track + side * (half - RAIL_HEAD_HALF_WIDTH);
      const outer = inner - side * FLANGEWAY_WIDTH;
      paintStrip(
        mb,
        samples,
        Math.min(inner, outer),
        Math.max(inner, outer),
        pavementY,
      );
    }
  }
}

/** 軌道に沿った細い帯 (溝) を舗装の上に敷く。 */
function paintStrip(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  o0: number,
  o1: number,
  pavementY: (x: number, z: number) => number | null,
): void {
  let prevL = -1;
  let prevR = -1;
  for (const sample of samples) {
    const railTop = sample.pos.y + SURFACE_LIFT;
    const at = (offset: number): Vector3 | null => {
      const x = sample.pos.x + sample.right.x * offset;
      const z = sample.pos.z + sample.right.z * offset;
      const pavement = pavementY(x, z);
      if (pavement === null) return null;
      // 舗装がレールから離れている所 (踏切の外) には溝を敷かない。
      const below = railTop - (pavement + SURFACE_LIFT);
      if (below < 0.01 || below > FLANGEWAY_DEPTH * 4) return null;
      return new Vector3(x, pavement + SURFACE_LIFT + MARKING_LIFT, z);
    };
    const left = at(o0);
    const right = at(o1);
    if (!left || !right) {
      prevL = -1;
      prevR = -1;
      continue;
    }
    const l = mb.vertex(left, UP, 0, sample.s, FLANGEWAY);
    const r = mb.vertex(right, UP, 1, sample.s, FLANGEWAY);
    if (prevL >= 0) mb.quad(prevL, prevR, r, l);
    prevL = l;
    prevR = r;
  }
}

/** 踏切パネル (舗装の色違い) を路面に重ねる。 */
function paintPanel(
  mb: MeshBuilder,
  roadPath: RoadPath,
  s0: number,
  s1: number,
  cls: NetworkClass,
): void {
  const hw = cls.carriagewayHalfWidth;
  const steps = Math.max(2, Math.ceil((s1 - s0) / 1.5));
  let prevL = -1;
  let prevR = -1;
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
    const sample = roadPath.sampleAt(s);
    if (!sample) {
      prevL = -1;
      prevR = -1;
      continue;
    }
    const y = sample.pos.y + SURFACE_LIFT + MARKING_LIFT * 0.5;
    // 路面が傾いていれば (勾配のある線路を渡る踏切) パネルも同じだけ傾ける。
    const tilt = sample.roll * hw;
    const l = mb.vertex(
      new Vector3(sample.pos.x - sample.right.x * hw, y - tilt, sample.pos.z - sample.right.z * hw),
      UP,
      0,
      i,
      PANEL,
    );
    const r = mb.vertex(
      new Vector3(sample.pos.x + sample.right.x * hw, y + tilt, sample.pos.z + sample.right.z * hw),
      UP,
      1,
      i,
      PANEL,
    );
    if (prevL >= 0) mb.quad(prevL, prevR, r, l);
    prevL = l;
    prevR = r;
  }
}

/**
 * 踏切に合わせて描画高さを局所的にずらす。
 *
 * 線形データ自体は変えず、描画用のサンプル列だけを補正する。踏切の許容
 * 高低差は 0.25 m なので、緩衝区間 10 m で 3% ほどの勾配が加わるだけで済む。
 */
export function applySurfaceBlend(
  samples: AlignmentSample[],
  blends: SurfaceBlend[],
): AlignmentSample[] {
  if (blends.length === 0) return samples;
  return samples.map((sample) => {
    const { dy, roll } = surfaceBlendAt(blends, sample.s, sample.pos.y);
    if (dy === 0 && roll === 0) return sample;
    return {
      ...sample,
      pos: new Vector3(sample.pos.x, sample.pos.y + dy, sample.pos.z),
      roll: (sample.roll ?? 0) + roll,
    };
  });
}

/**
 * ある弧長での補正量。交差点の断面など、サンプル列を持たない所で使う。
 *
 * 複数の踏切が重なった場合 (複線を斜めに渡るなど) は重みで平均する。
 * 単純に足すと、どちらの線路にも合わない高さになってしまう。
 */
export function surfaceBlendAt(
  blends: SurfaceBlend[],
  s: number,
  /** その弧長での線形の高さ [m]。目標との差が補正量になる。 */
  y: number,
): { dy: number; roll: number } {
  let target = 0;
  let roll = 0;
  let total = 0;
  let strength = 0;
  for (const blend of blends) {
    const w = blendWeight(blend, s);
    if (w <= 0) continue;
    // どれだけ補正を効かせるかは、いちばん強く効いている踏切で決める。
    strength = Math.max(strength, w);
    // 目標の混ぜ方は距離の逆数で重みを付ける。近接した踏切どうしで単純に
    // 平均すると、どちらの線路の高さにも合わない面ができる (高さの違う
    // 線路が並んでいる所では、その間で路面が繋がっていなければならない)。
    const p = w / (0.25 + Math.abs(s - blend.s));
    target += p * levelAt(blend, s);
    roll += p * blend.roll;
    total += p;
  }
  if (total <= 0) return { dy: 0, roll: 0 };
  return { dy: strength * (target / total - y), roll: strength * (roll / total) };
}

/**
 * 断面の段差 (縁石・歩道) を潰す割合。1 = そのまま、0 = 完全に平ら。
 *
 * 踏切では舗装がレール頭頂面のすぐ下を通る。歩道が縁石の分だけ高いままだと、
 * レールが歩道の帯の下に潜って途切れて見えるので、踏切のまわりだけ断面を
 * 平らにする (実際の踏切でも縁石は切り下げられている)。
 */
export function surfaceHeightScale(blends: SurfaceBlend[], s: number): number {
  let w = 0;
  for (const blend of blends) w = Math.max(w, blendWeight(blend, s));
  return 1 - w;
}

/**
 * その弧長での目標の路面高さ。
 *
 * 舗装が線路に接する範囲 (`core`) の中では線路の面そのもの。その外では
 * **道路自身の勾配で伸ばす**ので、道路との差は平坦部の端の値のまま変わらず、
 * あとは重み (`blendWeight`) が距離をかけて 0 に戻すだけになる。線路の面を
 * どこまでも伸ばすと、差が距離に比例して開き続けるため、すり付けをいくら
 * 長くしても繋ぎ目の勾配が緩まない。
 */
function levelAt(blend: SurfaceBlend, s: number): number {
  const d = s - blend.s;
  const inside = clamp(d, -blend.core, blend.core);
  return blend.targetY + blend.targetSlope * inside + blend.roadGrade * (d - inside);
}

/** 補正をどれだけ効かせるか。舗装の下では全量、そこから滑らかに 0 へ戻す。 */
function blendWeight(blend: SurfaceBlend, s: number): number {
  const d = Math.abs(s - blend.s);
  if (d <= blend.core) return 1;
  if (d >= blend.halfLength) return 0;
  return 1 - smoothstep((d - blend.core) / Math.max(1e-6, blend.halfLength - blend.core));
}
