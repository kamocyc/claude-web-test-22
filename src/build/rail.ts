import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import { UP, type MeshBuilder } from '../core/meshbuilder';
import { RAIL_GAUGE, SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import { addBox, addWire } from './primitives';
import type { RGB } from './surface';
import { RAIL_TOP_TO_BALLAST } from './surface';

const RAIL_COLOR: RGB = [0.42, 0.4, 0.42];
const RAIL_HEAD: RGB = [0.68, 0.66, 0.66];
/** 枕木の色。 */
export const SLEEPER_COLOR: RGB = [0.31, 0.26, 0.22];

/** レール頭部の半幅 [m]。踏切のフランジ溝の位置決めにも使う。 */
export const RAIL_HEAD_HALF_WIDTH = 0.035;
const RAIL_HALF_WIDTH = RAIL_HEAD_HALF_WIDTH;
/** レール頭頂面から底面までの高さ [m]。分岐器の部品もこれに揃える。 */
export const RAIL_HEIGHT = 0.15;
/** 枕木を並べる間隔 [m]。 */
export const SLEEPER_PITCH = 0.62;
const SLEEPER_HALF_LENGTH = 1.25;
const SLEEPER_HALF_THICK = 0.11;
const SLEEPER_HALF_WIDTH = 0.13;

/** レール頭頂面から見た枕木上面の高さ。 */
const SLEEPER_TOP = -RAIL_HEIGHT;

/**
 * 線形に沿って軌道 (レールと枕木) を作る。
 *
 * 線形の Y はレール頭頂面なので、レールは Y から下向きに伸ばし、
 * 枕木はさらにその下に置く。
 */
export function buildTrack(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  trackOffsets: number[],
  options: { sleepers: boolean } = { sleepers: true },
): void {
  if (samples.length < 2) return;

  for (const offset of trackOffsets) {
    buildRailPair(mb, samples, offset);
  }
  if (options.sleepers) buildSleepers(mb, samples, trackOffsets);
}

function buildRailPair(mb: MeshBuilder, samples: AlignmentSample[], centerOffset: number): void {
  const half = RAIL_GAUGE / 2;
  buildRail(mb, samples, centerOffset - half);
  buildRail(mb, samples, centerOffset + half);
}

/** 1 本のレールを、頭部と腹部の 2 段の帯で表現する。 */
function buildRail(mb: MeshBuilder, samples: AlignmentSample[], offset: number): void {
  const rows: number[][] = [];
  const p = new Vector3();
  const n = new Vector3();

  // 断面: (横オフセット, 高さ, 色)。上面 → 側面 → 底面の順。
  const section: [number, number, RGB][] = [
    [-RAIL_HALF_WIDTH, 0, RAIL_HEAD],
    [RAIL_HALF_WIDTH, 0, RAIL_HEAD],
    [RAIL_HALF_WIDTH, -RAIL_HEIGHT, RAIL_COLOR],
    [-RAIL_HALF_WIDTH, -RAIL_HEIGHT, RAIL_COLOR],
  ];

  for (const sample of samples) {
    const row: number[] = [];
    // カント (横断勾配) が付いていれば、レールもそのぶん上下する。
    const roll = sample.roll ?? 0;
    for (let k = 0; k < section.length; k++) {
      const [o, h, color] = section[k];
      p.set(
        sample.pos.x + sample.right.x * (offset + o),
        sample.pos.y + h + SURFACE_LIFT + (offset + o) * roll,
        sample.pos.z + sample.right.z * (offset + o),
      );
      // 上 2 点は上向き、下 2 点は外向きの法線にしておくと陰影が出る。
      if (k < 2) n.set(0, 1, 0);
      else n.set(sample.right.x * Math.sign(o), 0, sample.right.z * Math.sign(o)).normalize();
      row.push(mb.vertex(p, n, k, sample.s, color));
    }
    rows.push(row);
  }

  for (let i = 0; i + 1 < rows.length; i++) {
    for (let k = 0; k < section.length - 1; k++) {
      mb.quad(rows[i][k], rows[i][k + 1], rows[i + 1][k + 1], rows[i + 1][k]);
    }
  }
}

function buildSleepers(mb: MeshBuilder, samples: AlignmentSample[], trackOffsets: number[]): void {
  const total = samples[samples.length - 1].s - samples[0].s;
  const count = Math.floor(total / SLEEPER_PITCH);
  const up = new Vector3(0, 1, 0);
  const center = new Vector3();

  for (let i = 0; i <= count; i++) {
    const s = samples[0].s + i * SLEEPER_PITCH;
    const sample = interpolateSample(samples, s);
    if (!sample) continue;
    // カントが付いていれば、まくらぎも軌道面と一緒に傾く。
    const roll = sample.roll ?? 0;
    const tilted =
      roll === 0
        ? sample.right
        : new Vector3(sample.right.x, roll, sample.right.z).normalize();
    const normal =
      roll === 0 ? up : new Vector3().crossVectors(sample.forward, tilted).normalize().negate();
    for (const offset of trackOffsets) {
      center.set(
        sample.pos.x + sample.right.x * offset,
        sample.pos.y + SLEEPER_TOP - SLEEPER_HALF_THICK + SURFACE_LIFT + offset * roll,
        sample.pos.z + sample.right.z * offset,
      );
      addBox(
        mb,
        center,
        tilted,
        normal,
        sample.forward,
        { x: SLEEPER_HALF_LENGTH, y: SLEEPER_HALF_THICK, z: SLEEPER_HALF_WIDTH },
        SLEEPER_COLOR,
      );
    }
  }
}

/** サンプル列を弧長で線形補間する。 */
export function interpolateSample(
  samples: AlignmentSample[],
  s: number,
): AlignmentSample | null {
  if (samples.length === 0) return null;
  if (s <= samples[0].s) return samples[0];
  if (s >= samples[samples.length - 1].s) return samples[samples.length - 1];
  let lo = 0;
  let hi = samples.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].s <= s) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.s - a.s;
  const t = span > 1e-9 ? (s - a.s) / span : 0;
  return {
    s,
    pos: a.pos.clone().lerp(b.pos, t),
    forward: a.forward.clone().lerp(b.forward, t).normalize(),
    forwardXZ: a.forwardXZ.clone().lerp(b.forwardXZ, t).normalize(),
    right: a.right.clone().lerp(b.right, t).normalize(),
    curvature: a.curvature + (b.curvature - a.curvature) * t,
    grade: a.grade + (b.grade - a.grade) * t,
    roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * t,
  };
}

/** 道床の天端の高さ (線形 Y からのオフセット)。 */
export function ballastTop(): number {
  return -RAIL_TOP_TO_BALLAST;
}

/** 架線柱を建てる間隔 [m]。 */
export const CATENARY_PITCH = 45;

export interface CatenaryOptions {
  /**
   * その地点に建ててよいか。踏切や立体交差では、線路の路肩がそのまま
   * 道路の真ん中になることがあるので、置く前に必ず確かめる。
   */
  canPlace?: (x: number, z: number, y: number) => boolean;
  /**
   * その弧長で、隣に並んでいる軌道の横距 [m] (自分自身は 0)。
   *
   * 複線・三線では線路 1 本ごとに柱を建てると、線路の間に柱が林立して
   * しまう。並んでいる軌道をまとめて 1 基の門型 (ビーム) で受けると、
   * 実物の複線と同じ見え方になる。
   */
  offsetsAt?: (s: number) => number[];
}

/** 架線柱の高さ [m] と、軌道からの離れ [m]。 */
const CATENARY_HEIGHT = 5.6;

/** 架線柱と架線を作る。建てた柱の足元位置を返す。 */
export function buildCatenary(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  options: CatenaryOptions = {},
): Vector3[] {
  if (cls.kind !== 'rail' || cls.id === 'rail_yard') return [];
  const poleColor: RGB = [0.42, 0.44, 0.46];
  const wireColor: RGB = [0.2, 0.2, 0.22];
  const total = samples[samples.length - 1].s - samples[0].s;
  const count = Math.floor(total / CATENARY_PITCH);
  const reach = cls.halfWidth - 0.6;
  const canPlace = options.canPlace ?? (() => true);

  const bases: Vector3[] = [];
  // 架線は「連続して建った柱の間」だけに張る。間が飛んだ所で張ると、
  // 踏切や交差点の上を斜めに横切ってしまう。
  const spans: { a: Vector3; b: Vector3 }[] = [];
  let previous: { heads: Map<number, Vector3>; index: number } | null = null;

  for (let i = 0; i <= count; i++) {
    const s = samples[0].s + i * CATENARY_PITCH;
    const sample = interpolateSample(samples, s);
    if (!sample) continue;

    const tracks = [...(options.offsetsAt?.(s) ?? [0])].sort((a, b) => a - b);
    const built =
      tracks.length > 1
        ? buildGantry(mb, sample, tracks, reach, poleColor, canPlace)
        : buildMast(mb, sample, reach, poleColor, canPlace);
    if (!built) {
      previous = null;
      continue;
    }

    const heads = new Map<number, Vector3>();
    for (const offset of tracks) {
      heads.set(
        Math.round(offset * 4) / 4,
        new Vector3(
          sample.pos.x + sample.right.x * offset,
          sample.pos.y + CATENARY_HEIGHT - 0.5 - RAIL_TOP_TO_BALLAST,
          sample.pos.z + sample.right.z * offset,
        ),
      );
    }
    if (previous && i - previous.index === 1) {
      for (const [key, head] of heads) {
        const before = previous.heads.get(key);
        if (before) spans.push({ a: before, b: head });
      }
    }
    previous = { heads, index: i };
    bases.push(...built);
  }

  for (const span of spans) {
    addWire(mb, span.a, span.b, 0.25, 0.03, wireColor);
  }
  return bases;
}

/** 1 本の軌道を受ける柱 (片持ちの腕木)。空いている側に建てる。 */
function buildMast(
  mb: MeshBuilder,
  sample: AlignmentSample,
  reach: number,
  color: RGB,
  canPlace: (x: number, z: number, y: number) => boolean,
): Vector3[] | null {
  // 線路の左右どちらでも構わないので、空いている側に建てる。
  const side = pickSide(sample, reach, canPlace);
  if (side === 0) return null;
  const offset = reach * side;
  const base = post(mb, sample, offset, color);
  // 腕木は軌道の上へ張り出す。
  beam(mb, sample, offset, 0, color);
  return [base];
}

/**
 * 並んだ軌道をまとめて受ける門型の架線柱。
 *
 * いちばん外の軌道の**外側の路肩**に柱を建て、その間に梁を渡して軌道ごとに
 * 架線を吊る。線路 1 本ごとに建てると、複線の間に柱が林立してしまう。柱の
 * 位置は 1 本のときとまったく同じ (路肩の上) なので、足元の高さの扱いも
 * 変わらない。
 */
function buildGantry(
  mb: MeshBuilder,
  sample: AlignmentSample,
  tracks: number[],
  reach: number,
  color: RGB,
  canPlace: (x: number, z: number, y: number) => boolean,
): Vector3[] | null {
  const left = tracks[0] - reach;
  const right = tracks[tracks.length - 1] + reach;
  for (const offset of [left, right]) {
    const x = sample.pos.x + sample.right.x * offset;
    const z = sample.pos.z + sample.right.z * offset;
    if (!canPlace(x, z, sample.pos.y - RAIL_TOP_TO_BALLAST)) return null;
  }
  const bases = [left, right].map((offset) => post(mb, sample, offset, color));
  beam(mb, sample, left, right, color);
  return bases;
}

/** 柱を 1 本建てる。足元の位置を返す。 */
function post(mb: MeshBuilder, sample: AlignmentSample, offset: number, color: RGB): Vector3 {
  const base = new Vector3(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y - RAIL_TOP_TO_BALLAST,
    sample.pos.z + sample.right.z * offset,
  );
  addBox(
    mb,
    base.clone().add(new Vector3(0, CATENARY_HEIGHT / 2, 0)),
    sample.right,
    UP,
    sample.forward,
    { x: 0.11, y: CATENARY_HEIGHT / 2, z: 0.11 },
    color,
  );
  return base;
}

/** 横距 `a` から `b` まで梁 (腕木) を渡す。 */
function beam(
  mb: MeshBuilder,
  sample: AlignmentSample,
  a: number,
  b: number,
  color: RGB,
): void {
  const centre = (a + b) / 2;
  const half = Math.abs(b - a) / 2;
  if (half < 0.05) return;
  const at = new Vector3(
    sample.pos.x + sample.right.x * centre,
    sample.pos.y + CATENARY_HEIGHT - 0.4 - RAIL_TOP_TO_BALLAST,
    sample.pos.z + sample.right.z * centre,
  );
  addBox(mb, at, sample.right, UP, sample.forward, { x: half, y: 0.08, z: 0.08 }, color);
}

/** 空いている方の路肩を選ぶ。両方塞がっていれば 0 (建てない)。 */
function pickSide(
  sample: AlignmentSample,
  offset: number,
  canPlace: (x: number, z: number, y: number) => boolean,
): -1 | 0 | 1 {
  for (const side of [1, -1] as const) {
    const x = sample.pos.x + sample.right.x * offset * side;
    const z = sample.pos.z + sample.right.z * offset * side;
    if (canPlace(x, z, sample.pos.y)) return side;
  }
  return 0;
}
