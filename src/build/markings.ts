import { Vector3 } from 'three';
import type { Alignment } from '../core/alignment';
import { MeshBuilder, UP } from '../core/meshbuilder';
import { DRIVE_ON_LEFT, MARKING_LIFT, SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { RGB } from './surface';

const WHITE: RGB = [0.92, 0.92, 0.9];
const YELLOW: RGB = [0.86, 0.72, 0.2];

/** 横断歩道の縞 1 本の幅と間隔 [m]。 */
const ZEBRA_BAR = 0.45;
const ZEBRA_PITCH = 1.0;

/** 交差点端から横断歩道までの離隔と、横断歩道の奥行き [m]。 */
export const CROSSWALK_OFFSET = 0.6;
export const CROSSWALK_DEPTH = 3.6;
/** 交差点端から停止線までの距離 [m]。 */
export const STOP_LINE_OFFSET = CROSSWALK_OFFSET + CROSSWALK_DEPTH + 0.6;
const STOP_LINE_WIDTH = 0.45;

/** 標示を描くのに必要な取り付け長 [m]。 */
export const MARKING_CLEARANCE = STOP_LINE_OFFSET + STOP_LINE_WIDTH + 0.5;

/** 路面上の 1 点。標示は路面よりわずかに浮かせる。 */
function surfacePoint(alignment: Alignment, s: number, offset: number, out = new Vector3()): Vector3 {
  const sample = alignment.sampleAt(s);
  return out.set(
    sample.pos.x + sample.right.x * offset,
    sample.pos.y + SURFACE_LIFT + MARKING_LIFT,
    sample.pos.z + sample.right.z * offset,
  );
}

/** 弧長 [s0, s1]、横断方向 [o0, o1] の矩形を路面上に描く。 */
export function paintRect(
  mb: MeshBuilder,
  alignment: Alignment,
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
  alignment: Alignment,
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
 * 車線境界は白破線、対向のある中央線は 2 車線なら白破線、多車線なら黄実線。
 */
export function buildLaneMarkings(
  mb: MeshBuilder,
  alignment: Alignment,
  range: { s0: number; s1: number },
  cls: NetworkClass,
): void {
  if (cls.kind !== 'road' || cls.lanes.length === 0) return;
  if (range.s1 - range.s0 < 2) return;

  const cw = cls.carriagewayHalfWidth;
  // 車道の外側線。
  paintStripe(mb, alignment, range, -cw + 0.25, 0.15, WHITE);
  paintStripe(mb, alignment, range, cw - 0.25, 0.15, WHITE);

  const perSide = cls.lanes.length / 2;
  if (cls.lanes.length >= 4) {
    // 中央線は黄色の実線 2 本。
    paintStripe(mb, alignment, range, -0.18, 0.15, YELLOW);
    paintStripe(mb, alignment, range, 0.18, 0.15, YELLOW);
  } else {
    paintStripe(mb, alignment, range, 0, 0.15, WHITE, { on: 5, off: 5 });
  }

  // 同方向の車線どうしの境界。
  for (let i = 1; i < perSide; i++) {
    const o = (i * cw) / perSide;
    paintStripe(mb, alignment, range, o, 0.12, WHITE, { on: 5, off: 5 });
    paintStripe(mb, alignment, range, -o, 0.12, WHITE, { on: 5, off: 5 });
  }
}

/** 交差点の 1 枝に対する、外向き方向を基準とした座標系。 */
export interface ApproachFrame {
  alignment: Alignment;
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

/** 踏切の前後に引く停止線と、線路までの離隔を示す縞。 */
export function buildCrossingStopLine(
  mb: MeshBuilder,
  alignment: Alignment,
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
