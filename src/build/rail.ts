import { Vector2, Vector3 } from 'three';
import { Alignment, type AlignmentSample } from '../core/alignment';
import { curveFromTangents } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import type { MeshBuilder } from '../core/meshbuilder';
import { RAIL_GAUGE, SURFACE_LIFT, smoothstep } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Approach } from '../network/junction';
import { addBox, addWire } from './primitives';
import type { RGB } from './surface';
import { RAIL_TOP_TO_BALLAST } from './surface';

const RAIL_COLOR: RGB = [0.42, 0.4, 0.42];
const RAIL_HEAD: RGB = [0.68, 0.66, 0.66];
const SLEEPER_COLOR: RGB = [0.31, 0.26, 0.22];
const BLADE_COLOR: RGB = [0.55, 0.52, 0.5];

/** レール頭部の半幅 [m]。踏切のフランジ溝の位置決めにも使う。 */
export const RAIL_HEAD_HALF_WIDTH = 0.035;
const RAIL_HALF_WIDTH = RAIL_HEAD_HALF_WIDTH;
const RAIL_HEIGHT = 0.15;
const SLEEPER_PITCH = 0.62;
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
    for (let k = 0; k < section.length; k++) {
      const [o, h, color] = section[k];
      p.set(
        sample.pos.x + sample.right.x * (offset + o),
        sample.pos.y + h + SURFACE_LIFT,
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
    for (const offset of trackOffsets) {
      center.set(
        sample.pos.x + sample.right.x * offset,
        sample.pos.y + SLEEPER_TOP - SLEEPER_HALF_THICK + SURFACE_LIFT,
        sample.pos.z + sample.right.z * offset,
      );
      addBox(
        mb,
        center,
        sample.right,
        up,
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
  };
}

/**
 * 交差点 (分岐器・クロッシング) を通過する軌道の線形。
 *
 * 平面は両端の接線を保った 3 次曲線。縦断は**両端の勾配を引き継ぐ**
 * エルミート曲線にする。単純に両端を直線で結ぶと、高低差のある分岐で
 * 枝との継ぎ目に折れ点ができ、勾配がそこだけ跳ね上がる。
 */
export function trackConnectionAlignment(from: Approach, to: Approach): Alignment | null {
  const a = new Vector2(from.center.x, from.center.z);
  const b = new Vector2(to.center.x, to.center.z);
  if (a.distanceTo(b) < 0.2) return null;

  // ノードへ向かう方向 = 外向きの逆。
  const ta = from.dir.clone().negate();
  const tb = to.dir.clone();
  const horizontal = curveFromTangents(a, ta, b, tb);
  // 曲線は from の外向きと逆に進むので、始点の勾配は符号が反転する。
  return new Alignment(
    horizontal,
    new VerticalProfile(
      from.center.y,
      to.center.y,
      -from.outwardGrade,
      to.outwardGrade,
      horizontal.length,
    ),
  );
}

export interface TrackConnectionOptions {
  /**
   * その地点の交差点面 (道床天端) の高さ。軌道がこれより下に潜らないよう
   * 持ち上げる。高低差のある分岐では、縦断曲線が弦より下に垂れて道床に
   * 埋まることがある。
   */
  ballastY?: (x: number, z: number) => number | null;
}

/**
 * 交差点 (分岐器・クロッシング) を通過する軌道を作る。
 * 直進側でも分岐側でも同じ処理で扱える。
 */
export function buildTrackConnection(
  mb: MeshBuilder,
  from: Approach,
  to: Approach,
  through: boolean,
  options: TrackConnectionOptions = {},
): void {
  const alignment = trackConnectionAlignment(from, to);
  if (!alignment) return;
  const samples = liftAboveBallast(alignment.sample(1.2), options.ballastY);

  const fromOffsets = outwardTrackOffsets(from);
  const toOffsets = outwardTrackOffsets(to);

  for (let i = 0; i < fromOffsets.length; i++) {
    const oa = fromOffsets[i];
    // 相手側では左右が反転するので、-oa に最も近い軌道と繋ぐ。
    let best = 0;
    let bestDelta = Infinity;
    for (let j = 0; j < toOffsets.length; j++) {
      const delta = Math.abs(toOffsets[j] + oa);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = j;
      }
    }
    const ob = toOffsets[best];
    // 接続曲線に沿って、始点で oa・終点で -ob になるようレールを寄せる。
    // 直線で寄せると両端で横方向に折れるので、両端の傾きが 0 になる
    // なめらかな関数を使う。
    const shifted = samples.map((sample) => {
      const t = smoothstep(sample.s / Math.max(1e-6, alignment.length));
      const offset = oa * (1 - t) + -ob * t;
      return { sample, offset };
    });
    buildShiftedRailPair(mb, shifted);
  }

  if (!through) buildSwitchBlades(mb, samples, fromOffsets[0] ?? 0);
}

/** 外向き方向を基準にした軌道の横オフセット。 */
function outwardTrackOffsets(approach: Approach): number[] {
  const cls = approach.branch.cls;
  const sign = approach.branch.atStart ? 1 : -1;
  const tracks = cls.tracks.length > 0 ? cls.tracks : [0];
  return tracks.map((t) => t * sign);
}

function buildShiftedRailPair(
  mb: MeshBuilder,
  path: { sample: AlignmentSample; offset: number }[],
): void {
  const half = RAIL_GAUGE / 2;
  for (const side of [-half, half]) {
    const shifted = path.map(({ sample, offset }) =>
      offsetSample(sample, offset + side),
    );
    buildRail(mb, shifted, 0);
  }
  // 分岐部の枕木。扇形に広がるのが本来だが、経路に直交させて並べる。
  const up = new Vector3(0, 1, 0);
  const center = new Vector3();
  const total = path[path.length - 1].sample.s - path[0].sample.s;
  const count = Math.floor(total / SLEEPER_PITCH);
  for (let i = 0; i <= count; i++) {
    const t = count > 0 ? i / count : 0;
    const idx = Math.min(path.length - 1, Math.round(t * (path.length - 1)));
    const { sample, offset } = path[idx];
    center.set(
      sample.pos.x + sample.right.x * offset,
      sample.pos.y + SLEEPER_TOP - SLEEPER_HALF_THICK + SURFACE_LIFT,
      sample.pos.z + sample.right.z * offset,
    );
    addBox(
      mb,
      center,
      sample.right,
      up,
      sample.forward,
      { x: SLEEPER_HALF_LENGTH, y: SLEEPER_HALF_THICK, z: SLEEPER_HALF_WIDTH },
      SLEEPER_COLOR,
    );
  }
}

/**
 * 交差点の道床より下に潜った所を持ち上げる。
 *
 * 両端は断面がそのまま道床天端なので持ち上げ量が 0 になり、継ぎ目は
 * 開かない。中だるみした所だけが道床の上に出てくる。
 */
function liftAboveBallast(
  samples: AlignmentSample[],
  ballastY?: (x: number, z: number) => number | null,
): AlignmentSample[] {
  if (!ballastY) return samples;
  return samples.map((sample) => {
    const ground = ballastY(sample.pos.x, sample.pos.z);
    if (ground === null) return sample;
    const min = ground + RAIL_TOP_TO_BALLAST;
    if (sample.pos.y >= min) return sample;
    return {
      ...sample,
      pos: new Vector3(sample.pos.x, min, sample.pos.z),
    };
  });
}

function offsetSample(sample: AlignmentSample, offset: number): AlignmentSample {
  return {
    ...sample,
    pos: new Vector3(
      sample.pos.x + sample.right.x * offset,
      sample.pos.y,
      sample.pos.z + sample.right.z * offset,
    ),
  };
}

/** 分岐器のトングレール (可動部) を模した細い板。 */
function buildSwitchBlades(mb: MeshBuilder, samples: AlignmentSample[], offset: number): void {
  const up = new Vector3(0, 1, 0);
  const start = samples[0];
  if (!start) return;
  const half = RAIL_GAUGE / 2;
  for (const side of [-half, half]) {
    const center = new Vector3(
      start.pos.x + start.right.x * (offset + side) + start.forward.x * 1.6,
      start.pos.y - RAIL_HEIGHT * 0.5 + SURFACE_LIFT,
      start.pos.z + start.right.z * (offset + side) + start.forward.z * 1.6,
    );
    addBox(
      mb,
      center,
      start.right,
      up,
      start.forward,
      { x: 0.05, y: RAIL_HEIGHT * 0.45, z: 1.6 },
      BLADE_COLOR,
    );
  }
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
}

/** 架線柱と架線を作る。建てた柱の足元位置を返す。 */
export function buildCatenary(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  options: CatenaryOptions = {},
): Vector3[] {
  if (cls.kind !== 'rail' || cls.id === 'rail_yard') return [];
  const up = new Vector3(0, 1, 0);
  const poleColor: RGB = [0.42, 0.44, 0.46];
  const wireColor: RGB = [0.2, 0.2, 0.22];
  const total = samples[samples.length - 1].s - samples[0].s;
  const count = Math.floor(total / CATENARY_PITCH);
  const armLength = cls.halfWidth - 0.6;
  const height = 5.6;
  const canPlace = options.canPlace ?? (() => true);

  const bases: Vector3[] = [];
  // 架線は「連続して建った柱の間」だけに張る。間が飛んだ所で張ると、
  // 踏切や交差点の上を斜めに横切ってしまう。
  const spans: { a: Vector3; b: Vector3 }[] = [];
  let previous: { head: Vector3; index: number } | null = null;

  for (let i = 0; i <= count; i++) {
    const s = samples[0].s + i * CATENARY_PITCH;
    const sample = interpolateSample(samples, s);
    if (!sample) continue;

    // 線路の左右どちらでも構わないので、空いている側に建てる。
    const side = pickSide(sample, armLength, canPlace);
    if (side === 0) {
      previous = null;
      continue;
    }
    const offset = armLength * side;
    const base = new Vector3(
      sample.pos.x + sample.right.x * offset,
      sample.pos.y - RAIL_TOP_TO_BALLAST,
      sample.pos.z + sample.right.z * offset,
    );
    addBox(
      mb,
      base.clone().add(new Vector3(0, height / 2, 0)),
      sample.right,
      up,
      sample.forward,
      { x: 0.11, y: height / 2, z: 0.11 },
      poleColor,
    );
    // 腕木は軌道の上へ張り出す。
    const armCenter = base
      .clone()
      .add(new Vector3(0, height - 0.4, 0))
      .addScaledVector(sample.right, -offset / 2);
    addBox(
      mb,
      armCenter,
      sample.right,
      up,
      sample.forward,
      { x: armLength / 2, y: 0.08, z: 0.08 },
      poleColor,
    );

    const head = new Vector3(
      sample.pos.x,
      sample.pos.y + height - 0.5 - RAIL_TOP_TO_BALLAST,
      sample.pos.z,
    );
    if (previous && i - previous.index === 1) spans.push({ a: previous.head, b: head });
    previous = { head, index: i };
    bases.push(base);
  }

  for (const span of spans) {
    addWire(mb, span.a, span.b, 0.25, 0.03, wireColor);
  }
  return bases;
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
