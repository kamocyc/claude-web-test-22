import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector2, Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { draw, drawParallel, parallelTracks, type Waypoint } from '../src/app/sketch';
import { HorizontalCurve } from '../src/core/curve';
import { getClass } from '../src/network/classes';
import { findCrossings } from '../src/network/crossings';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import {
  findParallelGroups,
  findParallelReference,
  offsetCurve,
  parallelAlignment,
  parallelSpacing,
} from '../src/network/parallel';
import { computeStructureProfile } from '../src/network/structure';
import { WorldBuilder } from '../src/render/worldBuilder';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

/** 平らな地形。起伏で結果が揺れないようにする。 */
function flatField(): Heightfield {
  return testField();
}

/** 谷を 1 本刻んだ地形。橋になる区間を作るのに使う。 */
function valleyField(halfWidth = 60, depth = -20): Heightfield {
  const field = testField();
  for (let iz = 0; iz <= field.cells; iz++) {
    for (let ix = 0; ix <= field.cells; ix++) {
      const y = Math.abs(field.worldX(ix)) < halfWidth ? depth : 0;
      field.base[field.index(ix, iz)] = y;
      field.work[field.index(ix, iz)] = y;
    }
  }
  return field;
}

/** 並べて敷いた線路。返り値はスパンごとのセグメント ID。 */
function layParallel(
  network: Network,
  points: Waypoint[],
  count: number,
  classId = 'rail_single',
  options: { straight?: boolean; field?: Heightfield } = {},
): SegmentId[][] {
  return drawParallel(network, options.field ?? flatField(), classId, points, {
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

/** 敷設ツールで 1 スパン引く (カーソルを動かしてクリックするのと同じ)。 */
function drawWithTool(
  tool: BuildTool,
  points: Vector3[],
  modifiers = { straight: false, noSnap: false },
): void {
  for (const point of points) {
    tool.update(point, modifiers);
    tool.click();
  }
  tool.cancel();
}

function toolOn(network: Network, field: Heightfield, classId: string): BuildTool {
  const tool = new BuildTool(network, field, () => {});
  tool.setClass(classId);
  return tool;
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

  it('間隔は舗装 (道床) の縁が触れ合う幅になる', () => {
    const rail = getClass('rail_single');
    const road = getClass('road_small');
    expect(parallelSpacing(rail)).toBeGreaterThanOrEqual(rail.halfWidth * 2);
    // 種別が違えば、それぞれの半幅を足した間隔になる。
    expect(parallelSpacing(rail, road)).toBeCloseTo(
      Math.round((rail.halfWidth + road.halfWidth + 0.2) * 10) / 10,
      6,
    );
  });
});

describe('平行スナップ', () => {
  it('既存の線路の隣にカーソルを置くと、規定の間隔にスナップする', () => {
    const network = new Network();
    layParallel(network, [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ], 1);

    const cls = getClass('rail_single');
    const spacing = parallelSpacing(cls);
    // 中途半端な距離 (7 m) に置いても、間隔ちょうどの位置に寄る。
    const found = findParallelReference(network, cls, new Vector3(0, 0, 7));
    expect(found).not.toBeNull();
    expect(Math.abs(found!.offset)).toBeCloseTo(spacing, 6);
    expect(Math.hypot(found!.pos.x - 0, found!.pos.z - 0)).toBeCloseTo(spacing, 3);

    // 遠すぎる所・線形の上には寄らない。
    expect(findParallelReference(network, cls, new Vector3(0, 0, 40))).toBeNull();
    expect(findParallelReference(network, cls, new Vector3(0, 0, 0.5))).toBeNull();
  });

  it('曲線に平行して引くと、間隔がどこでも一定になる', () => {
    const network = new Network();
    const field = flatField();
    // 曲がった線路を 1 本引く。
    draw(network, field, 'rail_single', [
      { x: -200, z: 0, y: 0 },
      { x: 0, z: 0, y: 0 },
      { x: 160, z: 90, y: 0 },
    ]);
    const original = [...network.segments.keys()];

    const cls = getClass('rail_single');
    const spacing = parallelSpacing(cls);
    const tool = toolOn(network, field, 'rail_single');
    // 1 本目の右側をなぞる。カーソルは大まかでよい (スナップが決める)。
    for (const id of original) {
      const alignment = network.alignmentOf(id);
      const start = alignment.sampleAt(0);
      const end = alignment.sampleAt(alignment.length);
      drawWithTool(tool, [
        new Vector3(
          start.pos.x + start.right.x * (spacing + 2),
          0,
          start.pos.z + start.right.z * (spacing + 2),
        ),
        new Vector3(
          end.pos.x + end.right.x * (spacing - 1.5),
          0,
          end.pos.z + end.right.z * (spacing - 1.5),
        ),
      ]);
    }

    const added = [...network.segments.keys()].filter((id) => !original.includes(id));
    expect(added).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) {
      for (const distance of spacingBetween(network, original[i], added[i])) {
        expect(Math.abs(distance - spacing)).toBeLessThan(0.15);
      }
    }
  });

  it('平行に敷いた線形は、高さと勾配を基準の線形から引き継ぐ', () => {
    const network = new Network();
    const field = flatField();
    // 起伏のある縦断で 1 本引く。
    draw(network, field, 'rail_single', [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 4 },
    ]);
    const [reference] = [...network.segments.keys()];
    const alignment = network.alignmentOf(reference);
    const spacing = parallelSpacing(getClass('rail_single'));

    const parallel = parallelAlignment(alignment, 0, alignment.length, spacing);
    expect(parallel).not.toBeNull();
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = alignment.sampleAt(alignment.length * t).pos;
      const b = parallel!.sampleAt(parallel!.length * t).pos;
      expect(Math.abs(a.y - b.y)).toBeLessThan(0.02);
    }
  });

  it('逆向きに引いても、間隔と高さは同じで向きだけが逆になる', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'rail_single', [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 3 },
    ]);
    const [reference] = [...network.segments.keys()];
    const alignment = network.alignmentOf(reference);
    const spacing = parallelSpacing(getClass('rail_single'));

    const forward = parallelAlignment(alignment, 0, alignment.length, spacing)!;
    const backward = parallelAlignment(alignment, alignment.length, 0, spacing)!;
    expect(backward.length).toBeCloseTo(forward.length, 3);
    // 始点と終点が入れ替わる。
    expect(backward.sampleAt(0).pos.distanceTo(forward.sampleAt(forward.length).pos)).toBeLessThan(
      0.05,
    );
    // どちらの向きでも、基準の同じ側に同じ間隔で並ぶ。
    for (const parallel of [forward, backward]) {
      for (let i = 0; i <= 10; i++) {
        const p = parallel.sampleAt((parallel.length * i) / 10).pos;
        const q = alignment.sampleAt(alignment.length * (i / 10)).pos;
        // 高さも基準と同じ (弧長の向きが逆でも縦断は入れ替わるだけ)。
        const mirrored = forward === parallel ? q : alignment.sampleAt(
          alignment.length * (1 - i / 10),
        ).pos;
        expect(Math.abs(p.y - mirrored.y)).toBeLessThan(0.05);
      }
    }
    const mid = backward.sampleAt(backward.length / 2).pos;
    const refMid = alignment.sampleAt(alignment.length / 2).pos;
    expect(Math.hypot(mid.x - refMid.x, mid.z - refMid.z)).toBeCloseTo(spacing, 1);
  });

  it('スナップなし (Ctrl) では平行にならず、指した所に引ける', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'rail_single', [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ]);
    const spacing = parallelSpacing(getClass('rail_single'));
    const tool = toolOn(network, field, 'rail_single');
    const before = network.segments.size;

    drawWithTool(
      tool,
      [new Vector3(-100, 0, spacing + 3), new Vector3(100, 0, spacing + 3)],
      { straight: false, noSnap: true },
    );
    expect(network.segments.size).toBe(before + 1);
    const added = [...network.segments.keys()].pop()!;
    // 指した位置 (間隔 + 3 m) のまま引けている。
    const distances = spacingBetween(network, [...network.segments.keys()][0], added);
    expect(Math.min(...distances)).toBeGreaterThan(spacing + 1);
  });

  it('平行スナップを切ると寄らない', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'rail_single', [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ]);
    const spacing = parallelSpacing(getClass('rail_single'));
    const tool = toolOn(network, field, 'rail_single');
    tool.setParallelSnap(false);
    tool.update(new Vector3(0, 0, spacing + 2.5), { straight: false, noSnap: false });
    expect(tool.status().snap).not.toBe('parallel');
    expect(tool.status().parallelSnap).toBe(false);
  });
});

describe('平行に並んだ線形の判定', () => {
  it('複線は 1 つのまとまりとして見つかり、離れた線形は入らない', () => {
    const network = new Network();
    const [span] = layParallel(network, [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ], 2);
    // 遠く離れた 3 本目。
    draw(network, flatField(), 'rail_single', [
      { x: -150, z: 80, y: 0 },
      { x: 150, z: 80, y: 0 },
    ]);

    const groups = findParallelGroups(network);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.slice().sort((a, b) => a - b)).toEqual(
      span.slice().sort((a, b) => a - b),
    );
  });

  it('交差する線形や、繋がっている線形は平行とみなさない', () => {
    const network = new Network();
    const field = flatField();
    draw(network, field, 'rail_single', [
      { x: -150, z: 0, y: 0 },
      { x: 150, z: 0, y: 0 },
    ]);
    draw(network, field, 'rail_single', [
      { x: 0, z: -150, y: 0 },
      { x: 0, z: 150, y: 0 },
    ]);
    expect(findParallelGroups(network)).toHaveLength(0);
  });
});

describe('平行に並んだ線形の扱い', () => {
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

    const spacing = parallelSpacing(getClass('rail_single'));
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
    const spacing = parallelSpacing(getClass('rail_single'));
    for (const distance of spacingBetween(network, span[0], span[1])) {
      expect(Math.abs(distance - spacing)).toBeLessThan(0.15);
    }
    for (const distance of spacingBetween(network, span[0], span[2])) {
      expect(Math.abs(distance - spacing * 2)).toBeLessThan(0.2);
    }
    // 左側通行では、中央 (上り) は線形の向きのまま。
    expect(parallelTracks(getClass('rail_single'), 3).map((t) => t.reversed)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('道路を横切ると線ごとに交差ができるが、踏切としては 1 か所にまとめる', () => {
    const network = new Network();
    const field = flatField();
    layParallel(network, [
      { x: 0, z: -200, y: 0 },
      { x: 0, z: 200, y: 0 },
    ], 2);
    draw(network, field, 'road_medium', [
      { x: -200, z: 0, y: 0 },
      { x: 200, z: 0, y: 0 },
    ], { straight: true });

    const crossings = findCrossings(network).filter((c) => c.kind === 'level');
    expect(crossings).toHaveLength(2);

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    expect(result.stats.levelCrossings).toBe(1);
    // 遮断機は踏切の外側に 2 基だけ。線路の間には立たない。
    const gates = result.props.filter((p) => p.kind === 'crossingGate');
    expect(gates).toHaveLength(2);
    const spacing = parallelSpacing(getClass('rail_single'));
    for (const gate of gates) {
      // 2 本の線路 (z = ±spacing/2) の間にいない。
      expect(Math.abs(gate.position.x)).toBeGreaterThan(spacing / 2 + 3);
    }
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
    draw(network, field, 'rail_yard', [
      { x: node.pos.x, z: node.pos.z, y: 0 },
      { x: node.pos.x + 120, z: node.pos.z + 20, y: 0 },
      { x: node.pos.x + 240, z: node.pos.z + 60, y: 0 },
    ]);

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

  it('谷を渡ると、並んだ線の橋が同じ位置で始まり同じ位置で終わる', () => {
    const field = valleyField();
    const network = new Network();
    const [span] = layParallel(
      network,
      [
        { x: -200, z: 0, y: 0 },
        { x: 200, z: 0, y: 0 },
      ],
      2,
      'rail_single',
      { field },
    );

    // 揃える前は、線ごとに橋の境界が決まる。
    for (const id of span) {
      const alignment = network.alignmentOf(id);
      const runs = computeStructureProfile(alignment, field, { s0: 0, s1: alignment.length });
      expect(runs.some((run) => run.mode === 'bridge')).toBe(true);
    }

    // 組み立てを通すと、橋の区間が線どうしで揃う。
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    // 橋の始まり・終わりの断面が、線どうしで真横に並ぶ。複線の 2 本目は
    // 逆向きに敷かれているので、境界の位置 (x) を揃えて比べる。
    const bridgeEdges = span.map((id) => {
      const runs = (result.structures.get(id) ?? []).filter((r) => r.mode === 'bridge');
      expect(runs).toHaveLength(1);
      const alignment = network.alignmentOf(id);
      return [alignment.sampleAt(runs[0].s0).pos.x, alignment.sampleAt(runs[0].s1).pos.x].sort(
        (a, b) => a - b,
      );
    });
    expect(Math.abs(bridgeEdges[0][0] - bridgeEdges[1][0])).toBeLessThan(1.5);
    expect(Math.abs(bridgeEdges[0][1] - bridgeEdges[1][1])).toBeLessThan(1.5);
  });

  it('複線の架線柱は門型 1 基にまとまり、線路の間に立たない', () => {
    const field = flatField();
    const network = new Network();
    const [span] = layParallel(network, [
      { x: -200, z: 0, y: 0 },
      { x: 200, z: 0, y: 0 },
    ], 2, 'rail_single', { field });

    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    const poles = result.props.filter((p) => p.kind === 'catenaryPole');
    expect(poles.length).toBeGreaterThan(0);

    const spacing = parallelSpacing(getClass('rail_single'));
    const stations = new Map<number, number>();
    for (const pole of poles) {
      // 2 本の線路の間 (|z| < spacing/2) には立たない。
      expect(Math.abs(pole.position.z)).toBeGreaterThan(spacing / 2);
      const key = Math.round(pole.position.x);
      stations.set(key, (stations.get(key) ?? 0) + 1);
    }
    // 同じ断面に左右 1 本ずつ (門型) が建つ。
    for (const count of stations.values()) expect(count).toBe(2);
    void span;
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
