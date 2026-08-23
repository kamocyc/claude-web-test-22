import { describe, expect, it } from 'vitest';
import { buildInterchange, buildTrumpetInterchange } from '../src/app/interchange';
import { findCrossings } from '../src/network/crossings';
import { solveJunctions } from '../src/network/junction';
import { solveApproachLanes } from '../src/network/lanes';
import { Network, type SegmentId } from '../src/network/network';
import { evaluateAlignment } from '../src/network/validation';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { Traffic } from '../src/sim/traffic';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { testField } from './support/field';

interface Scene {
  network: Network;
  graph: LaneGraph;
  junctions: ReturnType<typeof solveJunctions>['junctions'];
}

/** インターチェンジを 1 つ置いた場面を作る。 */
function scene(options: { trumpet?: boolean } = {}): Scene {
  const field = testField();
  generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  const build = options.trumpet ? buildTrumpetInterchange : buildInterchange;
  build(network, field, { center: { x: 0, z: 0 } });

  const { junctions, trims } = solveJunctions(network);
  const ranges = new Map<SegmentId, { s0: number; s1: number }>();
  for (const seg of network.segments.values()) {
    const trim = trims.get(seg.id)!;
    const length = network.alignmentOf(seg.id).length;
    ranges.set(seg.id, { s0: trim.a, s1: Math.max(trim.a + 0.5, length - trim.b) });
  }
  return { network, graph: buildLaneGraph(network, junctions, ranges), junctions };
}

/** その種別のセグメント。 */
function segmentsOf(network: Network, classId: string): SegmentId[] {
  return [...network.segments.values()]
    .filter((s) => s.classId === classId)
    .map((s) => s.id);
}

/** 車線グラフをたどって行ける車線を集める。 */
function reachable(graph: LaneGraph, from: number): Set<number> {
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of graph.lanes[id].next) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** その車線が属するセグメント (コネクタなら undefined)。 */
function segmentOf(graph: LaneGraph, id: number): SegmentId | undefined {
  return graph.lanes[id].segment;
}

describe('インターチェンジ', () => {
  it('本線・側道・4 本のランプができる', () => {
    const { network } = scene();
    expect(segmentsOf(network, 'road_highway').length).toBeGreaterThan(3);
    expect(segmentsOf(network, 'road_medium').length).toBeGreaterThan(3);
    // ランプ 4 本が、それぞれ複数の区間に分かれて引かれる。
    const ramps = segmentsOf(network, 'road_ramp');
    expect(ramps.length).toBeGreaterThanOrEqual(12);
  });

  it('交差点の形が乱れず、線形も規格に収まる', () => {
    const { network, junctions } = scene();
    for (const junction of junctions.values()) {
      expect(junction.warnings).toEqual([]);
    }
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const diag = evaluateAlignment(network.alignmentOf(seg.id), cls);
      expect(diag.messages).toEqual([]);
    }
  });

  it('ランプは本線の走行車線側 (左) に出入りする', () => {
    const { network, junctions } = scene();
    const ramps = new Set(segmentsOf(network, 'road_ramp'));
    /** 入ってきた向きから見て、出ていく向きが右か左か (正なら右)。 */
    const turn = (approach: { dir: { x: number; y: number } }, exit: { dir: { x: number; y: number } }): number => {
      const inbound = { x: -approach.dir.x, y: -approach.dir.y };
      return inbound.x * exit.dir.y - inbound.y * exit.dir.x;
    };

    let exits = 0;
    let entries = 0;
    for (const junction of junctions.values()) {
      if (!junction.approaches.some((a) => a.branch.cls.id === 'road_highway')) continue;
      const lanes = solveApproachLanes(junction);

      for (const [segment, assignment] of lanes) {
        // 一方通行の出口側 (交差点へ入る車線がない枝) からは誰も来ない。
        if (assignment.entry.length === 0) continue;
        const cls = network.classOf(network.getSegment(segment));
        for (const exit of assignment.exits) {
          const toRamp = ramps.has(exit.approach.branch.segment);
          const fromRamp = cls.id === 'road_ramp';
          if (cls.id === 'road_highway' && toRamp) {
            // 出口は左へ分かれる (右へ出ると分離帯を越えてしまう)。
            expect(turn(assignment.approach, exit.approach)).toBeLessThan(0);
            expect(exit.movement).not.toBe('right');
            exits++;
          }
          if (fromRamp && exit.approach.branch.cls.id === 'road_highway') {
            // 入口も左から合流する。
            expect(turn(assignment.approach, exit.approach)).toBeLessThan(0);
            expect(exit.movement).not.toBe('right');
            entries++;
          }
        }
      }
    }
    // 出口・入口が 1 方向につき 1 本ずつ。
    expect(exits).toBe(2);
    expect(entries).toBe(2);
  });

  it('本線と側道を車で行き来できる', () => {
    const { network, graph } = scene();
    const highway = new Set(segmentsOf(network, 'road_highway'));
    const arterial = new Set(segmentsOf(network, 'road_medium'));

    const fromHighway = graph.lanes.find(
      (l) => l.segment !== undefined && highway.has(l.segment),
    )!;
    const fromArterial = graph.lanes.find(
      (l) => l.segment !== undefined && arterial.has(l.segment),
    )!;

    const toArterial = [...reachable(graph, fromHighway.id)].some((id) => {
      const segment = segmentOf(graph, id);
      return segment !== undefined && arterial.has(segment);
    });
    const toHighway = [...reachable(graph, fromArterial.id)].some((id) => {
      const segment = segmentOf(graph, id);
      return segment !== undefined && highway.has(segment);
    });
    expect(toArterial).toBe(true);
    expect(toHighway).toBe(true);
  });

  it('本線を走る車がランプを通って側道へ降りてくる', () => {
    const { network, graph } = scene();
    const arterial = new Set(segmentsOf(network, 'road_medium'));
    const ramps = new Set(segmentsOf(network, 'road_ramp'));
    const traffic = new Traffic(graph, { carSpacing: 150 });

    let onRamp = 0;
    let onArterial = 0;
    for (let i = 0; i < 180 * 20; i++) {
      traffic.step(1 / 20);
      for (const vehicle of traffic.vehicles) {
        for (const id of vehicle.route) {
          const segment = segmentOf(graph, id);
          if (segment === undefined) continue;
          if (ramps.has(segment)) onRamp++;
          if (arterial.has(segment)) onArterial++;
        }
      }
    }
    expect(onRamp).toBeGreaterThan(0);
    expect(onArterial).toBeGreaterThan(0);
  });
});

describe('トランペット型インターチェンジ', () => {
  it('本線・側道・4 本のランプができ、形も線形も乱れない', () => {
    const { network, junctions } = scene({ trumpet: true });
    expect(segmentsOf(network, 'road_highway').length).toBeGreaterThan(3);

    // 本線に取り付くランプは 4 本 (上下線それぞれの出口と入口)。
    const highway = new Set(segmentsOf(network, 'road_highway'));
    const attached = segmentsOf(network, 'road_ramp').filter((id) => {
      const seg = network.getSegment(id);
      return [seg.a, seg.b].some((node) =>
        network.getNode(node).segments.some((s) => highway.has(s)),
      );
    });
    expect(attached).toHaveLength(4);
    for (const junction of junctions.values()) {
      expect(junction.warnings).toEqual([]);
    }
    for (const seg of network.segments.values()) {
      const diag = evaluateAlignment(network.alignmentOf(seg.id), network.classOf(seg));
      expect(diag.messages).toEqual([]);
    }
  });

  it('側道は本線をくぐって終わり、ランプどうしは平面交差しない', () => {
    const { network } = scene({ trumpet: true });
    const crossings = findCrossings(network);
    // 立体交差は「本線が側道を跨ぐ」1 か所だけ。
    expect(crossings).toHaveLength(1);
    expect(crossings[0].kind).toBe('separated');

    // 側道は本線に突き当たって終わる。行き止まりは遠い方の端 1 つだけで、
    // 本線をくぐった先の端にはランプ 2 本が取り付く。
    const arterial = new Set(segmentsOf(network, 'road_medium'));
    const ramps = new Set(segmentsOf(network, 'road_ramp'));
    const ends = [...network.nodes.values()].filter(
      (node) => node.segments.length === 1 && arterial.has(node.segments[0]),
    );
    expect(ends).toHaveLength(1);

    const stub = [...network.nodes.values()].find(
      (node) =>
        node.segments.length === 3 &&
        node.segments.filter((s) => arterial.has(s)).length === 1 &&
        node.segments.filter((s) => ramps.has(s)).length === 2,
    );
    expect(stub).toBeDefined();
  });

  it('ランプは本線の走行車線側 (左) に出入りする', () => {
    const { network, junctions } = scene({ trumpet: true });
    const ramps = new Set(segmentsOf(network, 'road_ramp'));
    const turn = (
      approach: { dir: { x: number; y: number } },
      exit: { dir: { x: number; y: number } },
    ): number => {
      const inbound = { x: -approach.dir.x, y: -approach.dir.y };
      return inbound.x * exit.dir.y - inbound.y * exit.dir.x;
    };

    let exits = 0;
    let entries = 0;
    for (const junction of junctions.values()) {
      if (!junction.approaches.some((a) => a.branch.cls.id === 'road_highway')) continue;
      for (const [segment, assignment] of solveApproachLanes(junction)) {
        if (assignment.entry.length === 0) continue;
        const cls = network.classOf(network.getSegment(segment));
        for (const exit of assignment.exits) {
          if (cls.id === 'road_highway' && ramps.has(exit.approach.branch.segment)) {
            expect(turn(assignment.approach, exit.approach)).toBeLessThan(0);
            exits++;
          }
          if (cls.id === 'road_ramp' && exit.approach.branch.cls.id === 'road_highway') {
            expect(turn(assignment.approach, exit.approach)).toBeLessThan(0);
            entries++;
          }
        }
      }
    }
    // 4 方向ぶん (上下線それぞれの出口と入口)。
    expect(exits).toBe(2);
    expect(entries).toBe(2);
  });

  it('側道から本線の上下線どちらへも行け、どちらからも降りられる', () => {
    const { network, graph } = scene({ trumpet: true });
    const highway = new Set(segmentsOf(network, 'road_highway'));
    const arterial = new Set(segmentsOf(network, 'road_medium'));

    // 本線の車線は上下 2 方向ある。どちらからも側道へ降りられること。
    const highwayLanes = graph.lanes.filter(
      (l) => l.segment !== undefined && highway.has(l.segment) && l.kind === 'segment',
    );
    const downhill = highwayLanes.filter((lane) => {
      const dir = lane.path.poseAt(0).dir;
      return dir.x >= 0;
    });
    const uphill = highwayLanes.filter((lane) => lane.path.poseAt(0).dir.x < 0);
    expect(downhill.length).toBeGreaterThan(0);
    expect(uphill.length).toBeGreaterThan(0);

    const reachesArterial = (from: number): boolean =>
      [...reachable(graph, from)].some((id) => {
        const segment = segmentOf(graph, id);
        return segment !== undefined && arterial.has(segment);
      });
    expect(downhill.some((lane) => reachesArterial(lane.id))).toBe(true);
    expect(uphill.some((lane) => reachesArterial(lane.id))).toBe(true);

    // 側道からも本線へ入れる。
    const fromArterial = graph.lanes.find(
      (l) => l.segment !== undefined && arterial.has(l.segment),
    )!;
    expect(
      [...reachable(graph, fromArterial.id)].some((id) => {
        const segment = segmentOf(graph, id);
        return segment !== undefined && highway.has(segment);
      }),
    ).toBe(true);
  });
});
