import { Vector3 } from 'three';
import { MeshBuilder, UP } from '../core/meshbuilder';
import { stationPointOn, type Station, type StationId } from '../network/station';
import type { LaneGraph } from '../sim/lanegraph';
import type { LinePlan } from '../sim/lineRoute';

/**
 * 路線の経路を、線路の上に色帯として描く。
 *
 * どの線路を通ってどの駅に停まるのかは、線路の形だけからは読み取れない。
 * 路線ツールを使っている間だけ、実際に列車が走る車線をなぞって出す。
 */

/** 帯の幅 [m]。 */
const BAND_WIDTH = 2.6;
/**
 * レール面から浮かせる高さ [m]。
 *
 * 道床に貼り付けると色が砂利に紛れるので、レールより上に浮かせる。
 * 走っている列車には隠れるが、それは「その路線の列車がそこを走っている」
 * ことなので都合がよい。
 */
const BAND_LIFT = 1.1;
/** 路線どうしをずらす横距 [m]。同じ線路を通る路線を見分けるため。 */
const BAND_SPACING = 1.1;
/** 車線をなぞる刻み [m]。曲線でも角が目立たない程度に細かく取る。 */
const STEP = 4;
/** 停車駅の輪の太さ [m]。 */
const RING_WIDTH = 1.6;
/** 停車駅の輪を、駅の中心から広げる余裕 [m]。 */
const RING_MARGIN = 3;

/** 駅を囲む輪を刻む間隔 [m]。曲線の駅でも縁が折れて見えない程度に。 */
const RING_STEP = 12;

export function buildLineOverlay(
  mb: MeshBuilder,
  plans: LinePlan[],
  graph: LaneGraph,
  stations: ReadonlyMap<StationId, Station>,
): void {
  plans.forEach((plan, index) => {
    // 路線ごとに横へずらす。1 本だけなら中心を通る。
    const shift = (index - (plans.length - 1) / 2) * BAND_SPACING;
    // 折り返す路線は同じ線路を両方向に通る。帯は 1 本だけ描く。
    const drawn = new Set<number>();
    for (const run of plan.runs) {
      for (const id of run.lanes) {
        const lane = graph.lanes[id];
        if (!lane || drawn.has(id)) continue;
        drawn.add(id);
        if (lane.reverse !== undefined) drawn.add(lane.reverse);
        band(mb, lane, plan.color, shift);
      }
    }
    for (const stop of plan.stops) {
      const station = stations.get(stop.id);
      if (station) ring(mb, station, plan.color);
    }
  });
}

/** 車線 1 本ぶんの帯。 */
function band(
  mb: MeshBuilder,
  lane: LaneGraph['lanes'][number],
  color: readonly [number, number, number],
  shift: number,
): void {
  const steps = Math.max(1, Math.ceil(lane.path.length / STEP));
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const pose = lane.path.poseAt((i / steps) * lane.path.length);
    // 進行方向の右 (XZ 平面)。カントで傾いた分は無視してよい。
    const nx = pose.dir.z;
    const nz = -pose.dir.x;
    const length = Math.hypot(nx, nz) || 1;
    const rx = nx / length;
    const rz = nz / length;
    const cx = pose.pos.x + rx * shift;
    const cz = pose.pos.z + rz * shift;
    const y = pose.pos.y + BAND_LIFT;
    const half = BAND_WIDTH / 2;
    left.push(mb.vertex(new Vector3(cx - rx * half, y, cz - rz * half), UP, 0, 0, color));
    right.push(mb.vertex(new Vector3(cx + rx * half, y, cz + rz * half), UP, 1, 0, color));
  }
  mb.strip(left, right);
}

/**
 * 停車駅を囲む輪。
 *
 * 中心線に沿わせるので、曲線の途中の駅でも敷地の形どおりに囲む。
 */
function ring(mb: MeshBuilder, station: Station, color: readonly [number, number, number]): void {
  const along = station.length / 2 + RING_MARGIN;
  const half = Math.max(Math.abs(station.minOffset), Math.abs(station.maxOffset)) + RING_MARGIN;
  const lift = BAND_LIFT + 1.2;
  const outer = ringLoop(station, along, half, lift);
  const inner = ringLoop(station, along - RING_WIDTH, half - RING_WIDTH, lift);
  const at = (p: Vector3): number => mb.vertex(p, UP, 0, 0, color);
  for (let i = 0; i < outer.length; i++) {
    const j = (i + 1) % outer.length;
    mb.quad(at(outer[i]), at(outer[j]), at(inner[j]), at(inner[i]));
  }
}

/** 駅を囲む閉じた輪郭。中心線の片側を往き、反対側を返る。 */
function ringLoop(station: Station, along: number, half: number, lift: number): Vector3[] {
  const steps = Math.max(2, Math.ceil(station.path.length / RING_STEP));
  const side = (across: number, forward: boolean): Vector3[] => {
    const out: Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = forward ? i / steps : 1 - i / steps;
      out.push(stationPointOn(station, -along + t * along * 2, across, lift));
    }
    return out;
  };
  return [...side(half, true), ...side(-half, false)];
}
