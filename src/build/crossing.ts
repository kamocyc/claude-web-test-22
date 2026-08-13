import { Vector3 } from 'three';
import type { Alignment, AlignmentSample } from '../core/alignment';
import type { MeshBuilder } from '../core/meshbuilder';
import { UP } from '../core/meshbuilder';
import { MARKING_LIFT, SURFACE_LIFT, clamp, smoothstep } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Crossing } from '../network/crossings';
import type { SegmentId } from '../network/network';
import type { RGB } from './surface';

const PANEL: RGB = [0.44, 0.44, 0.45];

/** 踏切パネルの、線路中心からの余裕 [m]。 */
const PANEL_MARGIN = 1.6;
/** 遮断機を線路から離す距離 [m]。 */
const GATE_STANDOFF = 1.6;
/** レール高さを道路面に馴染ませる区間の長さ [m]。 */
export const RAIL_BLEND_HALF_LENGTH = 9;
/**
 * 舗装面からレール頭頂面を出す量 [m]。
 * 踏切パネルとの差が小さすぎると Z ファイティングでレールが点線になる。
 */
const RAILHEAD_PROUD = 0.05;

/** 線路側の描画高さを局所的にずらす指定。 */
export interface RailBlend {
  /** 線路の弧長 [m]。 */
  s: number;
  /** この地点で加える高さ [m]。 */
  deltaY: number;
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
 * 舗装は道路側が優先で、線路側は道床が舗装の下に隠れる。レールだけは
 * 舗装からわずかに頭を出すよう、線路の描画高さを道路面に寄せる。
 */
export interface LevelCrossingOptions {
  /** 遮断機を置いてよい場所か (線路や他の道路と重ならないか)。 */
  canPlace?: (x: number, z: number) => boolean;
  /** 足元の地面の高さ。 */
  groundY?: (x: number, z: number, surfaceY: number) => number;
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
  const rail = crossing.rail!;
  const canPlace = options.canPlace ?? (() => true);
  const groundY = options.groundY ?? ((_x, _z, surfaceY) => surfaceY);

  // 道路と線路のなす角。斜め踏切ではパネルが道路方向に長くなる。
  const sinTheta = Math.abs(road.dir.x * rail.dir.y - road.dir.y * rail.dir.x);
  const skew = 1 / Math.max(0.26, sinTheta);
  const halfLength = clamp(railClass.halfWidth * skew + PANEL_MARGIN, 2.5, 40);

  const sRoad0 = road.s - halfLength;
  const sRoad1 = road.s + halfLength;

  paintPanel(mb, roadPath, sRoad0, sRoad1, roadClass);

  const gates: GateSpec[] = [];
  const stopStations: { segment: SegmentId; s: number; forward: boolean }[] = [];
  const gateOffset = roadClass.halfWidth + 0.5;
  const boomLength = roadClass.carriagewayHalfWidth + 0.8;

  for (const forward of [true, false]) {
    // forward = true は弧長が増える向きに走る車。左側通行では自車線は
    // 進行方向の左 = 断面オフセットが負の側。
    const side = forward ? -1 : 1;
    // 線路や他の道路に当たる場合は、踏切から遠ざかる向きに置き直す。
    let placed: { base: Vector3; sample: RoadSample; distance: number } | null = null;
    for (const extra of [0, 1.5, 3, 5]) {
      const distance = halfLength + GATE_STANDOFF + extra;
      const sample = roadPath.sampleAt(forward ? road.s - distance : road.s + distance);
      if (!sample) continue;
      const x = sample.pos.x + sample.right.x * side * gateOffset;
      const z = sample.pos.z + sample.right.z * side * gateOffset;
      if (!canPlace(x, z)) continue;
      placed = {
        base: new Vector3(x, groundY(x, z, sample.pos.y + roadClass.curbHeight), z),
        sample,
        distance,
      };
      break;
    }
    if (!placed) continue;

    const sample = placed.sample;
    const across = sample.right.clone().multiplyScalar(-side);
    const facing = sample.forward.clone().multiplyScalar(forward ? -1 : 1).setY(0).normalize();
    gates.push({ base: placed.base, across, facing, length: boomLength });

    // 停止線は遮断機の少し手前。ノードを跨いだ場合はその先のセグメントに引く。
    const stopDistance = placed.distance + 0.8;
    const stop = roadPath.sampleAt(forward ? road.s - stopDistance : road.s + stopDistance);
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
 * 踏切に合わせた線路側の高さ補正を求める。
 * メッシュを作らずに済むよう、整地より前の段階で単独に呼べるようにしている。
 */
export function computeRailBlend(
  crossing: Crossing,
  roadAlignment: Alignment,
): RailBlend & { segment: SegmentId } {
  const road = crossing.road!;
  const rail = crossing.rail!;
  const roadY = roadAlignment.sampleAt(road.s).pos.y;
  return {
    segment: rail.segment,
    s: rail.s,
    deltaY: roadY + RAILHEAD_PROUD - crossing.point.y,
    halfLength: RAIL_BLEND_HALF_LENGTH,
  };
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
    const l = mb.vertex(
      new Vector3(sample.pos.x - sample.right.x * hw, y, sample.pos.z - sample.right.z * hw),
      UP,
      0,
      i,
      PANEL,
    );
    const r = mb.vertex(
      new Vector3(sample.pos.x + sample.right.x * hw, y, sample.pos.z + sample.right.z * hw),
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
 * 踏切に合わせて線路の描画高さを局所的にずらす。
 *
 * 線形データ自体は変えず、描画用のサンプル列だけを補正する。踏切の
 * 許容高低差は 0.25 m なので、緩衝区間 9 m で 3% 未満の勾配にしかならない。
 */
export function applyRailBlend(samples: AlignmentSample[], blends: RailBlend[]): AlignmentSample[] {
  if (blends.length === 0) return samples;
  return samples.map((sample) => {
    let delta = 0;
    for (const blend of blends) {
      const t = Math.abs(sample.s - blend.s) / blend.halfLength;
      if (t >= 1) continue;
      delta += blend.deltaY * (1 - smoothstep(t));
    }
    if (delta === 0) return sample;
    return { ...sample, pos: new Vector3(sample.pos.x, sample.pos.y + delta, sample.pos.z) };
  });
}
