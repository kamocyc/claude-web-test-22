/**
 * 信号の現示。時間だけで決まる単純な周期制御で、車両側も描画側も同じ
 * 関数を見るので「青なのに止まっている」といったずれが起きない。
 */

/** 1 周期の長さ [s]。 */
export const SIGNAL_PERIOD = 26;
/** 青・黄の長さ [s]。残りが赤。 */
const GREEN = 10;
const YELLOW = 2.5;

/** 0 = 青、1 = 黄、2 = 赤。 */
export type SignalState = 0 | 1 | 2;

export function signalStateAt(time: number, phase: number): SignalState {
  const local = (time + phase * (SIGNAL_PERIOD / 2)) % SIGNAL_PERIOD;
  return local < GREEN ? 0 : local < GREEN + YELLOW ? 1 : 2;
}
