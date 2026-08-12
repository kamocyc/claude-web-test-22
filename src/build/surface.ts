import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import { MeshBuilder, extrudeSkirt } from '../core/meshbuilder';
import { GRADING_MARGIN, SURFACE_LIFT, SURFACE_SKIRT, TERRAIN_CELL } from '../core/units';
import type { NetworkClass } from '../network/classes';

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
  return [
    { offset: -hw, height: curb, color: SIDEWALK },
    { offset: -cw, height: curb, color: CURB },
    { offset: -cw, height: 0, color: CURB },
    { offset: cw, height: 0, color: surface },
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

/** 横断面上の 1 点をワールド座標に展開する。 */
export function profilePointAt(
  sample: AlignmentSample,
  offset: number,
  height: number,
  out = new Vector3(),
): Vector3 {
  return out.set(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y + height + SURFACE_LIFT,
    sample.pos.z + sample.right.z * offset,
  );
}

export interface RibbonOptions {
  /** 外周に垂れ壁を付けるか (地表区間では地形との隙間を隠すために必要)。 */
  skirt: boolean;
  /** 診断色に使う規格値。 */
  cls: NetworkClass;
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
    const gradeRisk = Math.abs(sample.grade) / cls.maxGrade;
    const radius = Math.abs(sample.curvature) > 1e-6 ? 1 / Math.abs(sample.curvature) : Infinity;
    const curveRisk = radius > 1e6 ? 0 : cls.minRadius / radius;
    const row: number[] = [];
    for (let k = 0; k < profile.length; k++) {
      const p = profile[k];
      profilePointAt(sample, p.offset, p.height, pos);
      // 法線は隣の断面点との向きから求める。端では片側だけを見る。
      const prev = profile[Math.max(0, k - 1)];
      const next = profile[Math.min(profile.length - 1, k + 1)];
      across
        .set(
          sample.right.x * (next.offset - prev.offset),
          next.height - prev.height,
          sample.right.z * (next.offset - prev.offset),
        )
        .normalize();
      normal.crossVectors(across, sample.forward).normalize();
      row.push(
        mb.vertex(pos, normal, p.offset * 0.12, sample.s * 0.12, p.color, gradeRisk, curveRisk),
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
    buildEdgeSkirt(mb, samples, profile[0], -1);
    buildEdgeSkirt(mb, samples, profile[profile.length - 1], 1);
  }
}

/** 帯の外側の縁に沿って垂れ壁を作る。 */
function buildEdgeSkirt(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  edge: ProfilePoint,
  side: number,
): void {
  const top = new Vector3();
  const normal = new Vector3();
  const color: RGB = [0.3, 0.28, 0.26];
  let prevTop = -1;
  let prevBottom = -1;
  for (const sample of samples) {
    profilePointAt(sample, edge.offset, edge.height, top);
    normal.set(sample.right.x * side, 0, sample.right.z * side).normalize();
    const t = mb.vertex(top, normal, 0, sample.s * 0.1, color);
    const b = mb.vertex(
      new Vector3(top.x, top.y - SURFACE_SKIRT, top.z),
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
  return -(profile[0].height + SURFACE_LIFT - 0.05);
}

/**
 * 交差点面の高さ (線形 Y からのオフセット)。
 * 道路は車道面そのもの、線路は道床の天端になる。
 */
export function junctionSurfaceOffset(cls: NetworkClass): number {
  return cls.kind === 'rail' ? -RAIL_TOP_TO_BALLAST : 0;
}

/**
 * 交差点まわりの整地目標。道路の交差点は歩道がなく車道面が端まで続くので、
 * セグメントとは違って車道面のすぐ下を狙う。
 */
export function junctionGradingDrop(cls: NetworkClass): number {
  return cls.kind === 'rail' ? gradingDrop(cls) : 0.05;
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
