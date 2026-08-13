import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import type { MeshBuilder } from '../core/meshbuilder';
import { PROP_MAX_RISE, SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import { addBox, addWire } from './primitives';
import { interpolateSample } from './rail';
import type { RGB } from './surface';

/**
 * 路側の設備 (電柱と架空配電線)。
 *
 * 配電線は**途切れさせない**。電柱を建てられない所 (橋・トンネル・線路の
 * 架線・他の線形と支障する所) では、その手前で地中に引き込み、向こう側で
 * また立ち上げる。地上に線が無くても電力網としては繋がったままにする。
 */

const CONCRETE: RGB = [0.66, 0.65, 0.62];
const CONCRETE_DARK: RGB = [0.52, 0.51, 0.49];
const WIRE: RGB = [0.14, 0.14, 0.16];
const INSULATOR: RGB = [0.34, 0.36, 0.38];
const TRANSFORMER: RGB = [0.46, 0.45, 0.44];
const CABLE_HEAD: RGB = [0.3, 0.31, 0.33];
const HANDHOLE: RGB = [0.55, 0.55, 0.54];

/** 電柱を建てる間隔 [m]。 */
export const POLE_PITCH = 38;
/** 電柱の高さ [m]。 */
const POLE_HEIGHT = 9.4;
/** 腕金の高さ (足元から)。 */
const ARM_HEIGHTS = [POLE_HEIGHT - 0.7, POLE_HEIGHT - 1.75];
/** 腕金の半長 [m]。 */
const ARM_HALF = 0.85;
/** 架線を張る横位置 (腕金上の位置)。 */
const WIRE_OFFSETS = [-0.62, 0, 0.62];

/** 建てる場所が決まった電柱。 */
export interface PolePlan {
  /** 通し番号 (間隔の格子上の位置)。飛んだ番号は建てられなかった所。 */
  index: number;
  /** 線形上の弧長 [m]。 */
  station: number;
  /** 足元の位置。 */
  base: Vector3;
  /** 腕金の伸びる向き (道路を横切る向き)。 */
  across: Vector3;
  /** 道路の進行方向。 */
  along: Vector3;
}

/** 電柱の間の配電線。 */
export interface PowerSpan {
  a: PolePlan;
  b: PolePlan;
  /** 地中に潜る区間か。 */
  underground: boolean;
}

export interface PolePlanOptions {
  /** その地点に立ててよいか (他の線形・交差点・構造物と重ならないか)。 */
  canPlace: (x: number, z: number, y: number) => boolean;
  /** 足元の地面の高さ。 */
  groundY: (x: number, z: number, surfaceY: number) => number;
  pitch?: number;
}

/**
 * 線形に沿って電柱の位置を決める。
 *
 * 建てられない所は飛ばすが、通し番号 (`index`) は進めるので、呼び出し側は
 * 番号の飛びから「ここは地中に入る」と判断できる。
 */
export function planUtilityPoles(
  samples: AlignmentSample[],
  cls: NetworkClass,
  options: PolePlanOptions,
): PolePlan[] {
  if (cls.kind !== 'road' || cls.sidewalkWidth < 1.0 || samples.length < 2) return [];

  // 切土の法面の上には建てない。建てられない所は飛ばして地中で繋げばよい
  // (橋・トンネルと同じ)。放っておくと電線が法面を突き抜ける。
  const usable = (pos: Vector3, ground: number): boolean =>
    ground <= pos.y + PROP_MAX_RISE && options.canPlace(pos.x, pos.z, ground);

  const pitch = options.pitch ?? POLE_PITCH;
  const s0 = samples[0].s;
  const total = samples[samples.length - 1].s - s0;
  if (total < 12) return [];

  // 区間を等分して置く。端に寄せて置くと、セグメントの継ぎ目で間隔が
  // 詰まったり空いたりして目立つ。
  const offset = cls.halfWidth - 0.55;
  const count = Math.max(1, Math.round(total / pitch));
  const stations: number[] = [];
  for (let i = 0; i < count; i++) stations.push(s0 + (total * (i + 0.5)) / count);

  // 電柱は片側にまとめて建てる。塞がっていない候補が多い方を選ぶ。
  let side = -1;
  let bestFree = -1;
  for (const candidate of [-1, 1]) {
    let free = 0;
    for (const s of stations) {
      const p = positionAt(samples, s, offset * candidate);
      if (!p) continue;
      // 足元の高さで判定する。路面の高さで問うと、隣の盛土の上に
      // 乗ってしまう場所を「空いている」と誤って答えてしまう。
      const ground = options.groundY(p.pos.x, p.pos.z, p.pos.y);
      if (usable(p.pos, ground)) free++;
    }
    if (free > bestFree) {
      bestFree = free;
      side = candidate;
    }
  }
  if (bestFree <= 0) return [];

  const poles: PolePlan[] = [];
  stations.forEach((station, index) => {
    const placed = positionAt(samples, station, offset * side);
    if (!placed) return;
    const ground = options.groundY(placed.pos.x, placed.pos.z, placed.pos.y);
    if (!usable(placed.pos, ground)) return;
    poles.push({
      index,
      station,
      base: new Vector3(placed.pos.x, ground - 0.15, placed.pos.z),
      across: placed.sample.right.clone().multiplyScalar(side).setY(0).normalize(),
      along: placed.sample.forward.clone().setY(0).normalize(),
    });
  });
  return poles;
}

function positionAt(
  samples: AlignmentSample[],
  s: number,
  offset: number,
): { pos: Vector3; sample: AlignmentSample } | null {
  const sample = interpolateSample(samples, s);
  if (!sample) return null;
  const pos = new Vector3(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y + SURFACE_LIFT,
    sample.pos.z + sample.right.z * offset,
  );
  return { pos, sample };
}

/** 電柱と配電線を作る。 */
export function buildPowerLine(mb: MeshBuilder, poles: PolePlan[], spans: PowerSpan[]): void {
  // 地中に入る端の柱には、腕金から足元まで引き下げる管を付ける。
  const risers = new Set<PolePlan>();
  for (const span of spans) {
    if (!span.underground) continue;
    risers.add(span.a);
    risers.add(span.b);
  }

  poles.forEach((pole, serial) => addPole(mb, pole, serial, risers.has(pole)));
  for (const span of spans) {
    if (span.underground) continue;
    addSpanWires(mb, span.a, span.b);
  }
}

function addPole(mb: MeshBuilder, pole: PolePlan, serial: number, riser: boolean): void {
  const up = new Vector3(0, 1, 0);
  const { base, across, along } = pole;

  // 支柱。上に行くほど細くなるので 2 段に分ける。
  addBox(
    mb,
    base.clone().add(new Vector3(0, POLE_HEIGHT * 0.25, 0)),
    across,
    up,
    along,
    { x: 0.15, y: POLE_HEIGHT * 0.25, z: 0.15 },
    CONCRETE,
  );
  addBox(
    mb,
    base.clone().add(new Vector3(0, POLE_HEIGHT * 0.72, 0)),
    across,
    up,
    along,
    { x: 0.11, y: POLE_HEIGHT * 0.23, z: 0.11 },
    CONCRETE,
  );

  for (const height of ARM_HEIGHTS) {
    addBox(
      mb,
      base.clone().add(new Vector3(0, height, 0)),
      across,
      up,
      along,
      { x: ARM_HALF, y: 0.06, z: 0.06 },
      CONCRETE_DARK,
    );
    for (const offset of WIRE_OFFSETS) {
      addBox(
        mb,
        base
          .clone()
          .add(new Vector3(0, height + 0.16, 0))
          .addScaledVector(across, offset),
        across,
        up,
        along,
        { x: 0.07, y: 0.1, z: 0.07 },
        INSULATOR,
      );
    }
  }

  // 3 本に 1 本は柱上変圧器を載せる。
  if (serial % 3 === 1) {
    addBox(
      mb,
      base
        .clone()
        .add(new Vector3(0, POLE_HEIGHT - 3.1, 0))
        .addScaledVector(across, 0.36),
      across,
      up,
      along,
      { x: 0.3, y: 0.42, z: 0.3 },
      TRANSFORMER,
    );
  }

  if (riser) addRiser(mb, pole);
}

/**
 * 地中への引き込み。腕金の高さから足元まで管を下ろし、根元に
 * ハンドホール (点検口) を置く。ここから先は地中線として繋がっている。
 */
function addRiser(mb: MeshBuilder, pole: PolePlan): void {
  const up = new Vector3(0, 1, 0);
  const top = ARM_HEIGHTS[ARM_HEIGHTS.length - 1] + 0.3;
  addBox(
    mb,
    pole.base
      .clone()
      .add(new Vector3(0, top / 2, 0))
      .addScaledVector(pole.across, -0.22),
    pole.across,
    up,
    pole.along,
    { x: 0.09, y: top / 2, z: 0.09 },
    CABLE_HEAD,
  );
  addBox(
    mb,
    pole.base.clone().add(new Vector3(0, 0.06, 0)).addScaledVector(pole.along, 0.9),
    pole.across,
    up,
    pole.along,
    { x: 0.45, y: 0.06, z: 0.32 },
    HANDHOLE,
  );
}

/** 2 本の電柱の間に配電線を張る。 */
function addSpanWires(mb: MeshBuilder, a: PolePlan, b: PolePlan): void {
  const sag = Math.min(0.5, 0.12 + a.base.distanceTo(b.base) * 0.006);
  for (const height of ARM_HEIGHTS) {
    for (const offset of WIRE_OFFSETS) {
      const from = a.base
        .clone()
        .add(new Vector3(0, height + 0.26, 0))
        .addScaledVector(a.across, offset);
      const to = b.base
        .clone()
        .add(new Vector3(0, height + 0.26, 0))
        .addScaledVector(b.across, offset);
      addWire(mb, from, to, sag, 0.025, WIRE);
    }
  }
}
