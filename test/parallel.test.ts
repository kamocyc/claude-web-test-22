import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { drawParallel, type Waypoint } from '../src/app/sketch';
import { HorizontalCurve } from '../src/core/curve';
import { getClass } from '../src/network/classes';
import { findCrossings } from '../src/network/crossings';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { defaultSpacing, offsetCurve, parallelTracks } from '../src/network/parallel';
import { computeStructureProfile } from '../src/network/structure';
import { Heightfield } from '../src/terrain/heightfield';

/** 平らな地形。起伏で結果が揺れないようにする。 */
function flatField(): Heightfield {
  return new Heightfield();
}

/** 並列敷設した線路。返り値はセグメント ID の一覧 (敷いた順)。 */
function layParallel(
  network: Network,
  points: Waypoint[],
  count: number,
  classId = 'rail_single',
  options: { straight?: boolean } = {},
): SegmentId[][] {
  return drawParallel(network, flatField(), classId, points, {
    count,
    straight: options.straight ?? true,
  }).map((span) => span.map((r) => r.segment));
}

/** 2 本の線形の距離を、弧長を刻んで測る。 */
function spacingBetween(network: Network, a: SegmentId, b: SegmentId): number[] {
  const alignmentA = network.alignmentOf(a);
  const alignmentB = network.alignmentOf(b);
  const out: number[] = [];
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const point = alignmentA.sampleAt((alignmentA.length * i) / steps).pos;
    let best = Infinity;
    for (let j = 0; j <= steps * 4; j++) {
      const other = alignmentB.sampleAt((alignmentB.length * j) / (steps * 4)).pos;
      best = Math.min(best, Math.hypot(point.x - other.x, point.z - other.z));
    }
    out.push(best);
  }
  return out;
}

describe('オフセット曲線', () => {
  it('直線でも曲線でも、指定した距離だけ離れた曲線になる', () => {
    const curves = [
      HorizontalCurve.straight(new Vector2(0, 0), new Vector2(200, 0)),
      // 半径 120 m 程度の曲線。
      new HorizontalCurve(
        new Vector2(0, 0),
        new Vector2(60, 0),
        new Vector2(120, 20),
        new Vector2(160, 60),
      ),
    ];
    for (const curve of curves) {
      for (const offset of [-9, -4.6, 4.6, 9]) {
        const shifted = offsetCurve(curve, offset);
        let worst = 0;
        for (let i = 0; i <= 40; i++) {
          const p = shifted.pointAt((shifted.length * i) / 40);
          let best = Infinity;
          for (let j = 0; j <= 400; j++) {
            const q = curve.pointAt((curve.length * j) / 400);
            best = Math.min(best, p.distanceTo(q));
          }
          worst = Math.max(worst, Math.abs(best - Math.abs(offset)));
        }
        // この規模 (R≧100 m、ずらす量 10 m 以下) では数 cm に収まる。
        expect(worst).toBeLessThan(0.1);
      }
    }
  });

  it('並べる本数と向きは、左側通行になるよう決まる', () => {
    const rail = getClass('rail_single');
    const spacing = defaultSpacing(rail);
    // 道床の縁が触れ合う幅。重なると面が二重になる。
    expect(spacing).toBeGreaterThanOrEqual(rail.halfWidth * 2);

    const pair = parallelTracks(rail, 2);
    expect(pair.map((t) => t.offset)).toEqual([-spacing / 2, spacing / 2]);
    // 左側通行なので、右側の線は逆向きに走る。
    expect(pair.map((t) => t.reversed)).toEqual([false, true]);

    const triple = parallelTracks(rail, 3);
    expect(triple.map((t) => t.offset)).toEqual([-spacing, 0, spacing]);
    expect(triple.map((t) => t.reversed)).toEqual([false, false, true]);

    // 対向のある道路は向きを変えない (もともと両方向に走れる)。
    expect(parallelTracks(getClass('road_small'), 2).every((t) => !t.reversed)).toBe(true);
  });
});

describe('並列敷設', () => {
  it('複線は 2 本の線路になり、間隔はどこでも一定', () => {
    const network = new Network();
    const spans = layParallel(
      network,
      [
        { x: -200, z: 0, y: 0 },
        { x: 0, z: 0, y: 0 },
        { x: 160, z: 90, y: 0 },
      ],
      2,
      'rail_single',
      { straight: false },
    );
    expect(spans).toHaveLength(2);
    expect(network.segments.size).toBe(4);

    const spacing = defaultSpacing(getClass('rail_single'));
    for (const span of spans) {
      for (const distance of spacingBetween(network, span[0], span[1])) {
        expect(distance).toBeGreaterThan(spacing - 0.15);
        expect(distance).toBeLessThan(spacing + 0.15);
      }
    }
  });

  it('複線の 2 本は互いに逆向きに走る', () => {
    const network = new Network();
    const [[left, right]] = layParallel(network, [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ], 2);

    const dirOf = (id: SegmentId): Vector2 =>
      network.alignmentOf(id).horizontal.tangentAt(0);
    expect(dirOf(left).dot(dirOf(right))).toBeLessThan(-0.99);

    // 逆向きに敷いても、走る車線は必ず線形の向き (一方通行の種別)。
    for (const id of [left, right]) {
      expect(network.classOf(network.getSegment(id)).lanes.every((l) => l.direction === 1)).toBe(
        true,
      );
    }
  });

  it('3 線でも等間隔に並び、中央の線は上り方向のまま', () => {
    const network = new Network();
    const [span] = layParallel(network, [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ], 3);
    expect(span).toHaveLength(3);
    const spacing = defaultSpacing(getClass('rail_single'));
    for (const distance of spacingBetween(network, span[0], span[1])) {
      expect(Math.abs(distance - spacing)).toBeLessThan(0.15);
    }
    for (const distance of spacingBetween(network, span[0], span[2])) {
      expect(Math.abs(distance - spacing * 2)).toBeLessThan(0.2);
    }
  });

  it('続けて引くと、線ごとに前のスパンの端点へ繋がる', () => {
    const network = new Network();
    const spans = layParallel(network, [
      { x: -200, z: 0, y: 0 },
      { x: 0, z: 0, y: 0 },
      { x: 200, z: 0, y: 0 },
    ], 2);
    // 4 本のセグメントに対しノードは 6 個 (継ぎ目で 2 個を共有)。
    expect(network.segments.size).toBe(4);
    expect(network.nodes.size).toBe(6);
    for (let track = 0; track < 2; track++) {
      const first = network.getSegment(spans[0][track]);
      const second = network.getSegment(spans[1][track]);
      const shared = [first.a, first.b].filter((n) => n === second.a || n === second.b);
      expect(shared).toHaveLength(1);
    }
  });

  it('道路を横切ると、線ごとに踏切ができる', () => {
    const network = new Network();
    const field = flatField();
    layParallel(network, [
      { x: 0, z: -200, y: 0 },
      { x: 0, z: 200, y: 0 },
    ], 2);
    drawParallel(network, field, 'road_medium', [
      { x: -200, z: 0, y: 0 },
      { x: 200, z: 0, y: 0 },
    ], { count: 1, straight: true });

    const crossings = findCrossings(network).filter((c) => c.kind === 'level');
    expect(crossings).toHaveLength(2);
  });

  it('片側の線だけを分岐させられる', () => {
    const network = new Network();
    const field = flatField();
    const [span] = layParallel(network, [
      { x: -200, z: 0, y: 0 },
      { x: 200, z: 0, y: 0 },
    ], 2);

    // 右側の線の途中から側線を分ける。
    const target = network.getSegment(span[1]);
    const node = network.splitSegment(target.id, network.alignmentOf(target.id).length / 2);
    drawParallel(network, field, 'rail_yard', [
      { x: node.pos.x, z: node.pos.z, y: 0 },
      { x: node.pos.x + 120, z: node.pos.z + 20, y: 0 },
      { x: node.pos.x + 240, z: node.pos.z + 60, y: 0 },
    ], { count: 1 });

    const junctions = solveJunctions(network).junctions;
    const switches = [...junctions.values()].filter(
      (j) => j.kind === 'railSwitch' && j.approaches.length >= 3,
    );
    expect(switches).toHaveLength(1);
    // 分けていない側の線は、端点以外に節ができていない。
    const untouched = network.getSegment(span[0]);
    expect(network.getNode(untouched.a).segments).toHaveLength(1);
    expect(network.getNode(untouched.b).segments).toHaveLength(1);
  });

  it('谷を渡ると、線ごとに橋ができる', () => {
    const field = new Heightfield();
    // 中央だけ深い谷。
    for (let iz = 0; iz <= field.cells; iz++) {
      for (let ix = 0; ix <= field.cells; ix++) {
        const y = Math.abs(field.worldX(ix)) < 60 ? -20 : 0;
        field.base[field.index(ix, iz)] = y;
        field.work[field.index(ix, iz)] = y;
      }
    }
    const network = new Network();
    const [span] = drawParallel(
      network,
      field,
      'rail_single',
      [
        { x: -200, z: 0, y: 0 },
        { x: 200, z: 0, y: 0 },
      ],
      { count: 2, straight: true },
    ).map((results) => results.map((r) => r.segment));

    for (const id of span) {
      const alignment = network.alignmentOf(id);
      const runs = computeStructureProfile(alignment, field, { s0: 0, s1: alignment.length });
      expect(runs.some((run) => run.mode === 'bridge')).toBe(true);
    }
  });
});

describe('セグメントの反転', () => {
  it('向きを変えても形は変わらない', () => {
    const network = new Network();
    const a = network.addNode(new Vector3(0, 0, 0));
    const b = network.addNode(new Vector3(100, 5, 40));
    const segment = network.addSegment({
      classId: 'rail_single',
      a: a.id,
      b: b.id,
      ctrlA: new Vector2(40, 0),
      ctrlB: new Vector2(70, 20),
      gradeA: 0.02,
      gradeB: 0.06,
    });

    const before = network.alignmentOf(segment.id);
    const length = before.length;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => before.sampleAt(length * t).pos.clone());

    network.reverseSegment(segment.id);
    const after = network.alignmentOf(segment.id);
    expect(after.length).toBeCloseTo(length, 3);
    samples.forEach((point, i) => {
      const mirrored = after.sampleAt(length * (1 - [0, 0.25, 0.5, 0.75, 1][i])).pos;
      expect(mirrored.distanceTo(point)).toBeLessThan(0.02);
    });
    // 端点の勾配は入れ替わって符号が反転する。
    expect(after.vertical.m0).toBeCloseTo(-0.06, 6);
    expect(after.vertical.m1).toBeCloseTo(-0.02, 6);
  });
});
