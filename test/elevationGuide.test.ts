import { describe, expect, it } from 'vitest';
import { BufferAttribute, LineSegments, Vector3 } from 'three';
import { ElevationGuideView } from '../src/render/elevationGuide';
import { BuildTool } from '../src/app/buildTool';
import { Network } from '../src/network/network';
import { testField } from './support/field';

function vertexCount(view: ElevationGuideView): number {
  const lines = view.group.getObjectByName('elevation-guide-lines') as LineSegments;
  return (lines.geometry.getAttribute('position') as BufferAttribute).count;
}

describe('高さガイド', () => {
  it('地表点・垂線・3m刻みの目盛を高架側に描く', () => {
    const view = new ElevationGuideView();
    view.update([{ point: new Vector3(10, 9, 20), groundY: 0 }]);

    // 垂線 1 + 地表の輪 24 + 目盛 3×2 本。それぞれ 2 頂点。
    expect(vertexCount(view)).toBe((1 + 24 + 3 * 2) * 2);
  });

  it('地下側にも同じ目盛を描き、地表なら表示しない', () => {
    const view = new ElevationGuideView();
    view.update([{ point: new Vector3(0, -7, 0), groundY: 0 }]);
    expect(vertexCount(view)).toBe((1 + 24 + 2 * 2) * 2);

    view.update([{ point: new Vector3(0, 0, 0), groundY: 0 }]);
    expect(vertexCount(view)).toBe(0);
  });

  it('敷設高さを変えるとカーソル位置に連動する', () => {
    const field = testField();
    field.base.fill(4);
    field.resetWork();
    const tool = new BuildTool(new Network(), field, () => {});
    tool.adjustElevation(-2);
    tool.update(new Vector3(30, 4, -20), { straight: false, noSnap: true });

    const lines = tool.previewGroup.getObjectByName('elevation-guide-lines') as LineSegments;
    expect((lines.geometry.getAttribute('position') as BufferAttribute).count).toBeGreaterThan(0);
  });
});
