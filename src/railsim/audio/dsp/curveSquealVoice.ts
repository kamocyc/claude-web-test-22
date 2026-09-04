import { Biquad } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 曲線の軋み音を決める量 */
export interface CurveSquealParams {
  /**
   * 自励の強さ 0..1。摩擦のすべり−摩擦特性の**負勾配の深さ**にあたる
   * （`curveSquealDrive`）。0 なら減衰が正のままなので何も起こらない。
   */
  readonly drive: number;
  /** 車速の大きさ [m/s]。うなりのゆらぎの速さに効く。 */
  readonly speed: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_CURVE_SQUEAL: CurveSquealParams = { drive: 0, speed: 0, level: 0 };

/**
 * 軋りを起こす車輪の面外（軸方向）固有振動 [Hz]。
 *
 * 車輪を円板と見ると、円周方向に n 個の節直径を持つ**傘状の変形**が並ぶ。軋りは
 * このうち 1 つのモードが自励するもので、径 860mm の車輪では n = 3〜5 が 700Hz 〜
 * 2kHz に来る。実際に鳴くのはそのときいちばん減衰が負になっているモード 1 つだけで、
 * だから軋り音は**ほとんど純音**に聞こえる。ここでは代表として n = 4 を採る。
 */
const WHEEL_MODE = 1150;

/**
 * 車輪の面外モードの共振 [基本波の何倍か, 重み]。
 *
 * 音程そのものは下の限界サイクル（発振器）が決めているので、ここは**倍音の
 * 釣り合いを整える**ためだけにある。固着と滑りの繰り返しが作る倍音のうち、
 * 車輪がよく響かせる次数だけが残る、という関係にあたる。
 *
 * 車輪はほとんど減衰の無い鋼の円板（損失係数は 10⁻⁴ の桁）だが、その鋭さは
 * ここではなく発振器の側に入っている。同じ鋭さの帯域通過を重ねると、音程の
 * わずかな揺れ（`WOBBLE_DEPTH`）で通過帯から外れてしまって逆に不自然になる。
 */
const MODES: ReadonlyArray<readonly [number, number]> = [
  [1, 1.0],
  [2, 0.5],
  [3, 0.28],
];

/** 共振の鋭さ */
const MODE_Q = 15;

/**
 * 立ち上がりと消え方の時定数 [s]。
 *
 * **非対称にしてあるのが要点である。** 自励振動は負減衰で指数的に育つので
 * 立ち上がるのに時間が要る（`RISE`）が、負減衰でなくなればあとは車輪の高い Q が
 * そのまま残響になるだけで、すぐに消える。この非対称のおかげで、
 * **長く続く曲線では鳴き、一瞬で通り過ぎる不整では鳴かない**という差が自然に出る。
 * 分岐器を直進で渡るときの護輪軌条は数十 ms しか掛からないので鳴き切らず、
 * 分岐側のリード曲線は数秒あるので鳴く。
 */
const RISE = 0.22;
const FALL = 0.05;

/** 全体の倍率。急曲線の軋りは車内でも転動音を覆うほど大きい。 */
const SQUEAL_GAIN = 0.12;

/** 固着と滑りの時間の偏り（0 なら上下対称で偶数次の倍音が出ない） */
const STICK_SLIP_ASYMMETRY = 0.3;

/** 軋りの音程のゆらぎの深さ（アタック角が軌道狂いで細かく動くため） */
const WOBBLE_DEPTH = 0.006;

/**
 * 曲線通過時の軋み音（curve squeal）。
 *
 * 制輪子の鳴きや空気ばねのきしみと同じ**スティックスリップ**だが、鳴っている物が
 * 違う。ここで振動しているのは車輪そのもの — ほとんど減衰の無い鋼の円板 — であり、
 * 加振しているのは輪軸が横を向いて転がることで生じる横クリープである。急曲線で
 * 台車が輪軸を半径方向へ向けられず、横クリープが飽和して摩擦の傾きが負になると、
 * 車輪の面外モードが自分で育っていく。
 *
 * したがって音の形は次のようになる。
 *
 * - **ほとんど純音**。自励するのは減衰が最も負になったモード 1 つだけである。
 *   だから合成も帯域雑音を濾すのではなく、その 1 つのモードに乗った**限界サイクル**
 *   として作っている（制輪子の鳴きが帯域雑音でよいのとはここが違う）
 * - **音程が速度に依らない**。決めているのは車輪の固有振動数であって、転動音や
 *   歯車のように回転で決まるのではない。加速しながら曲線を抜けても音程は動かない
 * - **育つのに時間が要り、消えるのは速い**（`RISE` / `FALL`）
 * - **雨で止む**。水膜が摩擦の負勾配をならしてしまう（`SQUEAL_RAIL_FACTOR`）
 *
 * 波形は正弦をそのまま出すのではなく、振幅が育つほど飽和させている。固着と滑りの
 * 繰り返しは大きく振れるほど正弦から遠ざかるので、**大きい軋りほど倍音が濃くなって
 * 耳障りになる**という関係がこれで出る。
 */
export class CurveSquealVoice {
  private readonly noise = new Noise(0x7a3d);
  private readonly modes: Biquad[] = [];
  private readonly weights: number[] = [];
  private readonly dt: number;

  private theta = 0;
  private wobble = 0;
  private wobblePhase = 0;
  private amplitude = 0;
  private target = 0;
  private speed = 0;
  private level = 0;
  private readonly riseCoefficient: number;
  private readonly fallCoefficient: number;

  // 移植時の差分: `private readonly sampleRate` はここでしか読まないので、
  // 未使用フィールドを禁じている当リポジトリの tsconfig に合わせて素の引数にした。
  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    for (const [multiple, weight] of MODES) {
      this.modes.push(new Biquad().bandPass(sampleRate, WHEEL_MODE * multiple, MODE_Q));
      this.weights.push(weight);
    }
    this.riseCoefficient = Math.exp(-this.dt / RISE);
    this.fallCoefficient = Math.exp(-this.dt / FALL);
  }

  setParams(p: CurveSquealParams): void {
    this.target = Math.max(0, Math.min(1, p.drive));
    this.speed = Math.abs(p.speed);
    this.level = p.level;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const modes = this.modes;
    for (let i = 0; i < out.length; i++) {
      // 負減衰なら育ち、そうでなければ車輪の残響として落ちる。
      const coefficient =
        this.target > this.amplitude ? this.riseCoefficient : this.fallCoefficient;
      this.amplitude = this.target + (this.amplitude - this.target) * coefficient;
      if (this.amplitude < 1e-5) {
        // 完全に消えていても位相は進めておく（次に鳴き出すときに段差を作らない）
        this.theta = wrap(this.theta + TWO_PI * WHEEL_MODE * this.dt);
        continue;
      }

      // アタック角は軌道狂いで細かく動くので、音程がわずかに揺れる。
      // 揺れの速さは走っている速さに比例する（狂いの空間波長は決まっているため）。
      this.wobblePhase = wrap(this.wobblePhase + TWO_PI * (0.4 + 0.08 * this.speed) * this.dt);
      this.wobble = 0.9 * this.wobble + 0.1 * this.noise.next();
      const frequency =
        WHEEL_MODE * (1 + WOBBLE_DEPTH * (this.wobble + 0.5 * Math.sin(this.wobblePhase)));
      this.theta = wrap(this.theta + TWO_PI * frequency * this.dt);

      // 固着と滑りの繰り返し。振れ幅が大きいほど飽和して正弦から遠ざかる。
      //
      // 中へ足しているのは**固着と滑りの時間が等しくない**ことを表す偏りである
      // （固着しているほうが長く、滑りは一気に起きる）。飽和したときに残るのは
      // 上下対称な方形波ではなく、上下で長さの違うパルスになり、そこから偶数次の
      // 倍音が出る。偏りを振幅の側に入れると飽和で消えてしまって出ない。
      // 直流分は下の帯域通過が落とす。
      const drive = Math.tanh(3.5 * this.amplitude * (Math.sin(this.theta) + STICK_SLIP_ASYMMETRY));

      let sum = 0;
      for (let m = 0; m < modes.length; m++) {
        sum += modes[m]!.process(drive) * this.weights[m]!;
      }
      out[i] = out[i]! + sum * this.amplitude * SQUEAL_GAIN * this.level;
    }
  }

  reset(): void {
    for (const m of this.modes) m.reset();
    this.theta = 0;
    this.wobblePhase = 0;
    this.wobble = 0;
    this.amplitude = 0;
    this.target = 0;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
