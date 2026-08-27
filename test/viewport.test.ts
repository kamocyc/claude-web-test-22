import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { screenPanDelta } from '../src/app/viewport';

/**
 * WASD の平行移動。
 *
 * 「W で画面の奥」「D で画面の右」が、どの方位から見ていても崩れないこと。
 * 符号を 1 つ取り違えると操作が鏡像になるので、代表的な方位で確かめる。
 */
describe('画面に対する平行移動', () => {
  /** 北 (-Z) を画面の奥にして見下ろしている状態。 */
  const north = new Vector3(0, 0, -1);

  /** 符号違いを見たいので、成分ごとに比べる (-0 と +0 は区別しない)。 */
  const expectDelta = (got: Vector3, want: [number, number, number]): void => {
    expect([got.x, got.y, got.z].map((v) => v + 0)).toEqual(want);
  };

  it('W は画面の奥、S は手前へ動く', () => {
    expectDelta(screenPanDelta(north, 10, 0), [0, 0, -10]);
    expectDelta(screenPanDelta(north, -10, 0), [0, 0, 10]);
  });

  it('D は画面の右、A は左へ動く', () => {
    // 北を上にした地図では、画面の右は東 (+X)。
    expectDelta(screenPanDelta(north, 0, 10), [10, 0, 0]);
    expectDelta(screenPanDelta(north, 0, -10), [-10, 0, 0]);
  });

  it('見る方位を変えても、画面に対する向きは変わらない', () => {
    for (const angle of [0, 30, 90, 145, 180, 260, 315]) {
      const rad = (angle * Math.PI) / 180;
      const ahead = new Vector3(Math.sin(rad), 0, -Math.cos(rad));
      const forward = screenPanDelta(ahead, 1, 0);
      const right = screenPanDelta(ahead, 0, 1);
      // 奥は視線そのもの。
      expect(forward.distanceTo(ahead)).toBeLessThan(1e-9);
      // 右は視線に直交し、上から見て視線の右手にある。
      expect(right.dot(ahead)).toBeCloseTo(0, 9);
      // XZ 平面での外積 (視線 × 右) が +1 = 上 (+Y) から見て時計回り。
      expect(ahead.x * right.z - ahead.z * right.x).toBeCloseTo(1, 9);
      expect(right.length()).toBeCloseTo(1, 9);
    }
  });

  it('斜めの視線でも長さは指定どおり (水平成分だけを使う)', () => {
    // 俯角のぶん Y 成分が入っていても、動くのは水平面の中だけ。
    const looking = new Vector3(3, -4, -4);
    const delta = screenPanDelta(looking, 6, 8);
    expect(delta.y).toBe(0);
    expect(delta.length()).toBeCloseTo(10, 9);
  });

  it('真下を向いていても向きが決まる (北を奥にする)', () => {
    expectDelta(screenPanDelta(new Vector3(0, -5, 0), 1, 0), [0, 0, -1]);
  });
});
