import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import type { MeshBuilder } from '../core/meshbuilder';
import { SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import { addBox, addWire } from './primitives';
import { interpolateSample } from './rail';
import type { RGB } from './surface';

/**
 * 路側の設備 (電柱と架空配電線)。
 *
 * 交差点・踏切・他の線形と重ならない所だけに立てる。判定は呼び出し側から
 * 渡される `canPlace` に任せ、ここでは形状だけを作る。
 */

const CONCRETE: RGB = [0.66, 0.65, 0.62];
const CONCRETE_DARK: RGB = [0.52, 0.51, 0.49];
const WIRE: RGB = [0.14, 0.14, 0.16];
const INSULATOR: RGB = [0.34, 0.36, 0.38];
const TRANSFORMER: RGB = [0.46, 0.45, 0.44];

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

export interface UtilityPoleOptions {
  /** その地点に立ててよいか (他の線形・交差点と重ならないか)。 */
  canPlace: (x: number, z: number, y: number) => boolean;
  /** 足元の地面の高さ。整地後の地形と路肩の高い方を返すこと。 */
  groundY: (x: number, z: number, surfaceY: number) => number;
  pitch?: number;
  /** 通し番号の起点。区間をまたいで柱上変圧器の位置が揃うようにする。 */
  serial?: number;
}

export interface UtilityPole {
  /** 足元の位置。 */
  base: Vector3;
  /** 腕金の伸びる向き (道路を横切る向き)。 */
  across: Vector3;
  /** 線路・道路の進行方向。 */
  along: Vector3;
}

/**
 * 線形に沿って電柱を建て、隣り合う柱の間に配電線を張る。
 * 建てられた電柱の一覧を返す (検証・デバッグ用)。
 */
export function buildUtilityPoles(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  options: UtilityPoleOptions,
): UtilityPole[] {
  if (cls.kind !== 'road' || cls.sidewalkWidth < 1.0 || samples.length < 2) return [];

  const pitch = options.pitch ?? POLE_PITCH;
  const s0 = samples[0].s;
  const total = samples[samples.length - 1].s - s0;
  if (total < 12) return [];

  // 電柱は片側にまとめて建てる。塞がっていない候補が多い方を選ぶ。
  const offset = cls.halfWidth - 0.55;
  // 区間を等分して置く。端に寄せて置くと、セグメントの継ぎ目で間隔が
  // 詰まったり空いたりして目立つ。
  const count = Math.max(1, Math.round(total / pitch));
  const stations: number[] = [];
  for (let i = 0; i < count; i++) stations.push(s0 + (total * (i + 0.5)) / count);

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
      if (options.canPlace(p.pos.x, p.pos.z, ground)) free++;
    }
    if (free > bestFree) {
      bestFree = free;
      side = candidate;
    }
  }
  if (bestFree <= 0) return [];

  const poles: UtilityPole[] = [];
  // 配電線は、間に建てられなかった所があれば張らない (道路を斜めに横切る
  // 電線ができてしまうため)。
  let previous: { pole: UtilityPole; station: number } | null = null;
  let serial = options.serial ?? 0;

  for (const s of stations) {
    const placed = positionAt(samples, s, offset * side);
    const groundY = placed
      ? options.groundY(placed.pos.x, placed.pos.z, placed.pos.y)
      : 0;
    if (!placed || !options.canPlace(placed.pos.x, placed.pos.z, groundY)) {
      previous = null;
      serial++;
      continue;
    }
    const base = new Vector3(placed.pos.x, groundY - 0.15, placed.pos.z);
    const across = placed.sample.right.clone().multiplyScalar(side).setY(0).normalize();
    const along = placed.sample.forward.clone().setY(0).normalize();
    const pole: UtilityPole = { base, across, along };

    addPole(mb, pole, serial);
    if (previous && s - previous.station < pitch * 2) {
      addSpanWires(mb, previous.pole, pole);
    }
    poles.push(pole);
    previous = { pole, station: s };
    serial++;
  }

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

function addPole(mb: MeshBuilder, pole: UtilityPole, serial: number): void {
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
}

/** 2 本の電柱の間に配電線を張る。 */
function addSpanWires(mb: MeshBuilder, a: UtilityPole, b: UtilityPole): void {
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
      addWire(mb, from, to, 0.35, 0.025, WIRE);
    }
  }
}
