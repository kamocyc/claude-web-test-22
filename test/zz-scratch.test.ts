import { it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import { Network } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { surfaceBlendAt, surfaceHeightScale } from '../src/build/crossing';

interface WP { x: number; z: number; y?: number }
function draw(network: Network, field: Heightfield, classId: string, points: WP[], straight = false): void {
  const cls = getClass(classId);
  const toVec = (p: WP): Vector3 => new Vector3(p.x, p.y ?? field.baseHeightAt(p.x, p.z), p.z);
  const first = toVec(points[0]);
  const existing = network.findNodeNear(first, 3);
  let anchor: Anchor = existing ? anchorFromNode(network, existing, cls) : { pos: first };
  for (let i = 1; i < points.length; i++) {
    const target = toVec(points[i]);
    const preview = computePlacement(anchor, target, { straight, cls });
    const result = placeSegment(network, classId, anchor, { pos: target }, preview);
    const endNode = network.nodes.get(result.endNode);
    if (!endNode) break;
    anchor = { pos: endNode.pos.clone(), node: endNode.id, tangent: preview.endTangent.clone(), grade: preview.endGrade };
  }
}

function scene(build: (n: Network, f: Heightfield) => void) {
  const field = new Heightfield();
  const network = new Network();
  build(network, field);
  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  return { field, network, world, result: world.rebuild() };
}

it('probe', () => {
  // 勾配のある道路が平坦な線路を斜めに渡る
  const s = scene((n, f) => {
    draw(n, f, 'rail_double', [{ x: -300, z: 0, y: 0 }, { x: 300, z: 0, y: 0 }], true);
    const a = (30 * Math.PI) / 180;
    draw(n, f, 'road_medium', [
      { x: -260 * Math.cos(a), z: -260 * Math.sin(a), y: 18 },
      { x: 0, z: 0, y: 0 },
      { x: 260 * Math.cos(a), z: 260 * Math.sin(a), y: -18 },
    ], true);
  });
  console.log('crossings', s.world.crossings.map((c) => c.kind));
  for (const [seg, list] of s.result.blends) {
    for (const b of list) {
      console.log(`seg#${seg} blend s=${b.s.toFixed(1)} dy=${b.deltaY.toFixed(3)} slope=${b.slope.toFixed(4)} roll=${b.roll.toFixed(4)} core=${b.core.toFixed(1)} half=${b.halfLength.toFixed(1)}`);
    }
  }
  // 各セグメントの最大 |dy|
  for (const [seg, list] of s.result.blends) {
    const al = s.network.alignmentOf(seg);
    let max = 0; let at = 0;
    for (let t = 0; t <= al.length; t += 0.5) {
      const { dy } = surfaceBlendAt(list, t);
      if (Math.abs(dy) > Math.abs(max)) { max = dy; at = t; }
    }
    console.log(`seg#${seg} max|dy| = ${max.toFixed(3)} @ s=${at.toFixed(1)} (len ${al.length.toFixed(1)})`);
  }
  for (const p of s.result.props) {
    console.log(`prop ${p.kind} seg#${p.segment} (${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}, ${p.position.z.toFixed(2)})`);
  }
  // 遮断機の足元と、実際の路面
  for (const p of s.result.props) {
    if (p.kind !== 'crossingGate') continue;
    const al = s.network.alignmentOf(p.segment!);
    const blends = s.result.blends.get(p.segment!) ?? [];
    // 最近点を探す
    let best = { d: Infinity, s: 0 };
    for (let t = 0; t <= al.length; t += 0.25) {
      const q = al.sampleAt(t).pos;
      const d = Math.hypot(q.x - p.position.x, q.z - p.position.z);
      if (d < best.d) best = { d, s: t };
    }
    const sm = al.sampleAt(best.s);
    const { dy, roll } = surfaceBlendAt(blends, best.s);
    const scale = surfaceHeightScale(blends, best.s);
    // 横位置の符号
    const dx = p.position.x - sm.pos.x;
    const dz = p.position.z - sm.pos.z;
    const lat = dx * sm.right.x + dz * sm.right.z;
    const cls = s.network.classOf(s.network.getSegment(p.segment!));
    const edgeY = sm.pos.y + dy + lat * roll + cls.curbHeight * scale;
    console.log(`gate lat=${lat.toFixed(2)} s=${best.s.toFixed(1)} dy=${dy.toFixed(3)} roll=${roll.toFixed(4)} scale=${scale.toFixed(3)} 路端面Y=${edgeY.toFixed(3)} 足元Y=${p.position.y.toFixed(3)} 地形=${s.field.heightAt(p.position.x, p.position.z).toFixed(3)}`);
  }
});
