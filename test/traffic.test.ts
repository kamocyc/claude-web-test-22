import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { draw, type Waypoint } from '../src/app/sketch';
import { solveJunctions } from '../src/network/junction';
import { Network } from '../src/network/network';
import type { SegmentId } from '../src/network/network';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { signalStateAt } from '../src/sim/signals';
import { Traffic, type Vehicle } from '../src/sim/traffic';
import { Heightfield } from '../src/terrain/heightfield';

/** 平らな地形。地形の起伏で結果が揺れないようにする。 */
function flatField(): Heightfield {
  return new Heightfield();
}

/** 交差点を解き、描画と同じトリム範囲つきの車線グラフを組み立てる。 */
function laneGraphOf(network: Network): LaneGraph {
  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const length = network.alignmentOf(seg.id).length;
    ranges.set(seg.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return buildLaneGraph(network, junctions, ranges);
}

/** 十字路 1 つの道路網。 */
function crossroads(classId = 'road_medium', reach = 260): Network {
  const network = new Network();
  const field = flatField();
  const line = (points: Waypoint[]): void => {
    draw(network, field, classId, points.map((p) => ({ ...p, y: 0 })), { straight: true });
  };
  // 2 本目が 1 本目を横切るので、交点に交差点が自動生成される。
  line([{ x: -reach, z: 0 }, { x: reach, z: 0 }]);
  line([{ x: 0, z: -reach }, { x: 0, z: reach }]);
  return network;
}

/** その位置に最も近い線形と、進行方向から見た横距。 */
function lateralOf(
  network: Network,
  pos: Vector3,
  dir: Vector3,
): { segment: SegmentId; lateral: number; along: number } | null {
  const hit = network.findSegmentNear(pos, 20);
  if (!hit) return null;
  const sample = network.alignmentOf(hit.segment).sampleAt(hit.s);
  const lateral =
    (pos.x - sample.pos.x) * sample.right.x + (pos.z - sample.pos.z) * sample.right.z;
  const along = dir.x * sample.forward.x + dir.z * sample.forward.z;
  return { segment: hit.segment, lateral, along };
}

/** シミュレーションを進めながら、毎回の状態を調べる。 */
function run(
  traffic: Traffic,
  seconds: number,
  observe?: (vehicles: readonly Vehicle[], time: number) => void,
): void {
  const dt = 1 / 20;
  for (let i = 0; i < seconds / dt; i++) {
    traffic.step(dt);
    observe?.(traffic.vehicles, traffic.time);
  }
}

describe('交通シミュレーション', () => {
  it('敷いた道路の上を車が走り、60 秒のあいだ誰も詰まらない', () => {
    const network = crossroads();
    const traffic = new Traffic(laneGraphOf(network));
    expect(traffic.targetCount('car')).toBeGreaterThan(2);

    run(traffic, 30);
    // 走った道のりを積む (行って戻ると直線距離では測れないため)。
    const watched = new Set(traffic.vehicles.map((v) => v.id));
    const last = new Map<number, Vector3>();
    const travelled = new Map<number, number>();
    run(traffic, 60, (vehicles) => {
      for (const vehicle of vehicles) {
        const pos = vehicle.bodies[0].pos;
        const before = last.get(vehicle.id);
        if (before) travelled.set(vehicle.id, (travelled.get(vehicle.id) ?? 0) + before.distanceTo(pos));
        last.set(vehicle.id, pos.clone());
      }
    });

    // 途中で湧いた車は道のりが短くて当然なので、最初からいた車だけを見る。
    let checked = 0;
    for (const vehicle of traffic.vehicles) {
      const distance = travelled.get(vehicle.id);
      if (distance === undefined || !watched.has(vehicle.id)) continue;
      checked++;
      // 信号待ちを差し引いても、60 秒あれば 100 m は進む。
      expect(distance).toBeGreaterThan(100);
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('左側通行で走る (対向車線にはみ出さない)', () => {
    const network = crossroads();
    const traffic = new Traffic(laneGraphOf(network));
    let checked = 0;
    run(traffic, 40, (vehicles) => {
      for (const vehicle of vehicles) {
        const body = vehicle.bodies[0];
        // 交差点の中は進路が中心線をまたぐので、本線上だけを見る。
        if (Math.hypot(body.pos.x, body.pos.z) < 40) continue;
        const found = lateralOf(network, body.pos, body.dir);
        if (!found || Math.abs(found.along) < 0.9) continue;
        checked++;
        // 線形の向きに走る車は左 (横距が負)、逆向きの車は右にいる。
        expect(Math.sign(found.lateral)).toBe(found.along > 0 ? -1 : 1);
      }
    });
    expect(checked).toBeGreaterThan(500);
  });

  it('車どうしが重ならない (前車追従と交差点の進路の取り合い)', () => {
    const network = crossroads();
    const traffic = new Traffic(laneGraphOf(network));
    let closest = Infinity;
    run(traffic, 90, (vehicles) => {
      for (let i = 0; i < vehicles.length; i++) {
        for (let j = i + 1; j < vehicles.length; j++) {
          for (const a of vehicles[i].bodies) {
            for (const b of vehicles[j].bodies) {
              closest = Math.min(closest, a.pos.distanceTo(b.pos));
            }
          }
        }
      }
    });
    // 車体の幅 (1.8 m) と隣の車線までの距離 (3.25 m) の間。
    expect(closest).toBeGreaterThan(2.4);
  });

  it('赤信号の交差点へは進入しない', () => {
    const network = crossroads();
    const graph = laneGraphOf(network);
    const signalized = graph.lanes.filter((l) => l.phase !== undefined);
    expect(signalized.length).toBeGreaterThan(0);

    const traffic = new Traffic(graph);
    // 進路ごとに「その進路にいた車がいた時刻」を集め、赤の間に入って
    // いないかを見る。青のうちに入って赤になってから抜ける分は許す。
    let worst = 0;
    run(traffic, 120, (vehicles, time) => {
      for (const vehicle of vehicles) {
        for (const id of vehicle.route) {
          const lane = graph.lanes[id];
          if (lane.phase === undefined || lane.kind !== 'connector') continue;
          const front = vehicle.bodies[0].pos;
          const start = lane.path.poseAt(0).pos;
          const end = lane.path.poseAt(lane.path.length).pos;
          // その進路の上にいるか (両端のどちらからも進路長の内側)。
          const on =
            front.distanceTo(start) < lane.path.length &&
            front.distanceTo(end) < lane.path.length;
          if (!on || signalStateAt(time, lane.phase) !== 2) continue;
          worst = Math.max(worst, redFor(time, lane.phase));
        }
      }
    });
    // 赤に変わってから交差点を抜けきるまでの猶予。
    expect(worst).toBeLessThan(8);
  });

  it('行き止まりでは転回して戻ってくる', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'road_small', [
      { x: -160, z: 0, y: 0 },
      { x: 160, z: 0, y: 0 },
    ], { straight: true });

    const traffic = new Traffic(laneGraphOf(network));
    const seen = new Map<number, number>();
    let reversed = 0;
    run(traffic, 120, (vehicles) => {
      for (const vehicle of vehicles) {
        const heading = Math.sign(vehicle.bodies[0].dir.x);
        const before = seen.get(vehicle.id);
        if (before !== undefined && before !== 0 && heading !== 0 && before !== heading) {
          reversed++;
        }
        seen.set(vehicle.id, heading);
      }
    });
    expect(traffic.vehicles.length).toBeGreaterThan(0);
    expect(reversed).toBeGreaterThan(0);
  });

  it('列車は線路の上だけを走る', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'rail_single', [
      { x: -400, z: 0, y: 0 },
      { x: 0, z: 0, y: 0 },
      { x: 400, z: 0, y: 0 },
    ], { straight: true });
    draw(network, field, 'road_small', [
      { x: 0, z: -300, y: 0 },
      { x: 0, z: -60, y: 0 },
    ], { straight: true });

    const graph = laneGraphOf(network);
    const traffic = new Traffic(graph);
    const railIds = new Set(
      [...network.segments.values()]
        .filter((s) => network.classOf(s).kind === 'rail')
        .map((s) => s.id),
    );

    let bodies = 0;
    run(traffic, 60, (vehicles) => {
      for (const vehicle of vehicles) {
        if (vehicle.kind !== 'train') continue;
        for (const body of vehicle.bodies) {
          const found = lateralOf(network, body.pos, body.dir);
          expect(found).not.toBeNull();
          expect(railIds.has(found!.segment)).toBe(true);
          // 軌道の中心から外れない。
          expect(Math.abs(found!.lateral)).toBeLessThan(1);
          bodies++;
        }
      }
    });
    expect(bodies).toBeGreaterThan(100);
  });
});

/** その位相の信号が赤になってからの経過時間 [s]。 */
function redFor(time: number, phase: number): number {
  const period = 26;
  const local = (time + phase * (period / 2)) % period;
  return local < 12.5 ? 0 : local - 12.5;
}
