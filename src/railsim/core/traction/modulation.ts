import { clamp, firstOrderLag, PiecewiseLinear } from '../math/scalar.ts';
import type { Hertz, RadiansPerSecond } from '../units.ts';
import { radPerSecToRpm } from '../units.ts';
import type { InverterSpec, VvvfTractionSpec } from '../vehicle/spec.ts';
import type { DriveRotationState } from './driveState.ts';

/**
 * すべり周波数指令の応答時定数 [s]。
 * ベクトル制御の電流制御ループは数 ms で応答するので、トルク指令に対して
 * ほぼ即応するが、輪軸のニュートン解に乗る細かいリップルをそのまま
 * 周波数に出すと音が濁る。実機の指令フィルタに相当する鈍りを入れる。
 */
const SLIP_RESPONSE_TIME = 0.03;

/** 変調モード */
export type ModulationMode = 'off' | 'async' | 'sync' | 'onePulse';

/**
 * インバータの変調状態（表示・音響用）。
 *
 * `DriveState` union の VVVF 枝そのものなので、`DriveRotationState` の 4 つ
 * （角速度・回転数・かみ合い周波数・トルク比）を含んでいる。
 */
export interface InverterState extends DriveRotationState {
  readonly kind: 'vvvf';
  /** 変調モード */
  mode: ModulationMode;
  /** 回転子周波数 [Hz] = 極対数 × 回転数 / 60 */
  rotorFrequency: Hertz;
  /** すべり周波数 [Hz]（正 = 力行、負 = 回生） */
  slipFrequency: Hertz;
  /** インバータ出力（固定子）周波数 [Hz] = 回転子周波数 + すべり周波数 */
  fundamentalFrequency: Hertz;
  /** 変調率 0..1（1 = 一パルス＝矩形波） */
  modulationIndex: number;
  /** 出力 1 周期あたりのパルス数（0 = 非同期、1 = 一パルス） */
  pulses: number;
  /** キャリア（スイッチング）周波数 [Hz]。一パルス・停止中は 0 */
  carrierFrequency: Hertz;
  /** 回転子スロット高調波の周波数 [Hz] */
  slotFrequency: Hertz;
}

export function createInverterState(): InverterState {
  return {
    kind: 'vvvf',
    mode: 'off',
    motorAngularVelocity: 0,
    motorRpm: 0,
    rotorFrequency: 0,
    slipFrequency: 0,
    fundamentalFrequency: 0,
    modulationIndex: 0,
    pulses: 0,
    carrierFrequency: 0,
    slotFrequency: 0,
    gearMeshFrequency: 0,
    torqueRatio: 0,
  };
}

export interface InverterInput {
  /** 動軸の平均角速度 [rad/s]。**車速ではなく車輪の実回転**を渡すこと。 */
  readonly axleAngularVelocity: RadiansPerSecond;
  /** 定格トルクに対する電動機トルクの比（正 = 力行、負 = 電気ブレーキ） */
  readonly torqueRatio: number;
}

/**
 * VVVF インバータの変調状態を求める。
 *
 * 引張力はすでに `motorTorqueAt()` の 3 領域特性で決まっている。ここで計算するのは
 * 「その出力を、どういう周波数のスイッチングで作っているか」だけであり、
 * **走りには一切影響しない**。目的は 2 つ:
 *
 *  1. 音の合成に必要な量（出力周波数・キャリア周波数・変調率）を物理から出すこと
 *  2. その量を HUD とグラフに出して、音が正しいかを目で確かめられるようにすること
 *
 * ```
 * f_rotor = p · (ω_軸 · 歯車比) / 2π         p = 極対数
 * f_slip  = f_slip,定格 · (T / T_定格)        力行で正、回生で負
 * f₁      = f_rotor + f_slip                 インバータ出力周波数
 * M       = min(1, f₁ / f_base)              V/f 一定 → 定電圧（弱め界磁）
 * ```
 *
 * 角速度は**動軸の実回転**から取る。したがって空転すれば電動機の回転が跳ね上がり、
 * 出力周波数も一緒に跳ね上がる（実車で空転が耳で分かるのはこのため）。
 *
 * パルスモードはヒステリシス付きで選ぶ。境界上で出力周波数が細かく上下したときに
 * モードが往復すると、実機では素子が壊れるし、音としても不自然な高速の切り替わりに
 * なるためである。
 */
export class InverterModulation {
  readonly state = createInverterState();

  private readonly inverter: InverterSpec;
  private readonly asyncCarrier: PiecewiseLinear;
  /** 現在のパルスモードの段（`pulseModes` の添字） */
  private modeIndex = 0;
  /** 鈍らせたあとのトルク比 */
  private filteredTorqueRatio = 0;

  constructor(private readonly spec: VvvfTractionSpec) {
    this.inverter = spec.inverter;
    this.asyncCarrier = new PiecewiseLinear(this.inverter.asyncCarrier);
  }

  step(dt: number, input: InverterInput): InverterState {
    const inv = this.inverter;
    const st = this.state;

    this.filteredTorqueRatio = firstOrderLag(
      this.filteredTorqueRatio,
      clamp(input.torqueRatio, -1.5, 1.5),
      SLIP_RESPONSE_TIME,
      dt,
    );
    const torqueRatio = this.filteredTorqueRatio;

    // --- 回転側 ---
    const motorOmega = Math.abs(input.axleAngularVelocity) * this.spec.gearRatio;
    const motorRps = motorOmega / (2 * Math.PI);
    st.motorAngularVelocity = motorOmega;
    st.motorRpm = radPerSecToRpm(motorOmega);
    st.rotorFrequency = inv.polePairs * motorRps;
    st.gearMeshFrequency = motorRps * inv.pinionTeeth;
    st.slotFrequency = motorRps * inv.rotorSlots;
    st.torqueRatio = torqueRatio;

    // --- 主回路が動いていなければ変調は無い（惰行）---
    // 電動機は回り続けるので、歯車・軸受の音だけが残るのが実車の惰行。
    if (Math.abs(torqueRatio) < 1e-3) {
      st.mode = 'off';
      st.slipFrequency = 0;
      st.fundamentalFrequency = 0;
      st.modulationIndex = 0;
      st.pulses = 0;
      st.carrierFrequency = 0;
      // モードは切っている間も現在の周波数相当の段へ追従させておく。
      // こうしないと、高速で惰行してからノッチを入れた瞬間に低いモードから
      // 一気に駆け上がる不自然な音になる。
      this.selectMode(st.rotorFrequency);
      return st;
    }

    // --- すべり周波数と出力周波数 ---
    // 誘導電動機のトルクは、すべりが小さい範囲ではすべり周波数にほぼ比例する。
    // 回生ではすべりが負になり、出力周波数が回転子周波数より低くなる。
    st.slipFrequency = inv.ratedSlipFrequency * torqueRatio;
    const f1 = Math.max(0, st.rotorFrequency + st.slipFrequency);
    st.fundamentalFrequency = f1;

    // --- 変調率: 基底周波数まで V/f 一定、それ以上は定電圧（弱め界磁）---
    // 一次抵抗降下ぶんのブーストを足す。f₁ → 0 でも磁束が残るのが要点で、
    // これが無いと起動時に磁束が立たず、定格トルクを出せる説明がつかない。
    // 降下は電流に比例するので、上乗せも負荷に比例させる。
    const boost = inv.voltageBoost * Math.min(1, Math.abs(torqueRatio));
    st.modulationIndex = inv.baseFrequency > 0 ? Math.min(1, f1 / inv.baseFrequency + boost) : 1;

    // --- パルスモードとキャリア周波数 ---
    const pulses = this.selectMode(f1);
    st.pulses = pulses;
    if (pulses === 1) {
      st.mode = 'onePulse';
      st.carrierFrequency = 0;
      // 一パルスは変調率が飽和した状態そのもの
      st.modulationIndex = 1;
    } else if (pulses === 0) {
      st.mode = 'async';
      st.carrierFrequency = this.asyncCarrier.at(f1);
    } else {
      st.mode = 'sync';
      // 同期モードではキャリアを出力周波数の整数倍に固定する。
      // 位相もロックされるため、非同期のときのようなうなりが出ない。
      st.carrierFrequency = pulses * f1;
    }
    return st;
  }

  /**
   * 出力周波数からパルスモードの段を選ぶ（ヒステリシス付き）。
   * 上がるときは境界ちょうどで、下がるときはヒステリシス幅だけ深く戻ってから。
   */
  private selectMode(f1: Hertz): number {
    const modes = this.inverter.pulseModes;
    if (modes.length === 0) return 0;
    const h = this.inverter.modeHysteresis;
    let i = clamp(this.modeIndex, 0, modes.length - 1);
    while (i + 1 < modes.length && f1 >= modes[i + 1]!.minFrequency) i++;
    while (i > 0 && f1 < modes[i]!.minFrequency - h) i--;
    this.modeIndex = i;
    return modes[i]!.pulses;
  }

  reset(): void {
    this.modeIndex = 0;
    this.filteredTorqueRatio = 0;
    const st = this.state;
    st.mode = 'off';
    st.motorAngularVelocity = 0;
    st.motorRpm = 0;
    st.rotorFrequency = 0;
    st.slipFrequency = 0;
    st.fundamentalFrequency = 0;
    st.modulationIndex = 0;
    st.pulses = 0;
    st.carrierFrequency = 0;
    st.slotFrequency = 0;
    st.gearMeshFrequency = 0;
    st.torqueRatio = 0;
  }
}

/** 変調モードの表示名 */
export function modulationLabel(state: InverterState): string {
  switch (state.mode) {
    case 'off':
      return '切';
    case 'async':
      return `非同期 ${state.carrierFrequency.toFixed(0)}Hz`;
    case 'sync':
      return `同期 ${state.pulses} パルス`;
    case 'onePulse':
      return '一パルス';
  }
}
