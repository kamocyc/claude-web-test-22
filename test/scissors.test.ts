import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { drawParallel, type Waypoint } from '../src/app/sketch';
import { solveJunctions } from '../src/network/junction';
import { Network, type SegmentId } from '../src/network/network';
import { findCurveBreaks } from '../src/network/validation';
import { Heightfield } from '../src/terrain/heightfield';
import { testField } from './support/field';

/**
 * シーサスクロッシング (渡り線が交わる所)。
 *
 * 専用の道具は無い。平行な 2 線の間に渡り線を 2 本、互いに交わるように引けば
 * できる。線路の平面交差はダイヤモンドクロッシングなので、道路の交差点より
 * 浅い角度で交われる (`MIN_RAIL_CROSSING_ANGLE`)。
 */

const MODS = { straight: false, noSnap: false };

/** 線形の弧長比 `t` の点。 */
function pointOn(network: Network, id: SegmentId, t: number): Vector3 {
  const alignment = network.alignmentOf(id);
  return alignment.sampleAt(alignment.length * t).pos.clone();
}

function parallelPair(field: Heightfield, points: Waypoint[]) {
  const network = new Network();
  const [span] = drawParallel(network, field, 'rail_single', points, {
    count: 2,
    straight: false,
  });
  return { network, a: span[0].segment, b: span[1].segment };
}

/** 敷設ツールで 2 本の渡り線を引く。返り値は出た理由 (空なら全部置けた)。 */
function drawCrossovers(
  network: Network,
  field: Heightfield,
  a: SegmentId,
  b: SegmentId,
  t0: number,
  t1: number,
): string[] {
  const points = [
    pointOn(network, a, t0),
    pointOn(network, b, t1),
    pointOn(network, b, t0),
    pointOn(network, a, t1),
  ];
  const tool = new BuildTool(network, field, () => {});
  tool.setClass('rail_single');
  const blockers: string[] = [];
  points.forEach((point, index) => {
    tool.update(point, MODS);
    blockers.push(...tool.status().blockers);
    tool.click();
    // 2 本目は引き直し。
    if (index === 1) tool.cancel();
  });
  tool.cancel();
  return [...new Set(blockers)];
}

describe('シーサスクロッシング', () => {
  it('平行 2 線の間に渡り線を 2 本引くと、分岐器 4 つと中央の交差になる', () => {
    const field = testField();
    const cases: [string, Waypoint[]][] = [
      ['直線', [{ x: -300, z: 0, y: 0 }, { x: 300, z: 0, y: 0 }]],
      ['曲線', [{ x: -300, z: 0, y: 0 }, { x: 0, z: 60, y: 0 }, { x: 300, z: 220, y: 0 }]],
      ['勾配', [{ x: -300, z: 0, y: 0 }, { x: 300, z: 0, y: 24 }]],
      [
        '曲線と勾配',
        [{ x: -300, z: 0, y: 0 }, { x: 0, z: 60, y: 10 }, { x: 300, z: 220, y: 22 }],
      ],
    ];
    for (const [name, points] of cases) {
      const { network, a, b } = parallelPair(field, points);
      expect(drawCrossovers(network, field, a, b, 0.4, 0.6), name).toEqual([]);

      const junctions = [...solveJunctions(network).junctions.values()];
      const kinds = (kind: string) => junctions.filter((j) => j.kind === kind).length;
      expect(kinds('railSwitch'), name).toBe(4);
      expect(kinds('railCrossing'), name).toBe(1);
      expect(junctions.flatMap((j) => j.warnings), name).toEqual([]);
      // 継ぎ目はどこも繋がっている (分岐器は 3 枝なので見ない)。
      expect(findCurveBreaks(network), name).toEqual([]);

      // 中央は 2 つの進路が交わるだけ (合流しない)。
      const crossing = junctions.find((j) => j.kind === 'railCrossing')!;
      expect(crossing.approaches, name).toHaveLength(4);
      expect(crossing.connections, name).toHaveLength(2);
      expect(crossing.connections.every((c) => c.through), name).toBe(true);
    }
  });

  it('平行に重ねて引くのは相変わらず置けない', () => {
    const field = testField();
    const { network, a } = parallelPair(field, [
      { x: -300, z: 0, y: 0 },
      { x: 300, z: 0, y: 0 },
    ]);
    // 既存の線路の真上を、端から端までなぞる。
    const tool = new BuildTool(network, field, () => {});
    tool.setClass('rail_single');
    tool.update(pointOn(network, a, 0.2), MODS);
    tool.click();
    tool.update(pointOn(network, a, 0.8), MODS);
    expect(tool.status().blockers).not.toEqual([]);
  });
});
