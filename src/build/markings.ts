import { Vector3 } from 'three';
import type { AlignmentSample } from '../core/alignment';
import { MeshBuilder, UP, signedAreaXZ } from '../core/meshbuilder';
import {
  CROSSWALK_DEPTH,
  CROSSWALK_OFFSET,
  DRIVE_ON_LEFT,
  MARKING_LIFT,
  STOP_LINE_OFFSET,
  SURFACE_LIFT,
  clamp,
} from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Movement } from '../network/lanes';
import type { RGB } from './surface';

const WHITE: RGB = [0.92, 0.92, 0.9];
const YELLOW: RGB = [0.86, 0.72, 0.2];

/** 横断歩道の縞 1 本の幅と間隔 [m]。 */
const ZEBRA_BAR = 0.45;
const ZEBRA_PITCH = 1.0;

// 横断歩道・停止線の位置は走行側 (`sim/`) も見るので `core/units.ts` にある。
export { CROSSWALK_OFFSET, CROSSWALK_DEPTH, STOP_LINE_OFFSET };
const STOP_LINE_WIDTH = 0.45;

/** 標示を描くのに必要な取り付け長 [m]。 */
export const MARKING_CLEARANCE = STOP_LINE_OFFSET + STOP_LINE_WIDTH + 0.5;

/**
 * 標示を引く路面。踏切のまわりでは路面が線路に合わせて上下・傾斜するので、
 * 線形そのものではなく「描画に使った高さ」を返せる経路を受け取る。
 */
export interface SurfacePath {
  readonly length: number;
  sampleAt(s: number): AlignmentSample;
}

/** 路面上の 1 点。標示は路面よりわずかに浮かせる。 */
function surfacePoint(path: SurfacePath, s: number, offset: number, out = new Vector3()): Vector3 {
  const sample = path.sampleAt(s);
  return out.set(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y + SURFACE_LIFT + MARKING_LIFT + offset * (sample.roll ?? 0),
    sample.pos.z + sample.right.z * offset,
  );
}

/** 弧長 [s0, s1]、横断方向 [o0, o1] の矩形を路面上に描く。 */
export function paintRect(
  mb: MeshBuilder,
  alignment: SurfacePath,
  s0: number,
  s1: number,
  o0: number,
  o1: number,
  color: RGB,
  subdivisions = 1,
): void {
  const steps = Math.max(1, subdivisions);
  let prevLeft = -1;
  let prevRight = -1;
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
    const l = mb.vertex(surfacePoint(alignment, s, o0), UP, 0, i, color);
    const r = mb.vertex(surfacePoint(alignment, s, o1), UP, 1, i, color);
    if (prevLeft >= 0) mb.quad(prevLeft, prevRight, r, l);
    prevLeft = l;
    prevRight = r;
  }
}

/** 破線・実線を線形に沿って描く。 */
function paintStripe(
  mb: MeshBuilder,
  alignment: SurfacePath,
  range: { s0: number; s1: number },
  offset: number,
  width: number,
  color: RGB,
  dash?: { on: number; off: number },
): void {
  const half = width / 2;
  if (!dash) {
    const steps = Math.max(1, Math.ceil((range.s1 - range.s0) / 2));
    paintRect(mb, alignment, range.s0, range.s1, offset - half, offset + half, color, steps);
    return;
  }
  const period = dash.on + dash.off;
  let s = range.s0;
  while (s < range.s1) {
    const end = Math.min(s + dash.on, range.s1);
    if (end - s > 0.4) {
      paintRect(
        mb,
        alignment,
        s,
        end,
        offset - half,
        offset + half,
        color,
        Math.max(1, Math.ceil((end - s) / 2)),
      );
    }
    s += period;
  }
}

/**
 * セグメント本体の区画線を描く。
 *
 * 線を引く位置は車線の並びから決める。同じ向きの車線どうしの境界は白破線、
 * 対向と接する境界 (中央線) は 2 車線なら白破線、多車線なら黄実線。
 * 一方通行の種別には対向がないので、中央線も引かない。
 */
export function buildLaneMarkings(
  mb: MeshBuilder,
  alignment: SurfacePath,
  range: { s0: number; s1: number },
  cls: NetworkClass,
): void {
  if (cls.kind !== 'road' || cls.lanes.length === 0) return;
  if (range.s1 - range.s0 < 2) return;

  const cw = cls.carriagewayHalfWidth;
  // 車道の外側線。
  paintStripe(mb, alignment, range, -cw + 0.25, 0.15, WHITE);
  paintStripe(mb, alignment, range, cw - 0.25, 0.15, WHITE);

  const lanes = cls.lanes;
  for (let i = 0; i + 1 < lanes.length; i++) {
    const a = lanes[i];
    const b = lanes[i + 1];
    // 隣り合う車線の縁の中点。車線幅が違っても境界がずれない。
    const o = (a.offset + a.width / 2 + (b.offset - b.width / 2)) / 2;
    if (a.direction === b.direction) {
      paintStripe(mb, alignment, range, o, 0.12, WHITE, { on: 5, off: 5 });
    } else if (lanes.length >= 4) {
      // 中央線は黄色の実線 2 本。
      paintStripe(mb, alignment, range, o - 0.18, 0.15, YELLOW);
      paintStripe(mb, alignment, range, o + 0.18, 0.15, YELLOW);
    } else {
      paintStripe(mb, alignment, range, o, 0.15, WHITE, { on: 5, off: 5 });
    }
  }
}

/** 交差点の 1 枝に対する、外向き方向を基準とした座標系。 */
export interface ApproachFrame {
  alignment: SurfacePath;
  atStart: boolean;
  length: number;
  trim: number;
  cls: NetworkClass;
}

/** ノードからの距離を線形の弧長に変換する。 */
export function stationAt(frame: ApproachFrame, distance: number): number {
  return frame.atStart ? distance : frame.length - distance;
}

/** 外向き基準の横オフセットを、線形自身の横オフセットに変換する。 */
export function offsetIn(frame: ApproachFrame, outwardOffset: number): number {
  return frame.atStart ? outwardOffset : -outwardOffset;
}

/** 横断歩道 (ゼブラ) を描く。 */
export function buildCrosswalk(mb: MeshBuilder, frame: ApproachFrame): void {
  const cls = frame.cls;
  if (!cls.crosswalks) return;
  const near = frame.trim + CROSSWALK_OFFSET;
  const far = near + CROSSWALK_DEPTH;
  if (far > frame.length - 0.5) return;

  const s0 = stationAt(frame, near);
  const s1 = stationAt(frame, far);
  const cw = cls.carriagewayHalfWidth;
  const count = Math.max(1, Math.floor((cw * 2 - 0.4) / ZEBRA_PITCH));
  const startOffset = -cw + 0.3;
  for (let i = 0; i < count; i++) {
    const o0 = startOffset + i * ZEBRA_PITCH;
    const o1 = o0 + ZEBRA_BAR;
    if (o1 > cw - 0.2) break;
    paintRect(
      mb,
      frame.alignment,
      s0,
      s1,
      offsetIn(frame, o0),
      offsetIn(frame, o1),
      WHITE,
      3,
    );
  }
}

/**
 * 停止線を描く。左側通行では、交差点に向かう車線は外向き方向から見て
 * 右側 (offset > 0) にあるので、その範囲だけを引く。
 */
export function buildStopLine(mb: MeshBuilder, frame: ApproachFrame): void {
  const cls = frame.cls;
  if (cls.kind !== 'road') return;
  const dist = frame.trim + STOP_LINE_OFFSET;
  if (dist + STOP_LINE_WIDTH > frame.length - 0.5) return;

  const s0 = stationAt(frame, dist);
  const s1 = stationAt(frame, dist + STOP_LINE_WIDTH);
  const cw = cls.carriagewayHalfWidth;
  const [o0, o1] = DRIVE_ON_LEFT ? [0.1, cw - 0.25] : [-cw + 0.25, -0.1];
  paintRect(mb, frame.alignment, s0, s1, offsetIn(frame, o0), offsetIn(frame, o1), WHITE, 1);
}

// ------------------------------------------------------------ 進行方向矢印

/** 矢印の全長と、停止線から先端までの距離 [m]。 */
const ARROW_LENGTH = 5.0;
const ARROW_SETBACK = 2.5;

/**
 * 矢印の各部の寸法。車線幅に比例させ、折れ矢印の枝が車線からはみ出して
 * 縁石や歩道に潜り込まないようにする。
 */
function arrowShape(laneWidth: number): {
  shaft: number;
  headLength: number;
  headHalf: number;
  branch: number;
  reach: number;
} {
  const w = clamp(laneWidth, 2.6, 4.6);
  // 枝の先端までの張り出し。車線の中心から見て、路端に届かない範囲。
  const reach = w * 0.38;
  const branch = reach * 0.36;
  return {
    shaft: Math.min(0.5, w * 0.15),
    headLength: 1.6,
    headHalf: Math.min(0.85, w * 0.2),
    branch,
    reach,
  };
}

/** 矢印を描くのに必要な取り付け長 [m]。 */
export const ARROW_CLEARANCE = STOP_LINE_OFFSET + ARROW_SETBACK + ARROW_LENGTH + 1;

/**
 * 進行方向別通行区分を示す矢印を描く。
 *
 * 形は車から見た座標 (u = 交差点へ向かう向き、v = 車の右手) で組み立て、
 * 最後にノードからの距離と横距へ直す。左折・右折は軸の途中から枝を出す
 * 「折れ矢印」にするので、1 本の車線に複数の進路があっても 1 個で足りる。
 */
export function buildTurnArrows(
  mb: MeshBuilder,
  frame: ApproachFrame,
  lanes: { offset: number; width: number; movements: readonly Movement[] }[],
): void {
  const tip = frame.trim + STOP_LINE_OFFSET + ARROW_SETBACK;
  const tail = tip + ARROW_LENGTH;
  if (tail > frame.length - 0.5) return;

  for (const lane of lanes) {
    if (lane.movements.length === 0) continue;
    const size = arrowShape(lane.width);
    const through = lane.movements.includes('through');
    // 直進がなければ軸を短くして、その先を折れ矢印の枝に使う。
    const shaftEnd = through ? ARROW_LENGTH - size.headLength : ARROW_LENGTH * 0.62;
    const shapes: [number, number][][] = [rect(0, shaftEnd, -size.shaft / 2, size.shaft / 2)];
    if (through) {
      shapes.push([
        [ARROW_LENGTH, 0],
        [shaftEnd, -size.headHalf],
        [shaftEnd, size.headHalf],
      ]);
    }
    for (const movement of lane.movements) {
      if (movement !== 'left' && movement !== 'right') continue;
      // 左折は車の左手 (v が負)、右折は右手 (v が正) へ枝を出す。
      const side = movement === 'right' ? 1 : -1;
      const bar = shaftEnd - size.shaft;
      shapes.push(rect(bar, shaftEnd, 0, side * size.branch));
      shapes.push([
        [bar + size.shaft / 2, side * size.reach],
        [bar + size.shaft / 2 - size.headHalf * 0.8, side * size.branch],
        [bar + size.shaft / 2 + size.headHalf * 0.8, side * size.branch],
      ]);
    }

    for (const shape of shapes) {
      paintShape(
        mb,
        frame,
        // u は交差点へ向かう向きなので、ノードからの距離は減る方向。
        // v は車の右手で、外向き基準の横距とは符号が逆になる。
        shape.map(([u, v]) => [tail - u, lane.offset - v] as [number, number]),
        WHITE,
      );
    }
  }
}

/** (u0..u1) × (v0..v1) の矩形。頂点は一周する順。 */
function rect(u0: number, u1: number, v0: number, v1: number): [number, number][] {
  return [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
}

/**
 * 外向き基準の (ノードからの距離, 横距) で与えた凸多角形を路面に描く。
 * 頂点の並びは、上を向く面になるよう必要に応じて反転する。
 */
function paintShape(
  mb: MeshBuilder,
  frame: ApproachFrame,
  points: [number, number][],
  color: RGB,
): void {
  if (points.length < 3) return;
  const world = points.map(([distance, offset]) =>
    surfacePoint(frame.alignment, stationAt(frame, distance), offsetIn(frame, offset)),
  );
  // 上向きの面は XZ 平面で見て時計回り (符号付き面積が負) になる。
  if (signedAreaXZ(world) > 0) world.reverse();
  const base = mb.vertexCount;
  for (const p of world) mb.vertex(p, UP, 0, 0, color);
  for (let i = 1; i + 1 < world.length; i++) mb.triangle(base, base + i, base + i + 1);
}

/** 踏切の前後に引く停止線と、線路までの離隔を示す縞。 */
export function buildCrossingStopLine(
  mb: MeshBuilder,
  alignment: SurfacePath,
  sStop: number,
  cls: NetworkClass,
  forward: boolean,
): void {
  const cw = cls.carriagewayHalfWidth;
  const w = 0.45;
  const s0 = forward ? sStop : sStop - w;
  const s1 = forward ? sStop + w : sStop;
  const [o0, o1] = DRIVE_ON_LEFT === forward ? [0.1, cw - 0.25] : [-cw + 0.25, -0.1];
  paintRect(mb, alignment, s0, s1, o0, o1, WHITE, 1);
}
