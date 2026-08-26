import { Vector3 } from 'three';
import { MeshBuilder, UP } from '../core/meshbuilder';
import type { Station, StationId } from '../network/station';
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

/** 停車駅を囲む輪。 */
function ring(mb: MeshBuilder, station: Station, color: readonly [number, number, number]): void {
  const cos = Math.cos(station.heading);
  const sin = Math.sin(station.heading);
  const along = station.length / 2 + RING_MARGIN;
  const half = Math.max(Math.abs(station.minOffset), Math.abs(station.maxOffset)) + RING_MARGIN;
  const y = station.center.y + BAND_LIFT + 1.2;
  const at = (u: number, v: number): number => {
    const x = station.center.x + cos * u - sin * v;
    const z = station.center.z + sin * u + cos * v;
    return mb.vertex(new Vector3(x, y, z), UP, 0, 0, color);
  };
  const outer: [number, number][] = [
    [along, half],
    [along, -half],
    [-along, -half],
    [-along, half],
  ];
  for (let i = 0; i < outer.length; i++) {
    const [au, av] = outer[i];
    const [bu, bv] = outer[(i + 1) % outer.length];
    // 内側は中心へ寄せた分だけ細くする。
    const inset = (u: number, v: number): [number, number] => [
      u - Math.sign(u) * RING_WIDTH,
      v - Math.sign(v) * RING_WIDTH,
    ];
    const [ia, ib] = [inset(au, av), inset(bu, bv)];
    mb.quad(at(au, av), at(bu, bv), at(ib[0], ib[1]), at(ia[0], ia[1]));
  }
}
