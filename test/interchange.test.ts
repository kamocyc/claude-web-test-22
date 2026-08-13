import { describe, expect, it } from 'vitest';
import { buildInterchange } from '../src/app/interchange';
import { solveJunctions } from '../src/network/junction';
import { solveApproachLanes } from '../src/network/lanes';
import { Network, type SegmentId } from '../src/network/network';
import { evaluateAlignment } from '../src/network/validation';
import { buildLaneGraph, type LaneGraph } from '../src/sim/lanegraph';
import { Traffic } from '../src/sim/traffic';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';

interface Scene {
  network: Network;
  graph: LaneGraph;
  junctions: ReturnType<typeof solveJunctions>['junctions'];
}

/** インターチェンジを 1 つ置いた場面を作る。 */
function scene(options: { flat?: boolean } = {}): Scene {
  const field = new Heightfield();
  if (!options.flat) generateTerrain(field, DEFAULT_TERRAIN);
  const network = new Network();
  buildInterchange(network, field, { center: { x: 0, z: 0 } });

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
