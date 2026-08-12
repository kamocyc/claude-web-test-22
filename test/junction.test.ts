import { describe, expect, it } from 'vitest';
import { Vector2, Vector3 } from 'three';
import { getClass } from '../src/network/classes';
import { solveJunctions } from '../src/network/junction';
import { Network } from '../src/network/network';

/** 中心ノードから放射状に伸びるセグメントを作る。 */
function star(classId: string, angles: number[], length = 120): { network: Network; center: number } {
  const network = new Network();
  const center = network.addNode(new Vector3(0, 0, 0));
  for (const angle of angles) {
    const dir = new Vector2(Math.cos(angle), Math.sin(angle));
    const end = network.addNode(new Vector3(dir.x * length, 0, dir.y * length));
    network.addSegment({
      classId,
      a: center.id,
      b: end.id,
      ctrlA: new Vector2(dir.x * (length / 3), dir.y * (length / 3)),
      ctrlB: new Vector2(dir.x * ((length * 2) / 3), dir.y * ((length * 2) / 3)),
      gradeA: 0,
      gradeB: 0,
    });
  }
  return { network, center: center.id };
}

describe('solveJunctions', () => {
  it('直角 4 叉路のトリム量は道路の半幅に一致する', () => {
    const cls = getClass('road_medium');
    const { network, center } = star('road_medium', [0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const { junctions } = solveJunctions(network);
    const junction = junctions.get(center)!;

    expect(junction.kind).toBe('intersection');
    for (const approach of junction.approaches) {
      // 隅角部の余裕分だけ半幅より大きくなる。
      expect(approach.trim).toBeGreaterThan(cls.halfWidth - 0.01);
      expect(approach.trim).toBeLessThan(cls.halfWidth + 1.0);
    }
  });

  it('4 叉路の交差点面は道路幅に見合う大きさの凸多角形になる', () => {
    const cls = getClass('road_medium');
    const { network, center } = star('road_medium', [0, Math.PI / 2, Math.PI, -Math.PI / 2]);
    const junction = solveJunctions(network).junctions.get(center)!;

    expect(junction.ring.length).toBeGreaterThanOrEqual(4);
    for (const p of junction.ring) {
      const r = Math.hypot(p.x, p.z);
      expect(r).toBeGreaterThan(cls.halfWidth * 0.9);
      expect(r).toBeLessThan(cls.halfWidth * 2.2);
    }
  });

  it('一直線に繋がる 2 本は継ぎ目とみなしてトリムしない', () => {
    const { network, center } = star('road_medium', [0, Math.PI]);
    const junction = solveJunctions(network).junctions.get(center)!;
    expect(junction.kind).toBe('seam');
    for (const approach of junction.approaches) expect(approach.trim).toBeCloseTo(0, 6);
    expect(junction.ring.length).toBe(0);
  });

  it('折れ点では外側にできる隙間を埋めるだけトリムする', () => {
    const { network, center } = star('road_medium', [0, Math.PI * 0.65]);
    const junction = solveJunctions(network).junctions.get(center)!;
    expect(junction.kind).toBe('joint');
    const maxTrim = Math.max(...junction.approaches.map((a) => a.trim));
    expect(maxTrim).toBeGreaterThan(0.5);
    expect(junction.ring.length).toBeGreaterThanOrEqual(3);
  });

  it('信号は 3 叉路以上かつ信号設置可能な種別のときだけ立つ', () => {
    const wide = star('road_medium', [0, Math.PI / 2, Math.PI]);
    expect(solveJunctions(wide.network).junctions.get(wide.center)!.signalized).toBe(true);

    const narrow = star('road_small', [0, Math.PI / 2, Math.PI]);
    expect(solveJunctions(narrow.network).junctions.get(narrow.center)!.signalized).toBe(false);
  });

  it('短いセグメントでも両端のトリムが重ならない', () => {
    const cls = getClass('road_large');
    const network = new Network();
    const a = network.addNode(new Vector3(-30, 0, 0));
    const b = network.addNode(new Vector3(0, 0, 0));
    const c = network.addNode(new Vector3(18, 0, 0));
    const d = network.addNode(new Vector3(18, 0, 60));
    const e = network.addNode(new Vector3(0, 0, -60));

    const straight = (from: Vector3, to: Vector3): { ctrlA: Vector2; ctrlB: Vector2 } => ({
      ctrlA: new Vector2(from.x + (to.x - from.x) / 3, from.z + (to.z - from.z) / 3),
      ctrlB: new Vector2(from.x + ((to.x - from.x) * 2) / 3, from.z + ((to.z - from.z) * 2) / 3),
    });

    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, d],
      [b, e],
    ] as const) {
      network.addSegment({
        classId: 'road_large',
        a: p.id,
        b: q.id,
        ...straight(p.pos, q.pos),
        gradeA: 0,
        gradeB: 0,
      });
    }

    const { trims } = solveJunctions(network);
    // b-c は 18 m しかないのに、両端とも大通りの交差点になる。
    const short = [...network.segments.values()].find(
      (s) => (s.a === b.id && s.b === c.id) || (s.a === c.id && s.b === b.id),
    )!;
    const trim = trims.get(short.id)!;
    expect(trim.a + trim.b).toBeLessThan(18);
    expect(trim.a).toBeGreaterThan(0);
    expect(cls.halfWidth * 2).toBeGreaterThan(18);
  });
});

describe('線路の分岐', () => {
  it('3 叉路では直進側と分岐側が 1 組ずつ決まる', () => {
    // 東西の本線に、北東へ分かれる側線が付くイメージ。
    const { network, center } = star('rail_single', [0, Math.PI, Math.PI * 0.12]);
    const junction = solveJunctions(network).junctions.get(center)!;

    expect(junction.kind).toBe('railSwitch');
    expect(junction.connections).toHaveLength(2);
    expect(junction.connections.filter((c) => c.through)).toHaveLength(1);
  });

  it('急な分岐角には警告が出る', () => {
    const { network, center } = star('rail_single', [0, Math.PI, Math.PI * 0.55]);
    const junction = solveJunctions(network).junctions.get(center)!;
    expect(junction.warnings.some((w) => w.includes('分岐器'))).toBe(true);
  });

  it('4 叉路は直進 2 組のクロッシングになる', () => {
    const { network, center } = star('rail_single', [0, Math.PI, Math.PI / 2, -Math.PI / 2]);
    const junction = solveJunctions(network).junctions.get(center)!;
    expect(junction.kind).toBe('railCrossing');
    expect(junction.connections.filter((c) => c.through)).toHaveLength(2);
  });

  it('道路と線路が同じノードに繋がると不正として扱われる', () => {
    const network = new Network();
    const center = network.addNode(new Vector3(0, 0, 0));
    const railEnd = network.addNode(new Vector3(100, 0, 0));
    const roadEnd = network.addNode(new Vector3(0, 0, 100));
    network.addSegment({
      classId: 'rail_single',
      a: center.id,
      b: railEnd.id,
      ctrlA: new Vector2(33, 0),
      ctrlB: new Vector2(66, 0),
      gradeA: 0,
      gradeB: 0,
    });
    network.addSegment({
      classId: 'road_small',
      a: center.id,
      b: roadEnd.id,
      ctrlA: new Vector2(0, 33),
      ctrlB: new Vector2(0, 66),
      gradeA: 0,
      gradeB: 0,
    });

    const junction = solveJunctions(network).junctions.get(center.id)!;
    expect(junction.kind).toBe('invalid');
    expect(junction.warnings.length).toBeGreaterThan(0);
  });
});
