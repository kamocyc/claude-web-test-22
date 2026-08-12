import { describe, expect, it } from 'vitest';
import { MeshBasicMaterial } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { profileFor } from '../src/build/surface';
import { Network } from '../src/network/network';
import { findCrossings } from '../src/network/crossings';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { Heightfield } from '../src/terrain/heightfield';
import { TerrainMesh } from '../src/terrain/terrainMesh';

/**
 * 組み立てパイプライン全体を、描画なしで動かす。
 * three.js のジオメトリ生成は WebGL を必要としないので Node でも通る。
 */
function buildWorld(seed = DEFAULT_TERRAIN.seed) {
  const field = new Heightfield();
  generateTerrain(field, { ...DEFAULT_TERRAIN, seed });
  const network = new Network();
  buildDemoNetwork(network, field);
  const terrainMesh = new TerrainMesh(field, new MeshBasicMaterial());
  const world = new WorldBuilder(network, field, terrainMesh);
  return { field, network, world, result: world.rebuild() };
}

describe('サンプルネットワーク', () => {
  it('交差点・分岐器・踏切・立体交差・橋・トンネルが一通りできる', () => {
    const { result, network } = buildWorld();

    expect(result.stats.segments).toBeGreaterThan(10);
    expect(result.stats.intersections).toBeGreaterThanOrEqual(1);
    expect(result.stats.turnouts).toBeGreaterThanOrEqual(1);
    expect(result.stats.levelCrossings).toBe(1);
    expect(result.stats.bridgeLength).toBeGreaterThan(20);
    expect(result.stats.tunnelLength).toBeGreaterThan(20);

    const crossings = findCrossings(network);
    expect(crossings.some((c) => c.kind === 'separated')).toBe(true);
  });

  it('規格違反や不正な交差の警告が出ない', () => {
    const { result } = buildWorld();
    const bad = result.warnings.filter((w) => w.severity !== 'info');
    expect(bad.map((w) => w.message)).toEqual([]);
  });

  it('地表区間では地形が路端の高さにぴったり合う', () => {
    const { field, network, result } = buildWorld();

    // 踏切の内側は舗装が道床の代わりになるので、線路の断面とは高さが違う。
    const crossingZones = new Map<number, { s0: number; s1: number }[]>();
    for (const crossing of findCrossings(network)) {
      if (crossing.kind !== 'level' || !crossing.rail || !crossing.road) continue;
      const span = crossing.road.cls.halfWidth + 8;
      const list = crossingZones.get(crossing.rail.segment) ?? [];
      list.push({ s0: crossing.rail.s - span, s1: crossing.rail.s + span });
      crossingZones.set(crossing.rail.segment, list);
    }

    let checked = 0;
    for (const seg of network.segments.values()) {
      const cls = network.classOf(seg);
      const zones = crossingZones.get(seg.id) ?? [];
      // 断面のいちばん外側 (歩道の外端、道床の法尻) に地形が接するのが正。
      const edgeHeight = profileFor(cls)[0].height;
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        // 区間の端は橋台・坑口との境界なので少し内側だけを見る。
        for (let s = run.s0 + 4; s < run.s1 - 4; s += 4) {
          if (zones.some((zone) => s >= zone.s0 && s <= zone.s1)) continue;
          const sample = alignment.sampleAt(s);
          const terrain = field.heightAt(sample.pos.x, sample.pos.z);
          // 埋まる (地形が上に出る) ことも、浮く (地形が下に離れる) こともない。
          expect(Math.abs(terrain - (sample.pos.y + edgeHeight))).toBeLessThan(0.5);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('橋・トンネル区間では地形が自然のまま残る', () => {
    const { field, network, result } = buildWorld();

    // 他の線形の地表区間は、橋の下・トンネルの上でも当然整地される。
    // 判定対象から外すため、地表区間の位置を集めておく。
    const groundPoints: { x: number; z: number }[] = [];
    for (const seg of network.segments.values()) {
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode !== 'ground') continue;
        for (let s = run.s0; s <= run.s1; s += 4) {
          const p = alignment.sampleAt(s).pos;
          groundPoints.push({ x: p.x, z: p.z });
        }
      }
    }
    const nearGround = (x: number, z: number): boolean =>
      groundPoints.some((g) => Math.hypot(g.x - x, g.z - z) < 40);

    let structural = 0;
    for (const seg of network.segments.values()) {
      const alignment = network.alignmentOf(seg.id);
      for (const run of result.structures.get(seg.id) ?? []) {
        if (run.mode === 'ground') continue;
        for (let s = run.s0 + 4; s < run.s1 - 4; s += 5) {
          const p = alignment.sampleAt(s).pos;
          if (nearGround(p.x, p.z)) continue;
          expect(field.heightAt(p.x, p.z)).toBeCloseTo(field.baseHeightAt(p.x, p.z), 3);
          structural++;
        }
      }
    }
    expect(structural).toBeGreaterThan(20);
  });

  it('地形を作り直しても同じシードなら同じ結果になる', () => {
    const a = buildWorld(1234);
    const b = buildWorld(1234);
    expect(b.result.stats).toEqual(a.result.stats);
  });

  it('ネットワークを空にすると地形が元に戻る', () => {
    const { field, network, world } = buildWorld();
    const modified = field.work.slice();
    network.clear();
    world.rebuild();

    let maxDelta = 0;
    for (let i = 0; i < field.work.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(field.work[i] - field.base[i]));
    }
    expect(maxDelta).toBeCloseTo(0, 5);
    // 整地前後で確かに地形が動いていたことも確認する。
    let changed = 0;
    for (let i = 0; i < modified.length; i++) {
      if (Math.abs(modified[i] - field.base[i]) > 0.05) changed++;
    }
    expect(changed).toBeGreaterThan(100);
  });
});
