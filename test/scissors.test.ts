import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { drawParallel } from '../src/app/sketch';
import { getClass } from '../src/network/classes';
import { solveJunctions } from '../src/network/junction';
import { Network } from '../src/network/network';
import { placeScissorsCrossover, planScissorsCrossover } from '../src/network/scissors';
import { Heightfield } from '../src/terrain/heightfield';

function parallelYard(): { network: Network; field: Heightfield; first: number } {
  const network = new Network();
  const field = new Heightfield();
  const [span] = drawParallel(
    network,
    field,
    'rail_yard',
    [
      { x: -160, z: 0, y: 0 },
      { x: 160, z: 0, y: 0 },
    ],
    { count: 2, straight: true },
  );
  return { network, field, first: span[0].segment };
}

describe('シーサスクロッシング', () => {
  it('平行2線から規格内の2本の渡り線をプレビューできる', () => {
    const { network, first } = parallelYard();
    const alignment = network.alignmentOf(first);
    const result = planScissorsCrossover(network, first, alignment.length / 2);
    expect(result.blockers).toEqual([]);
    expect(result.plan).not.toBeNull();

    const cls = getClass('rail_yard');
    for (const connection of result.plan!.connections) {
      expect(connection.preview.radius).toBeGreaterThanOrEqual(cls.minRadius - 0.1);
      const start = connection.alignment.sampleAt(0);
      const end = connection.alignment.sampleAt(connection.alignment.length);
      expect(Math.abs(start.forwardXZ.dot(end.forwardXZ))).toBeGreaterThan(0.99);
    }
  });

  it('1クリックで4つの分岐器と中央のクロッシングを接続する', () => {
    const { network, first } = parallelYard();
    const alignment = network.alignmentOf(first);
    const plan = planScissorsCrossover(network, first, alignment.length / 2).plan!;
    const placed = placeScissorsCrossover(network, plan);
    expect(placed).toHaveLength(2);

    const junctions = [...solveJunctions(network).junctions.values()];
    expect(junctions.filter((junction) => junction.kind === 'railSwitch')).toHaveLength(4);
    expect(junctions.filter((junction) => junction.kind === 'railCrossing')).toHaveLength(1);
    expect(junctions.flatMap((junction) => junction.warnings)).toEqual([]);
  });

  it('専用ツールではクリック前から全体を表示し、クリックで確定する', () => {
    const { network, field } = parallelYard();
    const tool = new BuildTool(network, field, () => {});
    tool.setMode('scissors');
    tool.update(new Vector3(0, 0, 0), { straight: false, noSnap: false });

    expect(tool.status().snap).toBe('scissors');
    expect(tool.status().length).toBeGreaterThan(0);
    const before = network.segments.size;
    tool.click();
    expect(network.segments.size).toBeGreaterThan(before);
  });

  it('端点近くでは短すぎる配置を施工せず理由を返す', () => {
    const { network, first } = parallelYard();
    const result = planScissorsCrossover(network, first, 8);
    expect(result.plan).toBeNull();
    expect(result.blockers.join('')).toContain('十分に長い');
  });
});
