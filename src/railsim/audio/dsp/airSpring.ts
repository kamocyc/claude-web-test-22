import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

/** 空気ばねのきしみを決める量 */
export interface AirSpringParams {
  /**
   * 空気ばねが伸縮する速さ [m/s]（左右のうち大きいほう）。
   * 車体の上下速度と、ロール角速度 × 空気ばね間隔の半分の和になる。
   */
  readonly strokeRate: number;
  /** 音量 0..1 */
  readonly level: number;
}

/**
 * この速さで擦れの音が既定の大きさになる [m/s]。
 * 軌道狂いによる車体の上下・ロールは 1Hz 前後・数 mm なので、
 * ストローク速度はこの程度の桁になる。
 */
const REFERENCE_RATE = 0.05;

/**
 * 空気ばね（ベローズ）のきしみ。
 *
 * 空気ばねは分厚いゴムのベローズで、上下面の金属座に挟まれている。車体が上下・
 * ロールするとベローズが変形し、ゴムと金属、あるいはゴムどうしが**擦れる**。
 * ゴムの摩擦は静摩擦が動摩擦よりかなり大きいので、擦れは滑らかに進まず
 * 固着と滑りを繰り返す — これがスティックスリップで、「ギュッ」というきしみの
 * 正体である。
 *
 * したがって 2 つの成分に分かれる。
 *
 * - **擦れ**: ゴム面が滑る広帯域の音。摩擦の仕事率にあたるのでストローク速度に
 *   比例して大きくなる
 * - **きしみ**: スティックスリップの自励振動。**滑りが遅いときにだけ**立ち上がる。
 *   速く滑ると固着する暇が無く、連続滑りになって鳴かない。制輪子の鳴きと
 *   まったく同じ条件で、`BrakeVoice` の鳴きと同じ形をしている
 *
 * 走行中は転動音に埋もれ、停車前後や低速の曲線でだけ耳に届く。実車で
 * 「ギュー」と聞こえるのがそういう場面に限られるのはこのためである。
 */
export class AirSpringVoice {
  private readonly noise = new Noise(0x3d17);
  private readonly pink = new PinkFilter();
  private readonly rubBand = new Biquad();
  private readonly squeakBand = new Biquad();
  private readonly rubLevel: Smoothed;
  private readonly squeakLevel: Smoothed;

  private targetRub = 0;
  private targetSqueak = 0;

  constructor(sampleRate: number) {
    this.rubLevel = new Smoothed(sampleRate, 0.06);
    // きしみの立ち上がりは擦れより遅い（固着と滑りが揃うまでに時間が要る）
    this.squeakLevel = new Smoothed(sampleRate, 0.15);
    // ゴムが金属座を擦る音。低めで鈍い。
    this.rubBand.bandPass(sampleRate, 360, 1.0);
    // 自励振動はベローズの膜の共振に乗る。かなり鋭い。
    this.squeakBand.bandPass(sampleRate, 780, 26);
    this.setParams({ strokeRate: 0, level: 0 });
  }

  setParams(p: AirSpringParams): void {
    const rate = Math.abs(p.strokeRate);
    const ratio = rate / REFERENCE_RATE;

    // 擦れ ∝ 摩擦の仕事率 ∝ すべり速度
    this.targetRub = p.level * 0.09 * Math.min(1.5, ratio);

    // きしみは「動いてはいるが遅い」ときにだけ出る。速く滑れば連続滑りになる。
    const slow = ratio > 0.15 && ratio < 1.2 ? 1 - Math.abs(ratio - 0.5) / 0.7 : 0;
    this.targetSqueak = p.level * 0.26 * Math.max(0, slow);
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const white = this.noise.next();
      const rub =
        this.rubBand.process(this.pink.process(white)) * this.rubLevel.process(this.targetRub);
      const squeak = this.squeakBand.process(white) * this.squeakLevel.process(this.targetSqueak);
      out[i] = out[i]! + rub + squeak;
    }
  }

  reset(): void {
    this.pink.reset();
    this.rubBand.reset();
    this.squeakBand.reset();
    this.rubLevel.set(0);
    this.squeakLevel.set(0);
  }
}
