import { clamp } from '../math/scalar.ts';
import { kmhToMps, type MetersPerSecond, type Seconds } from '../units.ts';

/**
 * 抑速ブレーキの調速器。
 *
 * 運転士から見た抑速ブレーキは**位置が 1 つしかない**。ハンドルを抑速位置へ入れると、
 * あとは「入れた時点の速度を保つ」ように装置が電気ブレーキの段を選び続ける。
 * 下り勾配で段を数えながら込めたり緩めたりするのは装置の仕事であって、
 * 運転士の仕事ではない。
 *
 * やっていることは、速度を見ながら段を 1 つずつ動かす積分動作である。
 *
 *  - 入れた瞬間の速度を目標にする（そこから先は「その速度を保て」という指令になる）
 *  - 目標より不感帯ぶん速ければ 1 段強める。遅ければ 1 段弱める
 *  - 段を動かしたら `holdTime` のあいだは動かさない
 *
 * 段を動かすたびに待つのは、電気ブレーキの応答（トルクの立ち上がりと車体の減速）が
 * 現れるまで次の判断をしないためである。待たずに詰めると、応答が出る前に段を
 * 重ねてしまい、目標速度のまわりで振動する。
 *
 * 平坦線で入れた場合は、1 段目で速度が落ちはじめた時点で目標を下回るので段が
 * 0 へ戻る。つまり抑速位置に入れっぱなしでも減速し続けることはない。
 * 「勾配を抑える」装置として振る舞う。
 */
export interface HoldingRegulatorParams {
  /** この速度を下回ると電気ブレーキが立たないので切る [m/s] */
  readonly minSpeed: MetersPerSecond;
  /** 段を動かしてから次に動かせるようになるまでの時間 [s] */
  readonly holdTime: Seconds;
  /** 目標速度の不感帯 [m/s]（±この幅の中では段を動かさない） */
  readonly band: MetersPerSecond;
}

export const DEFAULT_HOLDING_REGULATOR: HoldingRegulatorParams = {
  minSpeed: kmhToMps(5),
  holdTime: 1.2,
  band: kmhToMps(1.5),
};

export class HoldingBrakeRegulator {
  private engaged = false;
  private notch = 0;
  private target: MetersPerSecond = 0;
  private timer: Seconds = 0;

  constructor(private readonly params: HoldingRegulatorParams = DEFAULT_HOLDING_REGULATOR) {}

  /** 装置が選んでいる抑速ノッチ（0 = 電気ブレーキを出していない） */
  get command(): number {
    return this.notch;
  }

  /** 保持している目標速度 [m/s]（抑速位置にいないときは 0） */
  get targetSpeed(): MetersPerSecond {
    return this.engaged ? this.target : 0;
  }

  reset(): void {
    this.engaged = false;
    this.notch = 0;
    this.target = 0;
    this.timer = 0;
  }

  /**
   * 1 制御周期ぶん進め、選んだ段を返す。
   *
   * @param engaged ハンドルが抑速位置にあるか
   * @param speed   現在の速度 [m/s]（絶対値）
   * @param count   選べる段数（車両のブレーキ段数）
   */
  update(dt: Seconds, engaged: boolean, speed: MetersPerSecond, count: number): number {
    if (!engaged || count <= 0) {
      this.reset();
      return 0;
    }

    // 抑速位置へ入れた瞬間の速度を目標にする
    if (!this.engaged) {
      this.engaged = true;
      this.target = speed;
      this.notch = 0;
      this.timer = this.params.holdTime;
    }

    // 低速では電気ブレーキそのものが立たない。段を上げても効かないので切っておく
    if (speed < this.params.minSpeed) {
      this.notch = 0;
      this.timer = 0;
      return 0;
    }

    this.timer += dt;
    if (this.timer >= this.params.holdTime) {
      if (speed > this.target + this.params.band && this.notch < count) {
        this.notch++;
        this.timer = 0;
      } else if (speed < this.target - this.params.band && this.notch > 0) {
        this.notch--;
        this.timer = 0;
      }
    }
    this.notch = clamp(this.notch, 0, count);
    return this.notch;
  }
}
