import { Vector2, Vector3 } from 'three';
import { Alignment, type AlignmentSample } from '../core/alignment';
import { curveFromTangents } from '../core/curve';
import { VerticalProfile } from '../core/profile';
import type { MeshBuilder } from '../core/meshbuilder';
import { RAIL_GAUGE, SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Approach } from '../network/junction';
import { addBox } from './primitives';
import type { RGB } from './surface';
import { RAIL_TOP_TO_BALLAST } from './surface';

const RAIL_COLOR: RGB = [0.42, 0.4, 0.42];
const RAIL_HEAD: RGB = [0.68, 0.66, 0.66];
const SLEEPER_COLOR: RGB = [0.31, 0.26, 0.22];
const BLADE_COLOR: RGB = [0.55, 0.52, 0.5];

const RAIL_HALF_WIDTH = 0.035;
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
 * 交差点 (分岐器・クロッシング) を通過する軌道を作る。
 *
 * 2 本の接続枝のトリム位置を、両端の接線を保った 3 次曲線で結び、
 * その上に軌道を敷く。直進側でも分岐側でも同じ処理で扱える。
 */
export function buildTrackConnection(
  mb: MeshBuilder,
  from: Approach,
  to: Approach,
  through: boolean,
): void {
  const a = new Vector2(from.center.x, from.center.z);
  const b = new Vector2(to.center.x, to.center.z);
  if (a.distanceTo(b) < 0.2) return;

  // ノードへ向かう方向 = 外向きの逆。
  const ta = from.dir.clone().negate();
  const tb = to.dir.clone();
  const horizontal = curveFromTangents(a, ta, b, tb);
  const alignment = new Alignment(
    horizontal,
    VerticalProfile.linear(from.center.y, to.center.y, horizontal.length),
  );
  const samples = alignment.sample(1.2);

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
    const shifted = samples.map((sample) => {
      const t = sample.s / Math.max(1e-6, alignment.length);
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

/** 架線柱と架線を作る。 */
export function buildCatenary(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
): void {
  if (cls.kind !== 'rail' || cls.id === 'rail_yard') return;
  const up = new Vector3(0, 1, 0);
  const poleColor: RGB = [0.42, 0.44, 0.46];
  const wireColor: RGB = [0.2, 0.2, 0.22];
  const total = samples[samples.length - 1].s - samples[0].s;
  const count = Math.floor(total / CATENARY_PITCH);
  const side = cls.halfWidth - 0.6;
  const height = 5.6;

  const heads: Vector3[] = [];
  for (let i = 0; i <= count; i++) {
    const s = samples[0].s + i * CATENARY_PITCH;
    const sample = interpolateSample(samples, s);
    if (!sample) continue;
    const base = new Vector3(
      sample.pos.x + sample.right.x * side,
      sample.pos.y - RAIL_TOP_TO_BALLAST,
      sample.pos.z + sample.right.z * side,
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
    // 腕木。
    const armCenter = base
      .clone()
      .add(new Vector3(0, height - 0.4, 0))
      .addScaledVector(sample.right, -side / 2);
    addBox(
      mb,
      armCenter,
      sample.right,
      up,
      sample.forward,
      { x: side / 2, y: 0.08, z: 0.08 },
      poleColor,
    );
    heads.push(base.clone().add(new Vector3(0, height - 0.5, 0)));
  }

  // 隣り合う架線柱の間に架線を 1 本張る。
  for (let i = 0; i + 1 < heads.length; i++) {
    const a = heads[i];
    const b = heads[i + 1];
    const dir = new Vector3().subVectors(b, a);
    const len = dir.length();
    if (len < 1e-3) continue;
    dir.divideScalar(len);
    const right = new Vector3().crossVectors(dir, up).normalize();
    addBox(
      mb,
      a.clone().lerp(b, 0.5),
      right,
      up,
      dir,
      { x: 0.03, y: 0.03, z: len / 2 },
      wireColor,
    );
  }
}
