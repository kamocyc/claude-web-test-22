import { Vector3 } from 'three';
import { CROSSWALK_DEPTH, CROSSWALK_OFFSET, STOP_LINE_OFFSET } from '../../src/core/units';
import { heightInTriangleXZ } from '../../src/core/meshbuilder';
import { Traffic, type Vehicle } from '../../src/sim/traffic';
import {
  insidePolygonXZ,
  junctionSurfaceRing,
  trianglesOf,
  type Scene,
  type Violation,
} from './adversarial';

/**
 * 走らせたときの車の検査。
 *
 * 「進む・止まる・曲がる・向きが正しい」を、実際に走らせた軌跡から測る。
 * 判定はどれも見た目の要求から引いていて、許容値の根拠は各検査のコメントに
 * 書いた。
 */

/** 路面メッシュの三角形から、その XZ にある面の高さを引く索引。 */
class SurfaceIndex {
  private readonly cells = new Map<string, number[]>();
  private readonly tris: { a: Vector3; b: Vector3; c: Vector3 }[] = [];

  constructor(scene: Scene, private readonly cell = 8) {
    for (const tri of trianglesOf(scene, 'surfaces')) {
      const id = this.tris.push(tri) - 1;
      const xs = [tri.a.x, tri.b.x, tri.c.x];
      const zs = [tri.a.z, tri.b.z, tri.c.z];
      for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++) {
        for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) {
          const key = `${x},${z}`;
          const list = this.cells.get(key) ?? [];
          list.push(id);
          this.cells.set(key, list);
        }
      }
    }
  }

  /** `y` から `window` [m] 以内にある面のうち、いちばん高いもの。 */
  topNear(x: number, z: number, y: number, window: number): number | null {
    const list = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`);
    if (!list) return null;
    let top: number | null = null;
    for (const id of list) {
      const tri = this.tris[id];
      const height = heightInTriangleXZ(tri.a, tri.b, tri.c, x, z);
      if (height === null || Math.abs(height - y) > window) continue;
      if (top === null || height > top) top = height;
    }
    return top;
  }
}

export interface TrafficReport {
  violations: Violation[];
  /** 舗装の上を走っているか調べた回数。 */
  onPavement: number;
  /** 姿勢を調べた回数 (検査が空振りしていないかの確認)。 */
  samples: number;
  /** 停止線の手前で止まった回数と、その位置 [m]。 */
  stops: number[];
  /** 走った車の数と、その平均速度 [m/s]。 */
  vehicles: number;
  meanSpeed: number;
  /** 1 台が連続で止まっていた最長時間 [s]。 */
  longestStop: number;
}

interface Track {
  pos: Vector3;
  dir: Vector3;
  stopped: number;
}

/** 交通を `seconds` 秒走らせて、車の動きを検査する。 */
export function checkTraffic(scene: Scene, seconds = 60, seed = 7): TrafficReport {
  const out: Violation[] = [];
  const graph = scene.world.laneGraph;
  const traffic = new Traffic(graph, { seed });
  const surfaces = new SurfaceIndex(scene);
  const dt = 1 / 20;
  const last = new Map<number, Track>();
  const stops: number[] = [];
  let samples = 0;
  let speedSum = 0;
  let speedCount = 0;
  let longestStop = 0;
  let onPavement = 0;
  const seen = new Set<number>();
  const pavement = pavementTest(scene);

  const push = (amount: number, where: Vector3, what: string): void => {
    out.push({ scene: scene.name, amount, where: where.clone(), what });
  };

  for (let step = 0; step < seconds / dt; step++) {
    traffic.step(dt);
    for (const vehicle of traffic.vehicles) {
      seen.add(vehicle.id);
      speedSum += vehicle.speed;
      speedCount++;
      const body = vehicle.bodies[0];
      if (!body) continue;
      if (
        !Number.isFinite(body.pos.x) ||
        !Number.isFinite(body.pos.y) ||
        !Number.isFinite(body.pos.z) ||
        !Number.isFinite(body.dir.x)
      ) {
        push(100, new Vector3(), `車両 ${vehicle.id} の姿勢が数値でない`);
        return {
          violations: out,
          onPavement,
          samples,
          stops,
          vehicles: seen.size,
          meanSpeed: 0,
          longestStop,
        };
      }

      // 路面の下を通っていないか。立体交差では自分と同じ高さの面だけを見る。
      const top = surfaces.topNear(body.pos.x, body.pos.z, body.pos.y, 3);
      if (top !== null && top - body.pos.y > 0.06) {
        push(top - body.pos.y, body.pos, `車両 ${vehicle.id} が路面の下を通っている`);
      }

      // 舗装の上を走っているか (車線の外へ膨らんでいないか)。
      // 車体は先頭が次の車線に入っていても後ろはまだ手前の車線なので、
      // いま乗っている経路のどれかの上にいれば舗装の上とみなす。
      let off: number | null = null;
      for (const id of vehicle.route) {
        const value = pavement(id, body.pos);
        if (value === null) continue;
        off = off === null ? value : Math.min(off, value);
      }
      if (off !== null) {
        onPavement++;
        if (off > 0) {
          const lane = graph.lanes[traffic.laneOf(vehicle)];
          push(
            off,
            body.pos,
            `車両 ${vehicle.id} が舗装の外 (${off.toFixed(2)} m) を走っている` +
              ` [${lane.kind} lane=${lane.id} seg=${lane.segment ?? '-'} node=${lane.node ?? '-'}]`,
          );
        }
      }

      const previous = last.get(vehicle.id);
      const track: Track = { pos: body.pos.clone(), dir: body.dir.clone(), stopped: 0 };
      if (previous) {
        const delta = body.pos.clone().sub(previous.pos);
        const moved = Math.hypot(delta.x, delta.z);
        track.stopped = moved < 0.01 ? previous.stopped + dt : 0;
        longestStop = Math.max(longestStop, track.stopped);
        if (moved > 0.05) {
          samples++;
          const heading = new Vector3(delta.x, 0, delta.z).normalize();
          const facing = new Vector3(body.dir.x, 0, body.dir.z).normalize();
          const cos = heading.dot(facing);
          // 車体の向きと進んだ向きのずれ。曲がっている最中でも、1 ステップ
          // (0.05 s) で進む距離は数十 cm なので、旋回半径 5 m でも 4° 程度。
          // 20° を超えるのは、姿勢がねじれているか横滑りしている。
          if (cos < Math.cos((20 * Math.PI) / 180)) {
            push(
              Math.acos(Math.max(-1, Math.min(1, cos))) * (180 / Math.PI),
              body.pos,
              `車両 ${vehicle.id} の向きが進行方向と ${(
                Math.acos(Math.max(-1, Math.min(1, cos))) *
                (180 / Math.PI)
              ).toFixed(0)}° 違う`,
            );
          }
          // 曲がり方の急さ。いちばん急な進路は行き止まりの転回で、
          // 内側の車線どうしの間隔 (3 m) を直径とする半円 = 半径 1.5 m
          // なので 38°/m。サンプリングの誤差を見て 60°/m を上限にする。
          const turn =
            Math.acos(
              Math.max(-1, Math.min(1, new Vector3(previous.dir.x, 0, previous.dir.z).normalize().dot(facing))),
            ) *
            (180 / Math.PI);
          if (turn / moved > 60) {
            push(turn / moved, body.pos, `車両 ${vehicle.id} が ${(turn / moved).toFixed(0)}°/m で向きを変えた`);
          }
        }
      }
      last.set(vehicle.id, track);

      // 停止線での止まり方。行列の先頭だけを見る (後ろは前車で止まる)。
      if (vehicle.speed <= 0.05) {
        const gap = stopGap(traffic, vehicle, graph);
        if (gap !== null) stops.push(gap);
      }
    }
  }

  // 停止位置は停止線 (交差点の面から STOP_LINE_OFFSET 手前)。
  for (const gap of stops) {
    if (gap < CROSSWALK_OFFSET + CROSSWALK_DEPTH) {
      push(CROSSWALK_OFFSET + CROSSWALK_DEPTH - gap, new Vector3(), `横断歩道の上で止まった (${gap.toFixed(2)} m)`);
    } else if (gap < STOP_LINE_OFFSET - 0.6 || gap > STOP_LINE_OFFSET + 1.5) {
      push(Math.abs(gap - STOP_LINE_OFFSET), new Vector3(), `停止線から ${(gap - STOP_LINE_OFFSET).toFixed(2)} m ずれて止まった`);
    }
  }

  return {
    violations: out,
    onPavement,
    samples,
    stops,
    vehicles: seen.size,
    meanSpeed: speedCount ? speedSum / speedCount : 0,
    longestStop,
  };
}

/**
 * 停止線の手前で止まっている車の、交差点の面までの距離 [m]。
 * 前の車で止まっている車と、停止線のない進路は null。
 */
function stopGap(
  traffic: Traffic,
  vehicle: Vehicle,
  graph: Scene['world']['laneGraph'],
): number | null {
  const lane = graph.lanes[traffic.laneOf(vehicle)];
  if (!lane || lane.kind !== 'segment') return null;
  if (!lane.next.some((id) => graph.lanes[id]?.stopLine !== undefined)) return null;
  const front = vehicle.bodies[0].pos;
  const edge = lane.path.poseAt(lane.path.length).pos;
  const gap = front.distanceTo(edge) - vehicle.size.length / 2;
  if (gap >= 12) return null;
  const dir = vehicle.bodies[0].dir;
  const blocked = traffic.vehicles.some((other) => {
    if (other === vehicle) return false;
    const to = other.bodies[other.bodies.length - 1].pos.clone().sub(front);
    return to.dot(dir) > 0 && to.length() < 14;
  });
  return blocked ? null : gap;
}

/**
 * 「その車線を走っている車が舗装からはみ出していないか」を測る関数を作る。
 *
 * セグメントの車線は自分の線形からの横距で、交差点の中の進路は交差点面
 * (いちばん内側のリング) の内側かどうかで見る。行き止まりの転回は
 * リングが無いので、行き止まりの線形の舗装で見る。
 * 返すのは「はみ出した量 [m]」。判定できない所は null。
 */
function pavementTest(scene: Scene): (lane: number, pos: Vector3) => number | null {
  const graph = scene.world.laneGraph;
  const rings = new Map<string, Vector3[]>();
  for (const junction of scene.world.junctions.values()) {
    const ring = junctionSurfaceRing(junction.rings);
    if (ring) rings.set(String(junction.node), ring);
  }
  // 線形ごとの中心線 (2 m 刻み) と半幅。
  const lines = new Map<string, { half: number; pts: Vector3[]; rights: Vector3[] }>();
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const alignment = scene.network.alignmentOf(seg.id);
    const pts: Vector3[] = [];
    const rights: Vector3[] = [];
    const n = Math.max(2, Math.ceil(alignment.length / 2));
    for (let i = 0; i <= n; i++) {
      const sample = alignment.sampleAt((alignment.length * i) / n);
      pts.push(sample.pos.clone());
      rights.push(sample.right.clone());
    }
    lines.set(String(seg.id), { half: cls.carriagewayHalfWidth, pts, rights });
  }

  const lateralOn = (key: string, pos: Vector3): number | null => {
    const line = lines.get(key);
    if (!line) return null;
    let best = Infinity;
    let index = -1;
    for (let i = 0; i < line.pts.length; i++) {
      const d = (line.pts[i].x - pos.x) ** 2 + (line.pts[i].z - pos.z) ** 2;
      if (d < best) {
        best = d;
        index = i;
      }
    }
    if (index < 0) return null;
    const p = line.pts[index];
    const r = line.rights[index];
    return Math.abs((pos.x - p.x) * r.x + (pos.z - p.z) * r.z) - line.half;
  };

  return (laneId: number, pos: Vector3): number | null => {
    const lane = graph.lanes[laneId];
    // 列車は軌道の上を走るもので、道床の多角形の外に出ること自体は
    // おかしくない (分岐器の中はレールだけが敷かれる)。ここでは車だけ見る。
    if (!lane || lane.vehicleKind !== 'car') return null;
    if (lane.kind === 'segment' && lane.segment !== undefined) {
      // 車体の幅の半分 (1.2 m) は車道の外へ出てよい (曲がるとき)。
      const off = lateralOn(String(lane.segment), pos);
      return off === null ? null : off - 1.2;
    }
    if (lane.node === undefined) return null;
    const ring = rings.get(String(lane.node));
    if (ring) {
      if (insidePolygonXZ(ring, pos.x, pos.z)) return -1;
      // 車道リングの外へ出た分 (車体の幅の半分までは縁石の上に載ってよい)。
      return distanceToRing(ring, pos.x, pos.z) - 1.2;
    }
    // 行き止まりの転回。取り付く線形の車道の中にいること。
    const junction = scene.world.junctions.get(lane.node);
    const segment = junction?.approaches[0]?.branch.segment;
    if (segment === undefined) return null;
    const off = lateralOn(String(segment), pos);
    return off === null ? null : off - 1.2;
  };
}

/** 多角形の外周までの距離 (XZ)。 */
function distanceToRing(ring: Vector3[], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const lengthSq = dx * dx + dz * dz;
    let t = 0;
    if (lengthSq > 1e-9) t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / lengthSq));
    best = Math.min(best, Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)));
  }
  return best;
}
