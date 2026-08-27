import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import {
  MeshBuilder,
  extrudeSkirt,
  extrudeSkirtTo,
  fillPolygon,
} from '../core/meshbuilder';
import { GRADING_MARGIN, SURFACE_LIFT, SURFACE_SKIRT, TERRAIN_CELL } from '../core/units';
import type { NetworkClass } from '../network/classes';
import { pointRisk } from '../network/validation';

export type RGB = readonly [number, number, number];

/** 横断面上の 1 点。`offset` は中心線からの横距離 (右が正)、`height` は路面基準の高さ。 */
export interface ProfilePoint {
  offset: number;
  height: number;
  color: RGB;
}

const SIDEWALK: RGB = [0.62, 0.61, 0.58];
const CURB: RGB = [0.72, 0.71, 0.68];
const BALLAST: RGB = [0.38, 0.35, 0.32];
const BALLAST_SIDE: RGB = [0.32, 0.29, 0.26];

/** 道路の横断面。中央が車道、外側が一段高い歩道。 */
export function roadProfile(cls: NetworkClass): ProfilePoint[] {
  const cw = cls.carriagewayHalfWidth;
  const hw = cls.halfWidth;
  const surface = cls.surfaceColor;
  if (cls.sidewalkWidth <= 0) {
    return [
      { offset: -hw, height: 0, color: surface },
      { offset: hw, height: 0, color: surface },
    ];
  }
  const curb = cls.curbHeight;
  // 縁石の立ち上がり面の下端で色を切り替える。1 点で兼ねると、車道の帯が
  // 「縁石の色 → 舗装の色」のグラデーションになってしまう。
  return [
    { offset: -hw, height: curb, color: SIDEWALK },
    { offset: -cw, height: curb, color: CURB },
    { offset: -cw, height: 0, color: CURB },
    { offset: -cw, height: 0, color: surface },
    { offset: cw, height: 0, color: surface },
    { offset: cw, height: 0, color: CURB },
    { offset: cw, height: curb, color: CURB },
    { offset: hw, height: curb, color: SIDEWALK },
  ];
}

/**
 * 線形の Y は「レール頭頂面 (レールレベル)」を表す。踏切で道路面と直接
 * 突き合わせられるようにするためで、道床の天端はその下になる。
 */
export const RAIL_TOP_TO_BALLAST = 0.32;
const BALLAST_TOE = RAIL_TOP_TO_BALLAST + 0.55;

/** 線路の横断面。天端が道床、外側が法面。 */
export function railProfile(cls: NetworkClass): ProfilePoint[] {
  const hw = cls.halfWidth;
  const top = Math.max(...cls.tracks.map(Math.abs)) + 1.7;
  return [
    { offset: -hw, height: -BALLAST_TOE, color: BALLAST_SIDE },
    { offset: -top, height: -RAIL_TOP_TO_BALLAST, color: BALLAST },
    { offset: top, height: -RAIL_TOP_TO_BALLAST, color: BALLAST },
    { offset: hw, height: -BALLAST_TOE, color: BALLAST_SIDE },
  ];
}

export function profileFor(cls: NetworkClass): ProfilePoint[] {
  return cls.kind === 'rail' ? railProfile(cls) : roadProfile(cls);
}

/**
 * 横断面上の 1 点をワールド座標に展開する。
 * サンプルが横断勾配を持っていれば (踏切) 断面ごと傾ける。
 */
export function profilePointAt(
  sample: AlignmentSample,
  offset: number,
  height: number,
  out = new Vector3(),
): Vector3 {
  return out.set(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y + height + SURFACE_LIFT + offset * (sample.roll ?? 0),
    sample.pos.z + sample.right.z * offset,
  );
}

export interface RibbonOptions {
  /** 外周に垂れ壁を付けるか (地表区間では地形との隙間を隠すために必要)。 */
  skirt: boolean;
  /**
   * 断面の高さ (縁石・歩道の段差) に掛ける係数。踏切のまわりで 0 に近づけ、
   * 路面を平らにするのに使う。
   */
  heightScale?: (s: number) => number;
  /** 診断色に使う規格値。 */
  cls: NetworkClass;
  /** 整地後の地形の高さ。垂れ壁を地面まで届かせるのに使う。 */
  groundY?: GroundQuery;
  /** 系統ごとの色分け。指定すると断面の色をこの色に寄せる。 */
  tint?: RGB;
}

/**
 * 系統の色を混ぜる。断面の明暗 (歩道・縁石・車道) は残したいので、
 * 明るさだけ元の色から借りる。
 */
export function applyTint(color: RGB, tint?: RGB): RGB {
  if (!tint) return color;
  const luma = 0.3 * color[0] + 0.6 * color[1] + 0.1 * color[2];
  const k = 0.45 + luma * 0.9;
  return [
    Math.min(1, tint[0] * k),
    Math.min(1, tint[1] * k),
    Math.min(1, tint[2] * k),
  ];
}

/** 整地後の地形の高さを引く関数。 */
export type GroundQuery = (x: number, z: number) => number;

/**
 * 垂れ壁を伸ばす上限 [m]。
 *
 * 盛土の路面は、隣に別の線形の整地された回廊があると、そちらの高さまで
 * 法面を伸ばせない (相手の回廊は守られる)。その段差を閉じるのは垂れ壁の
 * 役目なので、盛土として成立する高さ (橋にする閾値) では足りない。
 * 上限は「そこまで下りても穴が開くよりまし」という安全弁として置く。
 */
const MAX_SKIRT = 30;

/**
 * 垂れ壁の下端。地形まで届かせることで、勾配差の大きい交差点や
 * 取り付き部でも路面の下に穴が開かない。
 */
function skirtBottom(x: number, y: number, z: number, ground?: GroundQuery): number {
  const base = y - SURFACE_SKIRT;
  if (!ground) return base;
  return Math.max(y - MAX_SKIRT, Math.min(base, ground(x, z) - 0.2));
}

/**
 * 線形サンプル列と横断面から帯状のメッシュを作る。
 *
 * 法線は「横断方向 × 進行方向」で求めるので、縁石のような垂直面でも
 * 正しく横を向く。
 */
export function buildRibbon(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  profile: ProfilePoint[],
  options: RibbonOptions,
): void {
  if (samples.length < 2 || profile.length < 2) return;

  const cls = options.cls;
  const rows: number[][] = [];
  const pos = new Vector3();
  const across = new Vector3();
  const normal = new Vector3();

  for (const sample of samples) {
    // 頂点ごとの規格比 (診断色のもと)。HUD の数値と同じ式を使う。
    const { gradeRisk, curveRisk } = pointRisk(sample.curvature, sample.grade, cls);
    const scale = options.heightScale?.(sample.s) ?? 1;
    const row: number[] = [];
    for (let k = 0; k < profile.length; k++) {
      const p = profile[k];
      profilePointAt(sample, p.offset, p.height * scale, pos);
      // 法線は隣の断面点との向きから求める。端では片側だけを見る。
      const prev = profile[Math.max(0, k - 1)];
      const next = profile[Math.min(profile.length - 1, k + 1)];
      across
        .set(
          sample.right.x * (next.offset - prev.offset),
          (next.height - prev.height) * scale,
          sample.right.z * (next.offset - prev.offset),
        )
        .normalize();
      normal.crossVectors(across, sample.forward).normalize();
      row.push(
        mb.vertex(
          pos,
          normal,
          p.offset * 0.12,
          sample.s * 0.12,
          applyTint(p.color, options.tint),
          gradeRisk,
          curveRisk,
        ),
      );
    }
    rows.push(row);
  }

  for (let k = 0; k + 1 < profile.length; k++) {
    for (let i = 0; i + 1 < rows.length; i++) {
      mb.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
    }
  }

  if (options.skirt) {
    buildEdgeSkirt(mb, samples, profile[0], -1, options.groundY, options.heightScale);
    buildEdgeSkirt(
      mb,
      samples,
      profile[profile.length - 1],
      1,
      options.groundY,
      options.heightScale,
    );
  }
}

/** 帯の外側の縁に沿って垂れ壁を作る。 */
function buildEdgeSkirt(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  edge: ProfilePoint,
  side: number,
  ground?: GroundQuery,
  heightScale?: (s: number) => number,
): void {
  const top = new Vector3();
  const normal = new Vector3();
  const color: RGB = [0.3, 0.28, 0.26];
  let prevTop = -1;
  let prevBottom = -1;
  for (const sample of samples) {
    profilePointAt(sample, edge.offset, edge.height * (heightScale?.(sample.s) ?? 1), top);
    normal.set(sample.right.x * side, 0, sample.right.z * side).normalize();
    const t = mb.vertex(top, normal, 0, sample.s * 0.1, color);
    const b = mb.vertex(
      new Vector3(top.x, skirtBottom(top.x, top.y, top.z, ground), top.z),
      normal,
      1,
      sample.s * 0.1,
      color,
    );
    if (prevTop >= 0) {
      if (side > 0) mb.quad(prevTop, t, b, prevBottom);
      else mb.quad(prevTop, prevBottom, b, t);
    }
    prevTop = t;
    prevBottom = b;
  }
}

/**
 * 整地に使う footprint (路面より少し広い帯) の断面幅。
 * 格子の解像度より広く取ることで、路端で地形が路面より上に出ないようにする。
 */
export function gradingHalfWidth(cls: NetworkClass): number {
  return cls.halfWidth + Math.max(GRADING_MARGIN, TERRAIN_CELL * 1.5);
}

/**
 * 整地の目標高さを線形の Y からのオフセットで返す。
 * 断面の最も外側の高さに合わせるので、地形は路端 (歩道の外側、道床の法尻)
 * とちょうど繋がる。
 */
export function gradingDrop(cls: NetworkClass): number {
  const profile = profileFor(cls);
  return dropForHeight(profile[0].height);
}

/** 断面の高さ `h` に地形を合わせるときの、線形 Y からの下げ量。 */
function dropForHeight(h: number): number {
  return -(h + SURFACE_LIFT - 0.05);
}

/** 整地用の断面上の 1 点。 */
export interface GradingPoint {
  offset: number;
  /** 合わせる断面の高さ (路面基準)。踏切では段差を潰した高さになる。 */
  height: number;
}

/**
 * 整地の断面。
 *
 * 路端の高さに揃えるだけだと、道路のように**中央が低い断面**では車道が
 * 地形に埋まってしまう (歩道の高さで整地された地面が、縁石の分だけ車道より
 * 高くなる)。逆に線路のように**中央が高い断面**では、道床は地面の上に
 * 載っているのが正しいので、法尻の高さで平らに均す。
 *
 * そこで「断面が路端より低い所はそこまで下げ、高い所は路端の高さのまま」
 * という規則にする。車道の縁は格子 1 マス分だけ内側で切り替え、量子化で
 * 地形が縁石より高く出ないようにする。
 */
export function gradingSection(cls: NetworkClass): GradingPoint[] {
  const profile = profileFor(cls);
  const half = gradingHalfWidth(cls);
  const outer = profile[0].height;
  const low = Math.min(...profile.map((p) => p.height));
  if (low >= outer - 1e-6) {
    return [
      { offset: -half, height: outer },
      { offset: half, height: outer },
    ];
  }

  const lowHalf = Math.max(
    ...profile.filter((p) => p.height <= low + 1e-6).map((p) => Math.abs(p.offset)),
  );
  const edge = Math.min(lowHalf + TERRAIN_CELL, cls.halfWidth - 0.2);
  return [
    { offset: -half, height: outer },
    { offset: -edge, height: outer },
    { offset: -edge + 0.6, height: low },
    { offset: edge - 0.6, height: low },
    { offset: edge, height: outer },
    { offset: half, height: outer },
  ];
}

/** 整地用の断面を、サンプル位置でワールド座標に展開する。 */
export function gradingSectionPoints(
  sample: AlignmentSample,
  section: GradingPoint[],
  extraDrop = 0,
  heightScale = 1,
): Vector3[] {
  const roll = sample.roll ?? 0;
  return section.map(
    (p) =>
      new Vector3(
        sample.pos.x + sample.right.x * p.offset,
        sample.pos.y - dropForHeight(p.height * heightScale) - extraDrop + p.offset * roll,
        sample.pos.z + sample.right.z * p.offset,
      ),
  );
}

/**
 * 交差点面を作る。`rings` は断面の点ごとのリング (外側から内側の順) で、
 * セグメント側の帯と同じ断面を通っているので継ぎ目が開かない。
 *
 * いちばん内側のリングを車道 (線路では道床天端) として塗り、外側との間は
 * 歩道・縁石・法面の帯で埋める。
 */
export function buildJunctionSurface(
  mb: MeshBuilder,
  rings: Vector3[][],
  cls: NetworkClass,
  /** 辺 i が「枝の口」か。ここには歩道・縁石・垂れ壁を作らない。 */
  openEdge: boolean[],
  ground?: GroundQuery,
  tint?: RGB,
): void {
  if (rings.length === 0 || rings[0].length < 3) return;
  const profile = profileFor(cls);
  const lifted = rings.map((ring) => ring.map((p) => new Vector3(p.x, p.y + SURFACE_LIFT, p.z)));
  const closed = (i: number): boolean => !openEdge[i];
  // リング k はセグメント側の断面点 k と同じ高さ・同じ色。いちばん内側の
  // 面に `cls.surfaceColor` を使うと、線路では道床の色 (BALLAST) と
  // わずかに食い違って、交差点だけ色が違って見える。
  const colorAt = (k: number): RGB =>
    applyTint(profile[Math.min(k, profile.length - 1)].color, tint);

  fillPolygon(mb, lifted[lifted.length - 1], colorAt(lifted.length - 1), 0.12, 0);
  for (let k = 0; k + 1 < lifted.length; k++) {
    // 帯はセグメント側と同じように、内外の断面色を繋いだ階調にする。
    buildRingBand(mb, lifted[k], lifted[k + 1], colorAt(k), colorAt(k + 1), closed);
  }
  // 外周の垂れ壁は地面まで届かせる。勾配の違う枝が集まる交差点では、
  // 隅で 2〜3 m の段差ができることがあり、固定長では隠しきれない。
  extrudeSkirtTo(
    mb,
    lifted[0],
    lifted[0].map((p) => skirtBottom(p.x, p.y, p.z, ground)),
    SKIRT_COLOR,
    true,
    closed,
  );
}

const SKIRT_COLOR: RGB = [0.3, 0.28, 0.26];


/** 同じ頂点数の 2 本のリングの間を帯で埋める。 */
function buildRingBand(
  mb: MeshBuilder,
  outer: Vector3[],
  inner: Vector3[],
  outerColor: RGB,
  innerColor: RGB,
  include: (i: number) => boolean = () => true,
): void {
  const n = Math.min(outer.length, inner.length);
  if (n < 3) return;
  const centroid = new Vector3();
  for (const p of outer) centroid.add(p);
  centroid.divideScalar(outer.length);

  for (let i = 0; i < n; i++) {
    if (!include(i)) continue;
    const j = (i + 1) % n;
    const quad = [outer[i], outer[j], inner[j], inner[i]];
    const colors = [outerColor, outerColor, innerColor, innerColor];
    const geometric = newellNormal(quad);
    if (geometric.lengthSq() < 1e-14) continue;
    const normal = orientBandNormal(geometric.clone().normalize(), outer[i], centroid);
    // 面の向き (表裏) は頂点の並び順で決まるので、法線に合わせて並べ直す。
    const flip = geometric.dot(normal) < 0;
    const ordered = flip ? [quad[3], quad[2], quad[1], quad[0]] : quad;
    const tones = flip ? [colors[3], colors[2], colors[1], colors[0]] : colors;
    const base = mb.vertexCount;
    for (let k = 0; k < 4; k++) {
      mb.vertex(ordered[k], normal, k & 1, k >> 1, tones[k]);
    }
    mb.quad(base, base + 1, base + 2, base + 3);
  }
}

function newellNormal(points: Vector3[]): Vector3 {
  const n = new Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n;
}

/**
 * 帯の法線を表向きに揃える。ほぼ水平な面 (歩道・法面) は上向き、
 * 垂直な面 (縁石) は交差点の内側 = 車道から見える向きにする。
 */
function orientBandNormal(n: Vector3, at: Vector3, centroid: Vector3): Vector3 {
  if (Math.abs(n.y) > 0.2) return n.y < 0 ? n.negate() : n;
  const toCenter = new Vector3(centroid.x - at.x, 0, centroid.z - at.z);
  return n.dot(toCenter) < 0 ? n.negate() : n;
}

/**
 * 交差点まわりの整地目標。リングの Y は既に断面の高さを含んでいるので、
 * セグメントと同じく「路端のわずかに下」を狙えばよい。
 */
export function junctionGradingDrop(): number {
  return -(SURFACE_LIFT - 0.05);
}

/** 整地用に、路面よりわずかに低い高さで帯の左右端を返す。 */
export function gradingEdges(
  sample: AlignmentSample,
  halfWidth: number,
  drop = 0.06,
): { left: Vector3; right: Vector3 } {
  const y = sample.pos.y - drop;
  return {
    left: new Vector3(
      sample.pos.x - sample.right.x * halfWidth,
      y,
      sample.pos.z - sample.right.z * halfWidth,
    ),
    right: new Vector3(
      sample.pos.x + sample.right.x * halfWidth,
      y,
      sample.pos.z + sample.right.z * halfWidth,
    ),
  };
}

/** リングを法線方向に押し出した垂れ壁を積む (交差点面の縁用)。 */
export function ringSkirt(mb: MeshBuilder, ring: Vector3[], color: RGB): void {
  extrudeSkirt(mb, ring, SURFACE_SKIRT, color);
}
