import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import { UP, type MeshBuilder } from '../core/meshbuilder';
import { RAIL_GAUGE, SURFACE_LIFT, clamp } from '../core/units';
import type { Approach, Junction, TrackConnection } from '../network/junction';
import type { SegmentId } from '../network/network';
import { addBox } from './primitives';
import { RAIL_HEAD_HALF_WIDTH, RAIL_HEIGHT, interpolateSample } from './rail';
import type { RGB } from './surface';
import { RAIL_TOP_TO_BALLAST } from './surface';

/**
 * 分岐器 (ターンアウト) の造作。
 *
 * レールそのものは軌道の描画 (`buildTrack`) が引くもので、ここでは
 * **一切触らない**。分岐器らしく見えるのに足りない金物 —
 * トングレール・転てつ機・クロッシング・ガードレール — を、そのレールの上に
 * 足すだけにする。
 *
 * 部品の位置は、レールを描いたのとまったく同じ点列から採る。線形を引き直すと、
 * 刻みの丸めや道床への持ち上げのぶんだけ、部品だけがレールから浮いたり
 * 沈んだりするため。
 *
 * ## どのレールがどれか
 *
 * トウ (2 進路が重なっている端) から見ると、分岐器のレールは 4 本ある。
 * 分岐側が離れていく向きを「外」とすると、
 *
 * - 基本レール = 各進路の**相手から遠い側**のレール。動かない。
 * - トングレール = 各進路の**相手に近い側**のレール。トウで基本レールに
 *   密着し、そこから離れていく可動部。
 *
 * この 2 本のトングレールは必ず 1 度だけ交差する。中心線どうしが軌間だけ
 * 離れた所で、そこがクロッシング (フログ) になる。
 *
 * ## どこまでが分岐器か
 *
 * 分岐器の造作は交差点の中には収まらない。実物の 1:20 分岐器は 60 m ほど
 * あるし、**接線で分かれる分岐** — 建設ツールが既設の線路から引くと必ず
 * こうなる — では交差点のトリムが 0 になり、そもそも交差点の中が存在しない。
 * そこで進路は「交差点の中の接続曲線 + その先の枝そのもの」を繋いだものと
 * して扱う。枝の点列は `TurnoutOptions.branchPath` で受け取る。
 */

const HALF_GAUGE = RAIL_GAUGE / 2;

/** トングレールのかかと。2 進路の中心線がこれだけ離れた所とする。 */
const BLADE_HEEL_OPENING = 0.35;
/** トングレールの長さ [m] の下限・上限。 */
const BLADE_MIN_LENGTH = 4;
const BLADE_MAX_LENGTH = 11;
/** トングレールを刻む間隔 [m]。 */
const BLADE_STEP = 0.6;
/** 進路をトウから追いかける長さ [m]。実物の 1:20 分岐器がおよそ 60 m。 */
const TURNOUT_REACH = 60;
/** 進路を刻む間隔 [m]。 */
export const TURNOUT_STEP = 1.2;
/**
 * トングレールを基本レールの内側へ寄せる量 [m]。
 *
 * 実物では密着しているが、レールと同じ線に置くと面が重なってちらつく。
 * 頭部の幅ぶんより少し多く寄せて、隙間が見えるようにする。
 */
const BLADE_INSET = 0.085;

/**
 * クロッシングの鋳物が覆う幅 [m] (菱形の短い方の対角線の半分)。
 *
 * 長さではなく幅で決める。交差角が浅いほど鋳物は長くなるが、これは実物も
 * 同じ (1:20 のクロッシングは 5 m 近くある)。長さで決めると、浅い分岐では
 * 幅が数 cm の糸のようになって見えなくなる。
 */
const FROG_HALF_WIDTH = 0.34;
/** クロッシングの鋳物の長さ [m] (交点から各レール方向へ) の下限・上限。 */
const FROG_MIN_REACH = 1.2;
const FROG_MAX_REACH = 6;
/** クロッシングの鋳物の厚み [m]。 */
const FROG_THICKNESS = 0.1;

/** ガードレールの長さの半分 [m] と、走行レールからの内側への離れ [m]。 */
const GUARD_HALF_LENGTH = 1.9;
const GUARD_INSET = 0.11;

/** 転てつ棒を渡す位置 (トウからの距離 [m])。 */
const TIE_BAR_AT = 1.0;
/**
 * 転てつ機を据える位置 (軌道中心からの離れ [m])。
 *
 * 道床の天端が平らなのは軌道中心から 1.7 m まで (`railProfile`) で、その外は
 * 法面になる。一方、車両は幅 2.9 m (半幅 1.45 m) あり、足回りだけは半幅
 * 1.3 m に絞られる。機械は足回りより低く抑えて 1.3 m の外に、標識は板を
 * 細くして 1.45 m の外に収める。
 */
const MACHINE_OFFSET = 1.65;

const BLADE_COLOR: RGB = [0.6, 0.58, 0.56];
const FROG_COLOR: RGB = [0.44, 0.45, 0.5];
const GUARD_COLOR: RGB = [0.42, 0.42, 0.45];
const ROD_COLOR: RGB = [0.3, 0.3, 0.32];
const MACHINE_COLOR: RGB = [0.46, 0.48, 0.5];
const SIGNAL_COLOR: RGB = [0.9, 0.78, 0.2];

/** 転てつ機の箱の大きさ (半径)。低く抑えて車両の足回りをかわす。 */
const MACHINE_HALF = { x: 0.26, y: 0.24, z: 0.42 };

/** トングレール 1 本。 */
export interface TurnoutBlade {
  /** 通る軌道の点列 (先端 → かかと)。 */
  path: AlignmentSample[];
  /** その軌道の中心線からの横距 [m]。 */
  offset: number;
}

/** クロッシング (フログ)。2 本のトングレールが交わる所。 */
export interface TurnoutFrog {
  /** 交点 (レール頭頂面の高さ)。 */
  at: Vector3;
  /** 直進側レールの向き (水平・単位)。 */
  throughDir: Vector3;
  /** 分岐側レールの向き (水平・単位)。 */
  divergingDir: Vector3;
  /** クロッシングに向かい合う基本レールへ置くガードレール。 */
  guards: TurnoutGuard[];
}

/** ガードレール 1 本。 */
export interface TurnoutGuard {
  /** 置く位置の軌道上の点。 */
  sample: AlignmentSample;
  /** その点での横距 [m]。 */
  offset: number;
}

export interface Turnout {
  /** トウ (トングレールの先端)。 */
  toe: Vector3;
  /** トウで見て、分岐側が離れていく向き (右手側なら +1)。 */
  side: 1 | -1;
  /** 直進側・分岐側のトングレール。 */
  blades: TurnoutBlade[];
  /** クロッシング。分岐が浅くて交差点の中で交わらないときは null。 */
  frog: TurnoutFrog | null;
  /** 転てつ棒・転てつ機を据える位置 (直進側の軌道上)。 */
  operator: AlignmentSample;
}

/**
 * 2 本の進路から分岐器の造作を割り出す。
 *
 * どちらの点列も**トウが先頭**で、トウでは重なっていること。分かれていない
 * (一直線の継ぎ目など) 所では null を返す。
 */
export function solveTurnout(
  through: AlignmentSample[],
  diverging: AlignmentSample[],
): Turnout | null {
  if (through.length < 2 || diverging.length < 2) return null;
  const toe = through[0].pos.clone();
  // トウで重なっていない = 同じ枝から分かれていない。分岐器ではない。
  if (toe.distanceTo(diverging[0].pos) > 0.5) return null;

  const span = Math.min(last(through).s, last(diverging).s);
  const opening = bladeHeel(through, diverging, span);
  if (!opening) return null;
  const { heel, side } = opening;

  const blades: TurnoutBlade[] = [
    // 相手に近い側のレール (= トングレール) の、少し内側を通す。
    { path: slice(through, heel), offset: side * (HALF_GAUGE - BLADE_INSET) },
    { path: slice(diverging, heel), offset: -side * (HALF_GAUGE - BLADE_INSET) },
  ];

  const operator = interpolateSample(through, Math.min(TIE_BAR_AT, span))!;
  return { toe, side, blades, frog: solveFrog(through, diverging, side), operator };
}

/**
 * 分岐側が離れていく向きと、トングレールのかかと (先端からの距離 [m])。
 *
 * 2 進路が開ききる前にかかとを切ると、可動部が基本レールに食い込んだままに
 * 見える。開きが `BLADE_HEEL_OPENING` になる所を探し、短すぎ・長すぎない
 * 範囲に収める。開きの**符号**がそのまま分岐の向きになる。
 */
function bladeHeel(
  through: AlignmentSample[],
  diverging: AlignmentSample[],
  span: number,
): { heel: number; side: 1 | -1 } | null {
  let heel = Math.min(BLADE_MAX_LENGTH, span);
  let lateral = 0;
  for (let s = 0; s <= span; s = Math.min(span, s + 0.25)) {
    lateral = lateralAt(through, diverging, s);
    if (Math.abs(lateral) >= BLADE_HEEL_OPENING) {
      heel = s;
      break;
    }
    if (s >= span) break;
  }
  // まったく分かれていない (一直線の継ぎ目など) 所には分岐器はできない。
  if (Math.abs(lateral) < 0.15) return null;
  return {
    heel: clamp(heel, Math.min(BLADE_MIN_LENGTH, span), Math.min(BLADE_MAX_LENGTH, span)),
    side: lateral > 0 ? 1 : -1,
  };
}

/** 弧長 `s` での、直進側から見た分岐側の横距 [m]。 */
function lateralAt(through: AlignmentSample[], diverging: AlignmentSample[], s: number): number {
  const a = interpolateSample(through, s);
  const b = interpolateSample(diverging, s);
  if (!a || !b) return 0;
  return (b.pos.x - a.pos.x) * a.right.x + (b.pos.z - a.pos.z) * a.right.z;
}

/**
 * クロッシングを探す。
 *
 * 2 本のトングレールが平面で交わる所。分岐角が浅いと交点は交差点の外
 * (枝のセグメントの中) へ出てしまう。そこまで追いかけると、実際に描かれた
 * レールとずれた所に鋳物を置くことになるので、見つからなければ置かない。
 */
function solveFrog(
  through: AlignmentSample[],
  diverging: AlignmentSample[],
  side: 1 | -1,
): TurnoutFrog | null {
  const a = railPath(through, side * HALF_GAUGE);
  const b = railPath(diverging, -side * HALF_GAUGE);
  const hit = crossPoint(a, b);
  if (!hit) return null;

  const sa = arcAt(through, hit.i, hit.t);
  const sb = arcAt(diverging, hit.j, hit.u);
  const guardOn = (samples: AlignmentSample[], s: number, offset: number): TurnoutGuard | null => {
    const sample = interpolateSample(samples, s);
    return sample ? { sample, offset } : null;
  };
  const guards = [
    // 向かい合うのは、それぞれの進路の**相手から遠い側** (基本レール)。
    guardOn(through, sa, -side * (HALF_GAUGE - GUARD_INSET)),
    guardOn(diverging, sb, side * (HALF_GAUGE - GUARD_INSET)),
  ].filter((g): g is TurnoutGuard => g !== null);

  return { at: hit.at, throughDir: hit.dirA, divergingDir: hit.dirB, guards };
}

export interface TurnoutOptions {
  /**
   * 枝のセグメントを、ノードから外向きに `distance` [m] たどった点列
   * (先頭がノード側)。**実際にレールを描いたのと同じ線形**を渡すこと。
   */
  branchPath?: (approach: Approach, distance: number) => AlignmentSample[];
  /**
   * そこに転てつ機を据えてよいか。踏切のすぐ脇では、線路の路肩がそのまま
   * 道路の路面になる。据えられないときは転てつ棒だけを描く。
   */
  canPlace?: (x: number, z: number, y: number) => boolean;
}

/** 交差点の中の分岐器を全て作る。 */
export function buildTurnouts(
  mb: MeshBuilder,
  junction: Junction,
  options: TurnoutOptions = {},
): void {
  for (const routes of turnoutRoutes(junction, options)) {
    buildTurnout(mb, routes.through, routes.diverging, options.canPlace);
  }
}

/**
 * 交差点にできる分岐器の、トウを先頭にした進路の組。
 *
 * 分岐器は「2 本以上の進路が同じ枝を共有している所」にできる。共有する枝が
 * トウになる。ダイヤモンドクロッシングのように進路が枝を共有しない所には、
 * 分岐器はできない。
 */
export function turnoutRoutes(
  junction: Junction,
  options: TurnoutOptions = {},
): { through: AlignmentSample[]; diverging: AlignmentSample[] }[] {
  if (junction.approaches[0]?.branch.cls.kind !== 'rail') return [];
  const approachOf = (segment: SegmentId): Approach | undefined =>
    junction.approaches.find((a) => a.branch.segment === segment);

  const out: { through: AlignmentSample[]; diverging: AlignmentSample[] }[] = [];
  for (const toe of junction.approaches) {
    const conns = junction.connections.filter(
      (c) => c.from === toe.branch.segment || c.to === toe.branch.segment,
    );
    if (conns.length < 2) continue;
    // 最も一直線な進路を直進側とし、残りをそれぞれ分岐側として扱う。
    const sorted = [...conns].sort((a, b) => a.deflection - b.deflection);
    const through = routeFromToe(toe, sorted[0], approachOf, options);
    if (!through) continue;
    for (const conn of sorted.slice(1)) {
      const diverging = routeFromToe(toe, conn, approachOf, options);
      if (diverging) out.push({ through, diverging });
    }
  }
  return out;
}

/** ある進路を、トウを先頭にした点列にする。 */
function routeFromToe(
  toe: Approach,
  conn: TrackConnection,
  approachOf: (segment: SegmentId) => Approach | undefined,
  options: TurnoutOptions,
): AlignmentSample[] | null {
  const forward = conn.from === toe.branch.segment;
  const other = approachOf(forward ? conn.to : conn.from);
  if (!other) return null;

  // 線路の交差点には中身が無い (枝の帯がノードまで通っている) ので、
  // 進路はそのまま枝の続きになる。
  const route = rebase(options.branchPath?.(other, TURNOUT_REACH) ?? []);
  return route.length >= 2 ? route : null;
}

/** 弧長の起点を 0 にそろえる。 */
function rebase(samples: AlignmentSample[]): AlignmentSample[] {
  if (samples.length === 0) return samples;
  const s0 = samples[0].s;
  return s0 === 0 ? samples : samples.map((sample) => ({ ...sample, s: sample.s - s0 }));
}

/** 1 組の分岐器を作る (どちらの点列もトウが先頭)。 */
export function buildTurnout(
  mb: MeshBuilder,
  through: AlignmentSample[],
  diverging: AlignmentSample[],
  canPlace?: (x: number, z: number, y: number) => boolean,
): void {
  const turnout = solveTurnout(through, diverging);
  if (!turnout) return;
  for (const blade of turnout.blades) addBlade(mb, blade);
  addOperator(mb, turnout, canPlace);
  if (turnout.frog) addFrog(mb, turnout.frog);
}

/**
 * トングレール。先端で幅 0、かかとでレール 1 本分の幅になる細長い楔。
 *
 * 頭頂面は基本レールよりわずかに下げる。同じ高さにすると、上から見たとき
 * 面が重なってちらつく。
 */
function addBlade(mb: MeshBuilder, blade: TurnoutBlade): void {
  const path = blade.path;
  if (path.length < 2) return;
  const top = -0.012;
  const bottom = -RAIL_HEIGHT * 0.8;
  const rows: number[][] = [];
  const p = new Vector3();
  const n = new Vector3();

  for (let i = 0; i < path.length; i++) {
    const sample = path[i];
    // 先端を尖らせる。根元 1/4 で全幅に達し、あとは普通のレールと同じ幅。
    const w = RAIL_HEAD_HALF_WIDTH * Math.min(1, (i / (path.length - 1)) * 4);
    const section: [number, number][] = [
      [-w, top],
      [w, top],
      [w, bottom],
      [-w, bottom],
    ];
    const row: number[] = [];
    for (let k = 0; k < section.length; k++) {
      const [o, h] = section[k];
      const offset = blade.offset + o;
      p.set(
        sample.pos.x + sample.right.x * offset,
        sample.pos.y + h + SURFACE_LIFT,
        sample.pos.z + sample.right.z * offset,
      );
      if (k < 2) n.set(0, 1, 0);
      else n.set(sample.right.x * Math.sign(o || 1), 0, sample.right.z * Math.sign(o || 1)).normalize();
      row.push(mb.vertex(p, n, k, sample.s, BLADE_COLOR));
    }
    rows.push(row);
  }

  for (let i = 0; i + 1 < rows.length; i++) {
    for (let k = 0; k < 3; k++) {
      mb.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
    }
  }
}

/**
 * 転てつ器まわり — 2 本のトングレールを繋ぐ転てつ棒と、脇に据える転てつ機、
 * その上の転てつ器標識。
 *
 * 遠くから見て「ここが分岐器だ」と分かるのは、実はレールの形ではなく脇に
 * 立つこの標識なので、少し大きめに作る。
 */
function addOperator(
  mb: MeshBuilder,
  turnout: Turnout,
  canPlace?: (x: number, z: number, y: number) => boolean,
): void {
  const sample = turnout.operator;
  const right = sample.right;
  const forward = sample.forward;
  const railTop = sample.pos.y + SURFACE_LIFT;
  const ground = railTop - RAIL_TOP_TO_BALLAST;
  // 転てつ機は、分岐側と反対の基本レールの外に据える (分岐側の外はリードの
  // 曲線が振れる所で、機械を置くと軌道に食い込む)。
  const out = -turnout.side;
  const at = (offset: number, y: number): Vector3 =>
    new Vector3(sample.pos.x + right.x * offset * out, y, sample.pos.z + right.z * offset * out);

  // 転てつ棒。軌間をまたいで 2 本のトングレールを繋ぐ。レール頭頂面より
  // 下に通すので、車両とはぶつからない。
  const rodY = railTop - RAIL_HEIGHT * 0.55;
  addBox(mb, at(0, rodY), right, UP, forward, { x: HALF_GAUGE, y: 0.035, z: 0.07 }, ROD_COLOR);
  const machine = at(MACHINE_OFFSET, ground + MACHINE_HALF.y);
  if (canPlace && !canPlace(machine.x, machine.z, ground)) return;

  // 転てつ機へ渡す連結棒。
  const rodEnd = MACHINE_OFFSET - MACHINE_HALF.x;
  addBox(mb, at((HALF_GAUGE + rodEnd) / 2, rodY), right, UP, forward,
    { x: (rodEnd - HALF_GAUGE) / 2, y: 0.03, z: 0.05 }, ROD_COLOR);

  addBox(mb, machine, right, UP, forward, MACHINE_HALF, MACHINE_COLOR);
  // 転てつ器標識。遠くから見て「ここが分岐器だ」と分かるのは、実はレールの
  // 形ではなく脇に立つこの標識なので、少し大きめに作る。
  const postTop = ground + MACHINE_HALF.y * 2 + 0.64;
  addBox(mb, at(MACHINE_OFFSET, (ground + MACHINE_HALF.y * 2 + postTop) / 2), right, UP, forward,
    { x: 0.05, y: (postTop - ground - MACHINE_HALF.y * 2) / 2, z: 0.05 }, MACHINE_COLOR);
  addBox(mb, at(MACHINE_OFFSET, postTop + 0.18), right, UP, forward,
    { x: 0.18, y: 0.2, z: 0.03 }, SIGNAL_COLOR);
}

/**
 * クロッシングの鋳物と、向かい合うガードレール。
 *
 * 実物のフランジ溝や鼻端はこの縮尺では見えないので、2 本のレールが交わる
 * 範囲を 1 枚の鋳物で覆った形にする。レールは鋳物の上に出る。
 */
function addFrog(mb: MeshBuilder, frog: TurnoutFrog): void {
  const top = frog.at.y - 0.02;
  // 2 本のレールが作る角の深さから、鋳物の長さを決める。
  const cross = Math.abs(frog.throughDir.x * frog.divergingDir.z - frog.throughDir.z * frog.divergingDir.x);
  const reach = clamp(FROG_HALF_WIDTH / Math.max(cross, 1e-3), FROG_MIN_REACH, FROG_MAX_REACH);
  const corner = (a: number, b: number): Vector3 =>
    new Vector3(
      frog.at.x + frog.throughDir.x * a + frog.divergingDir.x * b,
      top,
      frog.at.z + frog.throughDir.z * a + frog.divergingDir.z * b,
    );
  // 交わる 2 本のレールの向きで張った菱形。交点のまわりを覆う。
  addPlate(
    mb,
    [
      corner(reach, 0),
      corner(0, reach),
      corner(-reach, 0),
      corner(0, -reach),
    ],
    FROG_THICKNESS,
    FROG_COLOR,
  );

  for (const guard of frog.guards) {
    const { sample, offset } = guard;
    const center = new Vector3(
      sample.pos.x + sample.right.x * offset,
      sample.pos.y + SURFACE_LIFT - 0.02 - RAIL_HEIGHT * 0.42,
      sample.pos.z + sample.right.z * offset,
    );
    addBox(mb, center, sample.right, UP, sample.forward,
      { x: RAIL_HEAD_HALF_WIDTH * 1.4, y: RAIL_HEIGHT * 0.42, z: GUARD_HALF_LENGTH }, GUARD_COLOR);
  }
}

/** 水平な多角形の板 (下向きに厚みを付ける)。 */
function addPlate(mb: MeshBuilder, top: Vector3[], thickness: number, color: RGB): void {
  const n = top.length;
  const down = new Vector3(0, -1, 0);
  const upper = top.map((p) => mb.vertex(p, UP, 0, 0, color));
  const lower = top.map((p) =>
    mb.vertex(new Vector3(p.x, p.y - thickness, p.z), down, 0, 0, color),
  );
  for (let i = 1; i + 1 < n; i++) {
    mb.triangle(upper[0], upper[i], upper[i + 1]);
    mb.triangle(lower[0], lower[i + 1], lower[i]);
  }
  const side = new Vector3();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = top[i];
    const b = top[j];
    side.set(b.z - a.z, 0, -(b.x - a.x));
    if (side.lengthSq() < 1e-12) continue;
    side.normalize();
    const base = mb.vertexCount;
    mb.vertex(a, side, 0, 0, color);
    mb.vertex(b, side, 1, 0, color);
    mb.vertex(new Vector3(b.x, b.y - thickness, b.z), side, 1, 1, color);
    mb.vertex(new Vector3(a.x, a.y - thickness, a.z), side, 0, 1, color);
    mb.quad(base, base + 1, base + 2, base + 3);
  }
}

/** 中心線から一定の横距にあるレールの通り (頭頂面の高さ)。 */
function railPath(samples: AlignmentSample[], offset: number): Vector3[] {
  return samples.map(
    (s) =>
      new Vector3(
        s.pos.x + s.right.x * offset,
        s.pos.y + SURFACE_LIFT,
        s.pos.z + s.right.z * offset,
      ),
  );
}

interface PolylineCross {
  at: Vector3;
  /** 交わった区間の添字と、その中での位置 (0..1)。 */
  i: number;
  t: number;
  j: number;
  u: number;
  /** それぞれの折れ線の向き (水平・単位)。 */
  dirA: Vector3;
  dirB: Vector3;
}

/** 2 本の折れ線が水平面で交わる最初の点。 */
function crossPoint(a: Vector3[], b: Vector3[]): PolylineCross | null {
  for (let i = 0; i + 1 < a.length; i++) {
    for (let j = 0; j + 1 < b.length; j++) {
      const hit = segmentCross(a[i], a[i + 1], b[j], b[j + 1]);
      if (!hit) continue;
      return {
        at: a[i].clone().lerp(a[i + 1], hit.t),
        i,
        t: hit.t,
        j,
        u: hit.u,
        dirA: flatDir(a[i], a[i + 1]),
        dirB: flatDir(b[j], b[j + 1]),
      };
    }
  }
  return null;
}

function segmentCross(
  p1: Vector3,
  p2: Vector3,
  p3: Vector3,
  p4: Vector3,
): { t: number; u: number } | null {
  const rx = p2.x - p1.x;
  const rz = p2.z - p1.z;
  const sx = p4.x - p3.x;
  const sz = p4.z - p3.z;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const qx = p3.x - p1.x;
  const qz = p3.z - p1.z;
  const t = (qx * sz - qz * sx) / denom;
  const u = (qx * rz - qz * rx) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

function flatDir(a: Vector3, b: Vector3): Vector3 {
  const d = new Vector3(b.x - a.x, 0, b.z - a.z);
  return d.lengthSq() < 1e-12 ? new Vector3(0, 0, 1) : d.normalize();
}

/** 折れ線の区間位置を弧長に直す。 */
function arcAt(samples: AlignmentSample[], i: number, t: number): number {
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];
  return a.s + (b.s - a.s) * t;
}

/** 先頭から `to` [m] までを刻み直した点列。 */
function slice(samples: AlignmentSample[], to: number): AlignmentSample[] {
  const count = Math.max(2, Math.ceil(to / BLADE_STEP));
  const out: AlignmentSample[] = [];
  for (let i = 0; i <= count; i++) {
    const sample = interpolateSample(samples, (i / count) * to);
    if (sample) out.push(sample);
  }
  return out;
}

/** 点列を逆向きにする (トウを先頭にするのに使う)。 */
export function reverseSamples(samples: AlignmentSample[]): AlignmentSample[] {
  const total = samples[samples.length - 1].s;
  return samples
    .map((s) => ({
      s: total - s.s,
      pos: s.pos.clone(),
      forward: s.forward.clone().negate(),
      forwardXZ: s.forwardXZ.clone().negate(),
      right: s.right.clone().negate(),
      curvature: -s.curvature,
      grade: -s.grade,
      roll: -(s.roll ?? 0),
    }))
    .reverse();
}

function last<T>(items: T[]): T {
  return items[items.length - 1];
}
