import { sign } from '../math/scalar.ts';
import type { CouplerSpec } from '../vehicle/spec.ts';

/**
 * 連結器（密着連結器 + ゴム緩衝器）の伝達力 [N]。
 *
 * @param deflection    連結器の変位 δ [m]（正 = 伸び／引張側）
 * @param deflectionRate δ の時間変化率 [m/s]
 * @returns 正 = 引張（前後の車両を引き寄せる向き）、負 = 圧縮（押し離す向き）
 *
 * 遊間（slack）の範囲では力を伝えない。遊間を超えると 1 段目のばね、
 * さらに travel1 を超えると 2 段目の（より硬い）ばねが効く 2 段剛性とし、
 * 接触しているあいだだけ緩衝器の減衰が働く。
 *
 * 遊間があることで、力行と惰行を切り替えた瞬間に「遊間を詰める」過渡が生じ、
 * 実車の前後衝動（がくんという衝撃）が再現される。
 */
export function couplerForce(
  spec: CouplerSpec,
  deflection: number,
  deflectionRate: number,
): number {
  const half = spec.slack / 2;
  const abs = Math.abs(deflection);
  if (abs <= half) return 0;
  const s = sign(deflection);
  const e = abs - half;
  let f: number;
  if (e <= spec.travel1) {
    f = spec.stiffness1 * e;
  } else {
    f = spec.stiffness1 * spec.travel1 + spec.stiffness2 * (e - spec.travel1);
  }
  let force = s * f + spec.damping * deflectionRate;
  if (spec.maxForce !== undefined) {
    force = Math.max(-spec.maxForce, Math.min(spec.maxForce, force));
  }
  return force;
}
