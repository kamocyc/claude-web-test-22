import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { bodyQuaternion } from '../src/render/vehicles';

/**
 * 車両の姿勢。
 *
 * 進行方向を写すだけの所だが、「+Z から進行方向への最短回転」で作ると、
 * ほぼ真後ろ (-Z) を向いたときに回転軸が定まらず、勾配のわずかな上下成分
 * だけで車体が上下反転する。向き・勾配を総当たりで振って、屋根が必ず上を
 * 向いていることを確かめる。
 */
describe('車両の姿勢', () => {
  const UP = new Vector3(0, 1, 0);
  const FORWARD = new Vector3(0, 0, 1);
  const RIGHT = new Vector3(1, 0, 0);

  it('どの向き・どの勾配でも上下が反転しない', () => {
    const worst: string[] = [];
    let checked = 0;
    for (let deg = 0; deg < 360; deg += 1) {
      for (const grade of [-0.12, -0.05, -0.001, 0, 0.001, 0.05, 0.12]) {
        const rad = (deg * Math.PI) / 180;
        const dir = new Vector3(Math.sin(rad), grade, Math.cos(rad)).normalize();
        const q = bodyQuaternion(dir);
        const up = UP.clone().applyQuaternion(q);
        const forward = FORWARD.clone().applyQuaternion(q);
        const right = RIGHT.clone().applyQuaternion(q);
        checked++;
        // 屋根は上を向く。
        if (up.y <= 0.9) worst.push(`${deg}° 勾配${grade}: 上向き y=${up.y.toFixed(3)}`);
        // 進行方向はそのまま写る。
        if (forward.distanceTo(dir) > 1e-6) {
          worst.push(`${deg}° 勾配${grade}: 進行方向がずれる ${forward.distanceTo(dir).toFixed(4)}`);
        }
        // 横転しない (左右の軸は水平)。
        if (Math.abs(right.y) > 1e-6) {
          worst.push(`${deg}° 勾配${grade}: 横に傾いている y=${right.y.toFixed(4)}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(2000);
    expect(worst.slice(0, 5)).toEqual([]);
  });

  it('横断勾配のぶんだけ、車体が左右に傾く', () => {
    for (const roll of [-0.07, -0.02, 0, 0.02, 0.07]) {
      for (let deg = 0; deg < 360; deg += 11) {
        const rad = (deg * Math.PI) / 180;
        const dir = new Vector3(Math.sin(rad), 0, Math.cos(rad));
        const q = bodyQuaternion(dir, roll);
        const right = RIGHT.clone().applyQuaternion(q);
        const up = UP.clone().applyQuaternion(q);
        // 進行方向は傾けても変わらない。
        expect(FORWARD.clone().applyQuaternion(q).distanceTo(dir)).toBeLessThan(1e-6);
        // 右へ水平に 1 m 行くと、`roll` だけ上がる (道床の面と平行)。
        expect(right.y / Math.hypot(right.x, right.z)).toBeCloseTo(roll, 9);
        // 屋根は上を向いたまま。
        expect(up.y).toBeGreaterThan(0.99);
      }
    }
  });

  it('向きが取れないときも姿勢が壊れない', () => {
    const q = bodyQuaternion(new Vector3(0, 0, 0));
    const up = UP.clone().applyQuaternion(q);
    expect(up.y).toBeGreaterThan(0.9);
    const straightUp = bodyQuaternion(new Vector3(0, 1, 0));
    expect(Number.isFinite(straightUp.x + straightUp.y + straightUp.z + straightUp.w)).toBe(true);
    expect(FORWARD.clone().applyQuaternion(straightUp).y).toBeCloseTo(1, 6);
  });
});
