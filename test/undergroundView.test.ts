import { describe, expect, it } from 'vitest';
import { BufferAttribute, Mesh, MeshBasicMaterial } from 'three';
import { buildDemoNetwork } from '../src/app/demo';
import { Network } from '../src/network/network';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { testField } from './support/field';

describe('地下ビュー', () => {
  it('地表影と実深度表示は地下ビューのときだけ出す', () => {
    const field = testField();
    generateTerrain(field, DEFAULT_TERRAIN);
    const terrainMaterial = new MeshBasicMaterial();
    const terrain = new TerrainMesh(field, terrainMaterial);
    const network = new Network();
    buildDemoNetwork(network, field);
    const world = new WorldBuilder(network, field, terrain);
    const result = world.rebuild();
    expect(result.stats.tunnelLength).toBeGreaterThan(0);

    const shadow = world.group.getObjectByName('underground-shadows') as Mesh;
    const xray = world.group.getObjectByName('underground-xray') as Mesh;
    expect((shadow.geometry.getAttribute('position') as BufferAttribute).count).toBeGreaterThan(0);
    // 地上を見ている間は、地下を通っているだけの線形を地表に描かない。
    expect(shadow.visible).toBe(false);
    expect(xray.visible).toBe(false);

    world.setUndergroundView(true);
    expect(shadow.visible).toBe(true);
    expect(xray.visible).toBe(true);
    expect(terrainMaterial.opacity).toBeCloseTo(0.3);
    expect(terrainMaterial.depthWrite).toBe(false);

    world.setUndergroundView(false);
    expect(shadow.visible).toBe(false);
    expect(xray.visible).toBe(false);
    expect(terrainMaterial.opacity).toBe(1);
    expect(terrainMaterial.depthWrite).toBe(true);
  });
});
