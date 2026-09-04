import { describe, expect, it } from 'vitest';
import { draw } from '../src/app/sketch';
import { computeCant } from '../src/build/cant';
import { findCrossings } from '../src/network/crossings';
import { RAIL_GAUGE } from '../src/core/units';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { headingOf } from '../src/railsim/adapter/geometry';
import { buildDrivingRoute } from '../src/railsim/adapter/route';
import { occupiedSpeedLimit } from '../src/railsim/core/route/types.ts';
import { buildDrivingScenario } from '../src/railsim/adapter/scenario';
import { Simulation } from '../src/railsim/core/sim/simulation.ts';
import { mpsToKmh } from '../src/railsim/core/units.ts';
import { commuter4Vehicle, compileVehicle } from '../src/railsim/vehicle/index.ts';
import { testField } from './support/field';

/**
 * 経路アダプタ。
 *
 * 敷いた線路を、移植した物理が読める「距離程の関数」へ均す所。ここが狂うと
 * 走りのすべてが狂うので、次の 3 つを数で押さえる。
 *
 * 1. 曲率・勾配・カントが、敷いた線形のものと一致すること
 * 2. 曲率の**符号**が移植元の約束 (正 = 左曲がり) に合っていること
 * 3. 姿勢は railsim の二重積分ではなく、こちらの車線から取ること
 */

/**
 * 描画と同じ車線グラフ。
 *
 * カントは `WorldBuilder` が路面の補正として車線へ渡しているので、ここでも
 * 同じ経路で通す。通さないとカントが恒等的に 0 になり、カントの検定が
 * 「0 と 0 を比べる」ものに化ける。
 */
function laneGraphOf(network: Network): LaneGraph {
  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const length = network.alignmentOf(seg.id).length;
    ranges.set(seg.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  const cant = computeCant(network, findCrossings(network));
  return buildLaneGraph(network, junctions, ranges, {
    surface: (segment, s) => ({ dy: 0, roll: cant.get(segment)?.(s) ?? 0 }),
  });
}

/** 線路の車線を、行けるところまで繋いだ経路。 */
function railChain(graph: LaneGraph): number[] {
  const first = graph.lanes.find((l) => l.vehicleKind === 'train');
  if (!first) throw new Error('線路の車線がありません');
  const chain = [first.id];
  const seen = new Set(chain);
  for (let guard = 0; guard < 64; guard++) {
    const last = graph.lanes[chain[chain.length - 1]!]!;
    const next = last.next.find((id) => !seen.has(id));
    if (next === undefined) break;
    seen.add(next);
    chain.push(next);
  }
  return chain;
}

/** 敷いた線路をひと続きに走る経路を作る。 */
function routeOfRail(graph: LaneGraph) {
  return buildDrivingRoute(graph, railChain(graph));
}

/** 平坦・直線の線路。 */
function straightRail(): LaneGraph {
  const network = new Network();
  const field = testField();
  draw(network, field, 'rail_single', [
    { x: -500, z: 0, y: 20 },
    { x: 500, z: 0, y: 20 },
  ], { straight: true });
  return laneGraphOf(network);
}

/**
 * 曲がる線路。3 点を通す曲線なので、円曲線ではなく曲率が連続して変わる。
 * `turn` が正なら +x へ進んだあと -z 側へ寄る。
 */
function curvedRail(turn: 1 | -1): LaneGraph {
  const network = new Network();
  const field = testField();
  draw(network, field, 'rail_single', [
    { x: -400, z: 0, y: 20 },
    { x: 0, z: 0, y: 20 },
    { x: 350, z: turn * -260, y: 20 },
  ]);
  return laneGraphOf(network);
}

/** 直線 → 曲線 → 直線。曲線を抜けて制限が解ける所がある。 */
function curveThenStraight(): LaneGraph {
  const network = new Network();
  const field = testField();
  draw(network, field, 'rail_single', [
    { x: -400, z: 0, y: 20 },
    { x: 0, z: 0, y: 20 },
    { x: 300, z: -230, y: 20 },
    { x: 700, z: -300, y: 20 },
    { x: 1100, z: -300, y: 20 },
  ]);
  return laneGraphOf(network);
}

describe('経路アダプタ: 線形', () => {
  it('平坦・直線では曲率も勾配もカントも 0', () => {
    const route = routeOfRail(straightRail());
    for (let s = 0; s <= route.length; s += 25) {
      expect(Math.abs(route.compiled.alignment.curvatureAt(s))).toBeLessThan(1e-4);
      expect(Math.abs(route.compiled.alignment.gradeAt(s))).toBeLessThan(1e-4);
      expect(Math.abs(route.compiled.alignment.cantAt(s))).toBeLessThan(1e-4);
    }
  });

  it('曲率が、車線の方位角の変化率と一致する', () => {
    const route = routeOfRail(curvedRail(1));
    // 曲率を積んだものが方位角の変化になっているか。アダプタが測った κ が
    // 実際に走る道筋のものであることの確認。
    const a = route.length * 0.15;
    const b = route.length * 0.85;
    const turned = headingDelta(route, a, b);
    const integrated = integrate((s) => route.compiled.alignment.curvatureAt(s), a, b);
    expect(integrated).toBeCloseTo(turned, 3);
    // 曲がっていること自体も確かめる (0 どうしを比べていないこと)
    expect(Math.abs(turned)).toBeGreaterThan(0.3);
  });

  it('曲率の符号が移植元の約束 (正 = 左曲がり) に合う', () => {
    // 移植元の平面位置は x = cos θ, z = -sin θ なので、θ が増える向きが左。
    for (const turn of [1, -1] as const) {
      const route = routeOfRail(curvedRail(turn));
      const a = route.length * 0.15;
      const b = route.length * 0.85;
      const turned = headingDelta(route, a, b);
      const mid = route.compiled.alignment.curvatureAt((a + b) / 2);
      expect(Math.sign(mid)).toBe(Math.sign(turned));
    }
  });

  it('勾配が、実際に登る高さと一致する', () => {
    const network = new Network();
    const field = testField();
    draw(network, field, 'rail_single', [
      { x: -400, z: 0, y: 10 },
      { x: 400, z: 0, y: 34 },
    ], { straight: true });
    const route = routeOfRail(laneGraphOf(network));
    const a = route.length * 0.1;
    const b = route.length * 0.9;
    const rise = route.poseAt(b).pos.y - route.poseAt(a).pos.y;
    expect(integrate((s) => route.compiled.alignment.gradeAt(s), a, b)).toBeCloseTo(rise, 2);
    // 24 m / 800 m = 30‰ 程度の勾配になっている
    expect(route.compiled.alignment.gradeAt(route.length / 2)).toBeGreaterThan(0.02);
  });

  it('カントの符号は「曲線外側のレールが高い」で正', () => {
    for (const turn of [1, -1] as const) {
      const route = routeOfRail(curvedRail(turn));
      const s = route.length / 2;
      const k = route.compiled.alignment.curvatureAt(s);
      const cant = route.compiled.alignment.cantAt(s);
      // 曲線にはカントが付いている
      expect(Math.abs(cant)).toBeGreaterThan(0.005);
      // 移植元では「曲率が正 (左曲線) ならカント角も正」。取り違えると
      // 車体が曲線の外側ではなく内側へ倒れる。
      expect(Math.sign(cant)).toBe(Math.sign(k));
      expect(Math.sign(route.compiled.alignment.cantAngleAt(s))).toBe(Math.sign(k));
      // カントは軌間より小さい (物理的にありえない量になっていない)
      expect(Math.abs(cant)).toBeLessThan(RAIL_GAUGE * 0.2);
    }
  });

  it('カントが遠心力を打ち消す向きに付いている', () => {
    const route = routeOfRail(curvedRail(1));
    const s = route.length / 2;
    const k = route.compiled.alignment.curvatureAt(s);
    const v = route.compiled.speedLimits.at(s);
    // カントのぶんだけ横加速度が減る。カントを 0 とみなした場合より小さいこと。
    const withCant = Math.abs(route.compiled.alignment.lateralAcceleration(s, v));
    const withoutCant = Math.abs(v * v * k);
    expect(withCant).toBeLessThan(withoutCant);
  });
});

describe('経路アダプタ: 姿勢', () => {
  it('距離程から引く姿勢が、もとの車線のものと同じ', () => {
    const graph = curvedRail(1);
    const lane = graph.lanes.find((l) => l.vehicleKind === 'train')!;
    const route = buildDrivingRoute(graph, [lane.id]);
    for (let s = 0; s <= route.length; s += 7) {
      const mine = route.poseAt(s);
      const theirs = lane.path.poseAt(s);
      expect(mine.pos.distanceTo(theirs.pos)).toBeLessThan(1e-9);
    }
  });

  it('railsim の二重積分した位置は使わない (使うとレールから外れる)', () => {
    const route = routeOfRail(curvedRail(1));
    // `Alignment` は起点を原点・方位 0 として κ と i を積むので、こちらの
    // 世界座標とは関係が無い。これを姿勢に使っていないことを見ておく。
    const integrated = route.compiled.alignment.positionAt(route.length / 2);
    const real = route.poseAt(route.length / 2).pos;
    expect(Math.hypot(real.x - integrated.x, real.z - integrated.z)).toBeGreaterThan(10);
  });

  it('車線を繋いだ経路では、距離程が車線をまたいで通る', () => {
    const graph = curvedRail(1);
    const chain = railChain(graph);
    expect(chain.length).toBeGreaterThan(1);
    const first = graph.lanes[chain[0]!]!;
    const route = buildDrivingRoute(graph, chain);
    expect(route.lanes.length).toBe(chain.length);
    expect(route.length).toBeGreaterThan(first.path.length);
    // 継ぎ目の前後で姿勢が飛ばない
    const seam = first.path.length;
    const before = route.poseAt(seam - 0.05).pos;
    const after = route.poseAt(seam + 0.05).pos;
    expect(before.distanceTo(after)).toBeLessThan(0.5);
  });
});

describe('経路アダプタ: 制限速度', () => {
  it('直線では線区の最高速度がそのまま出る', () => {
    const route = routeOfRail(straightRail());
    const mid = route.length / 2;
    expect(route.compiled.speedLimits.at(mid)).toBeCloseTo(route.compiled.maxSpeed, 6);
  });

  it('曲線では最高速度より低い制限が立つ', () => {
    const route = routeOfRail(curvedRail(1));
    const limits = [];
    for (let s = 0; s <= route.length; s += 5) limits.push(route.compiled.speedLimits.at(s));
    const lowest = Math.min(...limits);
    expect(lowest).toBeLessThan(route.compiled.maxSpeed);
    // 5 km/h 刻みに切り下がっている
    expect((lowest * 3.6) % 5).toBeCloseTo(0, 6);
  });

  it('制限は曲線の全体にかかる (緩和曲線の途中で緩まない)', () => {
    const route = routeOfRail(curvedRail(1));
    // 制限のかかっている範囲を拾って、その中で値が上下しないことを見る。
    // 点ごとの半径から素直に決めると、緩和曲線の途中だけ制限が緩くなり、
    // 「落として、上げて、また落とす」という運転できない階段になる。
    let inCurve = false;
    let current = 0;
    for (let s = 0; s <= route.length; s += 2) {
      const limit = route.compiled.speedLimits.at(s);
      if (limit >= route.compiled.maxSpeed) {
        inCurve = false;
        continue;
      }
      if (!inCurve) {
        inCurve = true;
        current = limit;
        continue;
      }
      expect(limit).toBeCloseTo(current, 6);
    }
    expect(inCurve || current > 0).toBe(true);
  });

  it('編成の在線範囲で引くと、曲線を抜けたあとも制限が続く', () => {
    const route = routeOfRail(curveThenStraight());
    // 制限が解ける点を探す
    let release = -1;
    for (let s = 2; s <= route.length; s += 1) {
      if (
        route.compiled.speedLimits.at(s - 1) < route.compiled.maxSpeed &&
        route.compiled.speedLimits.at(s) >= route.compiled.maxSpeed
      ) {
        release = s;
        break;
      }
    }
    expect(release).toBeGreaterThan(0);
    // 先頭が抜けた直後は、点で引けば制限が解けている
    const front = release + 10;
    expect(route.compiled.speedLimits.at(front)).toBeGreaterThanOrEqual(route.compiled.maxSpeed);
    // ところが 80 m の編成の後ろはまだ曲線の中にいる。在線範囲で引けば
    // 制限は続いたままになる (`occupiedSpeedLimit` の考え方)。
    const occupied = occupiedSpeedLimit(route.compiled.speedLimits, {
      rear: front - 80,
      front,
    });
    expect(occupied).toBeLessThan(route.compiled.maxSpeed);
  });
});

/** [a, b] の方位角の変化 [rad]。 */
function headingDelta(
  route: { poseAt(s: number): { dir: { x: number; z: number } } },
  a: number,
  b: number,
): number {
  let previous = headingOf(route.poseAt(a).dir);
  let total = 0;
  const steps = 200;
  for (let i = 1; i <= steps; i++) {
    const h = headingOf(route.poseAt(a + ((b - a) * i) / steps).dir);
    let d = h - previous;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    previous = h;
  }
  return total;
}

/** [a, b] の台形則による積分。 */
function integrate(f: (s: number) => number, a: number, b: number, steps = 2000): number {
  const h = (b - a) / steps;
  let total = (f(a) + f(b)) / 2;
  for (let i = 1; i < steps; i++) total += f(a + i * h);
  return total * h;
}

describe('経路アダプタ: 敷いた線路の上を走らせる', () => {
  /** 通勤形 4 両編成を、敷いた線路の上に置く。 */
  function simOn(graph: LaneGraph) {
    const consist = compileVehicle(commuter4Vehicle);
    const consistLength = consist.vehicles.reduce((a, v) => a + v.length, 0);
    const route = buildDrivingRoute(graph, railChain(graph), { consistLength });
    return { route, sim: new Simulation(buildDrivingScenario(route, consist)) };
  }

  it('力行すれば加速し、常用ブレーキで止まる', () => {
    const { sim } = simOn(straightRail());
    sim.input = { ...sim.input, powerNotch: 4 };
    for (let i = 0; i < 2000; i++) sim.step(0.01);
    // 20 秒の力行で 60km/h 前後まで上がる (起動加速度 3.3km/h/s の公称どおり)
    expect(mpsToKmh(sim.speed)).toBeGreaterThan(50);

    sim.input = { ...sim.input, powerNotch: 0, brakeNotch: 8 };
    for (let i = 0; i < 4000; i++) sim.step(0.01);
    expect(sim.speed).toBeLessThan(0.2);
  });

  it('勾配では、力行しなければ速度が落ちる', () => {
    const network = new Network();
    const field = testField();
    draw(network, field, 'rail_single', [
      { x: -400, z: 0, y: 10 },
      { x: 400, z: 0, y: 34 },
    ], { straight: true });
    const { sim } = simOn(laneGraphOf(network));
    sim.input = { ...sim.input, powerNotch: 4 };
    for (let i = 0; i < 1500; i++) sim.step(0.01);
    const top = sim.speed;
    sim.input = { ...sim.input, powerNotch: 0 };
    for (let i = 0; i < 1500; i++) sim.step(0.01);
    // 30‰ の上り勾配で惰行すれば、走行抵抗だけの場合よりずっと速く落ちる
    expect(sim.speed).toBeLessThan(top * 0.7);
  });

  it('曲線では横加速度が出て、カントがそれを減らす', () => {
    const graph = curvedRail(1);
    const { route, sim } = simOn(graph);
    // 曲線のいちばん急な所を探す
    let peak = 0;
    let at = 0;
    for (let s = 0; s <= route.length; s += 2) {
      const k = Math.abs(route.compiled.alignment.curvatureAt(s));
      if (k > peak) {
        peak = k;
        at = s;
      }
    }
    const v = route.compiled.speedLimits.at(at);
    const withCant = route.compiled.alignment.lateralAcceleration(at, v);
    // 制限速度いっぱいで走っても、許容カント不足の範囲に収まる
    expect(Math.abs(withCant)).toBeLessThan(1.2);
    // 走らせても発散しない (物理が線形を受け付けている)
    sim.input = { ...sim.input, powerNotch: 3 };
    for (let i = 0; i < 1000; i++) sim.step(0.01);
    expect(Number.isFinite(sim.speed)).toBe(true);
    expect(sim.speed).toBeGreaterThan(0);
  });
});
