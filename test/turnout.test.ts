import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial, Vector3 } from 'three';
import { applySurfaceBlend } from '../src/build/crossing';
import { RAIL_GAUGE } from '../src/core/units';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment, type Anchor } from '../src/network/editing';
import { Network, type SegmentId } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

/**
 * 分岐器を出てすぐは、分かれた 2 本が同じ所を通っている。右のレールと左の
 * レールが離れるまでは 1 つの軌道なので、そこに高さの違う面が 2 枚あっては
 * ならない。枝ごとの縦断は独立しているので、勾配が違えば分かれた直後から
 * 高さが開く。それを描画・整地・走行が見る高さで揃える。
 */
function turnout(branchRise: number) {
  const field = testField();
  field.base.fill(0);
  field.resetWork();
  const network = new Network();
  const main = getClass('rail_single');
  const yard = getClass('rail_yard');

  const lay = (classId: string, from: Anchor, to: Vector3, straight = false) => {
    const cls = getClass(classId);
    const preview = computePlacement(from, to, { straight, cls });
    return placeSegment(network, classId, from, { pos: to }, preview);
  };

  // 本線は 3% 上り。真ん中の継ぎ目から側線を分ける。
  lay(main.id, { pos: new Vector3(0, 0, -200) }, new Vector3(0, 6, 0), true);
  const node = network.findNodeNear(new Vector3(0, 6, 0), 1)!;
  const through = lay(main.id, anchorFromNode(network, node, main), new Vector3(0, 12, 200), true);
  const branch = lay(
    yard.id,
    anchorFromNode(network, node, yard),
    new Vector3(60, 6 + branchRise, 200),
  );

  const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
  const result = world.rebuild();
  /** 描画・整地・走行が見る高さ (分岐器の高さ揃え込み)。 */
  const drawnY = (segment: SegmentId, s: number): number =>
    applySurfaceBlend(
      [network.alignmentOf(segment).sampleAt(s)],
      result.blends.get(segment) ?? [],
    )[0].pos.y;

  return { network, result, drawnY, branch: branch.segment, through: through.segment };
}

describe('分岐器のまわりの高さ', () => {
  it('レールが重なっている間は、勾配が違っても高さが揃っている', () => {
    const { network, drawnY, branch, through } = turnout(3);
    const a = network.alignmentOf(branch);
    const b = network.alignmentOf(through);

    let overlapped = 0;
    let raw = 0;
    for (let s = 0; s <= 60; s += 2) {
      const p = a.sampleAt(s);
      const q = b.sampleAt(s);
      if (Math.hypot(p.pos.x - q.pos.x, p.pos.z - q.pos.z) >= RAIL_GAUGE) break;
      overlapped++;
      raw = Math.max(raw, Math.abs(p.pos.y - q.pos.y));
      expect(Math.abs(drawnY(branch, s) - drawnY(through, s)), `s=${s}`).toBeLessThan(0.01);
    }
    // 重なりを測れていること、そこに揃えるだけの段差があったこと。
    expect(overlapped).toBeGreaterThan(5);
    expect(raw).toBeGreaterThan(0.1);
  });

  it('本線の高さは動かさない (合わせるのは分かれたほう)', () => {
    const { network, result, drawnY, through } = turnout(3);
    expect(result.blends.get(through) ?? []).toEqual([]);
    for (let s = 0; s <= 60; s += 10) {
      expect(drawnY(through, s)).toBeCloseTo(network.alignmentOf(through).sampleAt(s).pos.y, 6);
    }
  });

  it('離れたあとは元の縦断に戻る (すり付けの勾配も緩い)', () => {
    const { network, drawnY, branch } = turnout(3);
    const a = network.alignmentOf(branch);
    // 十分に離れた所では、補正はすっかり抜けている。
    expect(drawnY(branch, 100)).toBeCloseTo(a.sampleAt(100).pos.y, 3);
    // すり付けで足される勾配が、線路として通れる範囲に収まっている。
    for (let s = 0; s + 5 <= 100; s += 5) {
      const added =
        (drawnY(branch, s + 5) - drawnY(branch, s) - (a.sampleAt(s + 5).pos.y - a.sampleAt(s).pos.y)) /
        5;
      expect(Math.abs(added), `s=${s}`).toBeLessThan(0.02);
    }
  });

  it('動かすのは開いていた分だけ (勾配が近ければ動かない)', () => {
    // 側線も本線と同じだけ上がる配置。曲がるぶん弧長が伸びて勾配はわずかに
    // 緩くなるので、開いた分だけ (数 cm) 引き上げられる。
    const { network, drawnY, branch, through } = turnout(6);
    const a = network.alignmentOf(branch);
    const b = network.alignmentOf(through);
    let moved = 0;
    for (let s = 0; s <= 40; s += 5) {
      const raw = a.sampleAt(s).pos.y;
      const gap = Math.abs(b.sampleAt(s).pos.y - raw);
      moved = Math.max(moved, Math.abs(drawnY(branch, s) - raw));
      expect(Math.abs(drawnY(branch, s) - raw), `s=${s}`).toBeLessThanOrEqual(gap + 1e-6);
    }
    expect(moved).toBeLessThan(0.05);
  });
});
