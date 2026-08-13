import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { buildInterchange } from '../src/app/interchange';
import { draw, type Waypoint } from '../src/app/sketch';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { Traffic } from '../src/sim/traffic';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';

/**
 * 車線と交通シミュレーションに対する敵対的検証。
 *
 * 「車が対向車線を逆走する」「舗装から外れて草の上を走る」「交差点で
 * 消える・瞬間移動する」といった壊れ方を狙って、意地の悪い配置を組み立て、
 * 車線グラフと走行結果を幾何的に検査する。
 *
 * 判定はどれも「この配置ならこう見えるはず」という見た目の要求から
 * 引いている。許容値の根拠は各検査のコメントに書いた。
 */

interface Scene {
  name: string;
  network: Network;
  graph: LaneGraph;
}

function sceneOf(
  name: string,
  build: (network: Network, field: Heightfield) => void,
  seed?: number,
): Scene {
  const field = new Heightfield();
  if (seed !== undefined) generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  const network = new Network();
  build(network, field);

  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const length = network.alignmentOf(seg.id).length;
    ranges.set(seg.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return { name, network, graph: buildLaneGraph(network, junctions, ranges) };
}

// ---------------------------------------------------------------- 場面

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const ROAD_IDS = ['road_small', 'road_medium', 'road_large', 'road_highway', 'road_ramp'];
const RAIL_IDS = ['rail_single', 'rail_double', 'rail_yard'];

/** 道路・線路をでたらめに何本か引く。T 字の取り付きも混ぜる。 */
function fuzzBuild(network: Network, field: Heightfield, seed: number): void {
  const r = rng(seed);
  const count = 2 + Math.floor(r() * 4);
  for (let i = 0; i < count; i++) {
    const isRail = r() < 0.3;
    const id = isRail
      ? RAIL_IDS[Math.floor(r() * RAIL_IDS.length)]
      : ROAD_IDS[Math.floor(r() * ROAD_IDS.length)];
    const angle = r() * Math.PI * 2;
    const cx = (r() - 0.5) * 120;
    const cz = (r() - 0.5) * 120;
    const half = 120 + r() * 180;
    const y = r() < 0.25 ? (r() - 0.5) * 20 : 0;
    const points: Waypoint[] = [];
    const steps = 2 + Math.floor(r() * 3);
    for (let k = 0; k <= steps; k++) {
      const t = -half + (2 * half * k) / steps;
      const bend = (r() - 0.5) * 60;
      points.push({
        x: cx + Math.cos(angle) * t - Math.sin(angle) * bend,
        z: cz + Math.sin(angle) * t + Math.cos(angle) * bend,
        y,
      });
    }
    draw(network, field, id, points, { straight: r() < 0.6 });
  }
}

const SCENES: (() => Scene)[] = [
  () => sceneOf('サンプル', (n, f) => buildDemoNetwork(n, f), DEFAULT_TERRAIN.seed),
  () => sceneOf('インター', (n, f) => buildInterchange(n, f), DEFAULT_TERRAIN.seed),
  () =>
    sceneOf('鋭角の交差点', (n, f) => {
      draw(n, f, 'road_medium', [{ x: -220, z: 0, y: 0 }, { x: 220, z: 0, y: 0 }], {
        straight: true,
      });
      draw(n, f, 'road_small', [{ x: -180, z: -150, y: 0 }, { x: 200, z: 150, y: 0 }], {
        straight: true,
      });
    }),
  () =>
    sceneOf('幅の違う道路の十字路', (n, f) => {
      draw(n, f, 'road_large', [{ x: -240, z: 0, y: 0 }, { x: 240, z: 0, y: 0 }], {
        straight: true,
      });
      draw(n, f, 'road_small', [{ x: 0, z: -240, y: 0 }, { x: 0, z: 240, y: 0 }], {
        straight: true,
      });
    }),
  () =>
    sceneOf('一方通行の行き止まり', (n, f) => {
      draw(n, f, 'road_ramp', [{ x: -150, z: 0, y: 0 }, { x: 150, z: 0, y: 0 }], {
        straight: true,
      });
    }),
  () =>
    sceneOf('分岐器とクロッシング', (n, f) => {
      draw(n, f, 'rail_double', [{ x: -300, z: 0, y: 0 }, { x: 300, z: 0, y: 0 }], {
        straight: true,
      });
      draw(n, f, 'rail_single', [{ x: 0, z: -300, y: 0 }, { x: 0, z: 300, y: 0 }], {
        straight: true,
      });
      draw(n, f, 'rail_yard', [
        { x: -160, z: 0, y: 0 },
        { x: -40, z: 40, y: 0 },
        { x: 80, z: 60, y: 0 },
      ]);
    }),
  () =>
    sceneOf('立体交差 (繋がらない交差)', (n, f) => {
      draw(n, f, 'road_medium', [{ x: -240, z: 0, y: 0 }, { x: 240, z: 0, y: 0 }], {
        straight: true,
      });
      draw(n, f, 'road_medium', [{ x: 0, z: -240, y: 12 }, { x: 0, z: 240, y: 12 }], {
        straight: true,
      });
    }),
];

// ------------------------------------------------------------ 検査

interface Violation {
  scene: string;
  message: string;
  amount: number;
}

/** 車線グラフの繋ぎ目。前の車線の終わりと、次の車線の始まりが一致するか。 */
function checkLinks(scene: Scene): Violation[] {
  const out: Violation[] = [];
  for (const lane of scene.graph.lanes) {
    const end = lane.path.poseAt(lane.path.length);
    for (const id of lane.next) {
      const next = scene.graph.lanes[id];
      const start = next.path.poseAt(0);
      const gap = end.pos.distanceTo(start.pos);
      if (gap > 0.05) {
        out.push({
          scene: scene.name,
          message: `車線 ${lane.id} → ${id} の継ぎ目が ${gap.toFixed(2)} m 開いている`,
          amount: gap,
        });
      }
      // 繋ぎ目で向きが反転していると、車がその場で向きを変えてしまう。
      const dot = end.dir.dot(start.dir);
      if (dot < 0.5) {
        out.push({
          scene: scene.name,
          message: `車線 ${lane.id} → ${id} の繋ぎ目で向きが ${(
            Math.acos(Math.max(-1, dot)) *
            (180 / Math.PI)
          ).toFixed(0)}° 変わる`,
          amount: 1 - dot,
        });
      }
      if (next.vehicleKind !== lane.vehicleKind) {
        out.push({
          scene: scene.name,
          message: `車線 ${lane.id} (${lane.vehicleKind}) から ${id} (${next.vehicleKind}) へ繋がっている`,
          amount: 10,
        });
      }
    }
  }
  return out;
}

/** 走らせたときの、車の位置・向き・重なりの検査。調べた回数も返す。 */
function checkRun(scene: Scene, seconds = 60): { violations: Violation[]; samples: number } {
  const out: Violation[] = [];
  const traffic = new Traffic(scene.graph);
  const dt = 1 / 20;
  let samples = 0;

  for (let i = 0; i < seconds / dt; i++) {
    traffic.step(dt);
    for (const vehicle of traffic.vehicles) {
      for (const body of vehicle.bodies) {
        if (!Number.isFinite(body.pos.x) || !Number.isFinite(body.pos.y)) {
          out.push({ scene: scene.name, message: '車両の位置が数値でない', amount: 100 });
          return { violations: out, samples };
        }
      }
      // 逆走していないか。判定は「その車がいま乗っている車線の線形」に
      // 対して行う。いちばん近い線形で測ると、ファズで道路どうしが
      // 重なって引かれたときに別の道路と比べてしまう。
      const body = vehicle.bodies[0];
      const lane = scene.graph.lanes[traffic.laneOf(vehicle)];
      const near =
        lane?.segment === undefined
          ? null
          : lateralOn(scene.network, lane.segment, body.pos, body.dir);
      if (near && !near.inJunction && Math.abs(near.along) > 0.9) {
        samples++;
        const wrongSide = Math.sign(near.lateral) === (near.along > 0 ? 1 : -1);
        const depth = Math.abs(near.lateral);
        // 中心線をまたいで 0.6 m 以上入っていたら逆走とみなす。
        if (wrongSide && depth > 0.6) {
            out.push({
            scene: scene.name,
            message: `車両 ${vehicle.id} が対向車線に ${depth.toFixed(1)} m はみ出している`,
            amount: depth,
          });
        }
        // 舗装から外れていないか。
        if (depth > near.halfWidth + 0.5) {
          out.push({
            scene: scene.name,
            message: `車両 ${vehicle.id} が舗装の外 (${depth.toFixed(1)} m) を走っている`,
            amount: depth,
          });
        }
      }
    }

    // 同じ車線を走る車どうしが重なっていないか (追突)。
    // ファズでは道路そのものが重なって引かれることがあるので、別の車線に
    // いる車どうしの距離は見ない (配置の作り方の問題で、走り方の問題ではない)。
    const list = traffic.vehicles;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const pa = list[a].bodies[0];
        const pb = list[b].bodies[0];
        const distance = pa.pos.distanceTo(pb.pos);
        const sameLane = traffic.laneOf(list[a]) === traffic.laneOf(list[b]);
        if (!sameLane || distance > 2.2 || pa.dir.dot(pb.dir) < 0.7) continue;
        out.push({
          scene: scene.name,
          message: `車両 ${list[a].id} と ${list[b].id} が ${distance.toFixed(1)} m まで重なった`,
          amount: 10 - distance,
        });
      }
    }
  }
  return { violations: out, samples };
}

/** 指定した線形に対する、進行方向から見た横距。 */
function lateralOn(
  network: Network,
  segment: SegmentId,
  pos: Vector3,
  dir: Vector3,
): { lateral: number; along: number; halfWidth: number; inJunction: boolean } | null {
  const seg = network.getSegment(segment);
  const cls = network.classOf(seg);
  const alignment = network.alignmentOf(segment);
  // 中心線上でいちばん近い点を探す。
  let best = 0;
  let bestDistance = Infinity;
  const steps = Math.max(8, Math.ceil(alignment.length / 2));
  for (let i = 0; i <= steps; i++) {
    const s = (alignment.length * i) / steps;
    const p = alignment.horizontal.pointAt(s);
    const d = (p.x - pos.x) ** 2 + (p.y - pos.z) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = s;
    }
  }
  const sample = alignment.sampleAt(best);
  const lateral =
    (pos.x - sample.pos.x) * sample.right.x + (pos.z - sample.pos.z) * sample.right.z;
  // 交差点の中 (ノードの近く) は進路が中心線をまたぐので判定しない。
  const nodes = [network.getNode(seg.a).pos, network.getNode(seg.b).pos];
  const inJunction = nodes.some((n) => n.distanceTo(pos) < cls.halfWidth * 3 + 12);
  const along = dir.x * sample.forward.x + dir.z * sample.forward.z;
  return { lateral, along, halfWidth: cls.halfWidth, inJunction };
}

function report(violations: Violation[]): string[] {
  return [...violations]
    .sort((a, b) => b.amount - a.amount)
    .map((v) => `[${v.scene}] ${v.message}`);
}

describe('車線と交通 (敵対的検証)', () => {
  it('車線の繋ぎ目が開かず、向きも反転しない', () => {
    const violations: Violation[] = [];
    for (const make of SCENES) violations.push(...checkLinks(make()));
    for (let seed = 1; seed <= 40; seed++) {
      violations.push(...checkLinks(sceneOf(`fuzz#${seed}`, (n, f) => fuzzBuild(n, f, seed))));
    }
    expect(report(violations).slice(0, 10)).toEqual([]);
  });

  it('意地の悪い配置でも、車が逆走・脱線・追突しない', () => {
    const violations: Violation[] = [];
    let samples = 0;
    for (const make of SCENES) {
      const result = checkRun(make(), 45);
      violations.push(...result.violations);
      samples += result.samples;
    }
    expect(report(violations).slice(0, 10)).toEqual([]);
    // 検査が空振りしていないこと。
    expect(samples).toBeGreaterThan(5000);
  });

  it('ランダムな配置でも走り続けられる (ファズ)', () => {
    const violations: Violation[] = [];
    const crashes: string[] = [];
    let samples = 0;
    for (let seed = 1; seed <= 24; seed++) {
      try {
        const result = checkRun(sceneOf(`fuzz#${seed}`, (n, f) => fuzzBuild(n, f, seed)), 30);
        violations.push(...result.violations);
        samples += result.samples;
      } catch (e) {
        crashes.push(`fuzz#${seed}: ${(e as Error).message}`);
      }
    }
    expect([...crashes, ...report(violations).slice(0, 10)]).toEqual([]);
    expect(samples).toBeGreaterThan(5000);
  });
});
