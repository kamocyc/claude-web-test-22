import type { Pascals, Seconds } from '../units.ts';

/** 空気圧縮機と元空気溜めの仕様 */
export interface CompressorSpec {
  /** 起動圧（これを下回ると回り出す）[Pa] */
  readonly cutInPressure: Pascals;
  /** 停止圧（これに達すると止まる）[Pa] */
  readonly cutOutPressure: Pascals;
  /** 吐出しによる元空気溜め圧の上昇率 [Pa/s] */
  readonly chargeRate: number;
  /** 漏れによる低下率 [Pa/s] */
  readonly leakRate: number;
  /**
   * ブレーキシリンダへ 1 Pa 込めるごとに元空気溜めから失われる圧力の比。
   * BC の容積と元空気溜めの容積の比にあたる。
   */
  readonly cylinderConsumption: number;
  /** 起動してから吐出しが立ち上がるまでの時間 [s] */
  readonly startupTime: Seconds;
}

/**
 * 在来線の通勤形の代表値。
 *
 * 750kPa まで下がると起動し、880kPa で停止する。漏れ（ブレーキ管・戸閉め
 * 装置・空気ばねの消費を均した値）だけなら 2.7 分ほどで下限に達し、そこから
 * 45 秒ほど回って止まる。常用最大のブレーキ 1 回で 32kPa ほど余分に食うので、
 * 駅に止まるたびにコンプレッサの起動が早まる。停車中に「プシュー」のあと
 * しばらくして突然回り出す、という実車の間合いになる。
 */
export const DEFAULT_COMPRESSOR: CompressorSpec = {
  cutInPressure: 750_000,
  cutOutPressure: 880_000,
  chargeRate: 3_250,
  leakRate: 800,
  cylinderConsumption: 0.02,
  startupTime: 0.6,
};

export interface CompressorState {
  /** 元空気溜め圧 [Pa] */
  pressure: Pascals;
  /** 運転中か */
  running: boolean;
  /** 起動してからの経過時間 [s]（立ち上がりの表現に使う） */
  runningTime: Seconds;
  /** 吐出し能力の立ち上がり 0..1 */
  output: number;
}

/**
 * 空気圧縮機と元空気溜め。
 *
 * **ブレーキの物理には影響させない**。実車では元空気溜めが枯渇すれば制動力が
 * 落ちるが、そこまで踏み込むと「空気が足りずに止まれない」という別の題材に
 * なってしまう。ここでの目的は、走行中に突然コンプレッサが回り出して
 * しばらくして止まるという、車内で最も耳につく補機の挙動を出すことにある。
 *
 * したがって圧力は「ブレーキを使うほど下がり、漏れでも下がり、下限で起動して
 * 上限で止まる」という収支だけを持つ。
 */
export class AirCompressor {
  readonly state: CompressorState;

  constructor(private readonly spec: CompressorSpec = DEFAULT_COMPRESSOR) {
    this.state = {
      pressure: spec.cutOutPressure,
      running: false,
      runningTime: 0,
      output: 0,
    };
  }

  /**
   * @param cylinderFillRate 編成のブレーキシリンダ圧の上昇量の合計 [Pa/s]（込め側のみ）
   */
  step(dt: number, cylinderFillRate: number): CompressorState {
    const spec = this.spec;
    const st = this.state;

    if (st.running) {
      if (st.pressure >= spec.cutOutPressure) {
        st.running = false;
        st.runningTime = 0;
      }
    } else if (st.pressure <= spec.cutInPressure) {
      st.running = true;
      st.runningTime = 0;
    }

    if (st.running) {
      st.runningTime += dt;
      st.output = spec.startupTime > 0 ? Math.min(1, st.runningTime / spec.startupTime) : 1;
    } else {
      st.output = 0;
    }

    const gain = st.output * spec.chargeRate;
    const loss = spec.leakRate + Math.max(0, cylinderFillRate) * spec.cylinderConsumption;
    st.pressure = Math.max(0, st.pressure + (gain - loss) * dt);
    return st;
  }

  reset(): void {
    this.state.pressure = this.spec.cutOutPressure;
    this.state.running = false;
    this.state.runningTime = 0;
    this.state.output = 0;
  }
}
