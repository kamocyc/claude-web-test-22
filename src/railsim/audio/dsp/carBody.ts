import { OnePoleLowPass } from './biquad.ts';

/**
 * 運転台の遮音。
 *
 * 運転士は**閉じた箱の中**にいる。この合成器の音源のうち、走行装置のもの
 * （主回路・歯車・転動音・継目・橋）は床下や台車から**構造を伝わって**車内へ
 * 入るので、はじめから「車内で聞こえる大きさ」として測って合わせてある。
 * ところが踏切の警報音と対向列車の音はそうではない — **車外の空気を伝わって
 * きた音**なので、窓と車体を透過するぶんだけ削られてから耳に届く。
 *
 * 削られ方は一様ではない。板を隔てた音の透過は**質量則**に従い、透過損失は
 * 周波数が 2 倍になるごとにおよそ 6dB 増える。つまり**高い音ほどよく遮られる**
 * ので、外の音は小さくなるだけでなく**こもる**。踏切の「カンカン」が、窓を
 * 開けたときと閉めたときで音量だけでなく音色まで変わるのはこのためである。
 *
 * ここでは 1 次の低域通過（-6dB/oct）と全体の減衰でそれを表す。低域での透過を
 * `CAR_BODY_LOSS`、質量則が効きはじめる周波数を `CAR_BODY_CORNER` とすると、
 *
 * | 周波数 | 透過 |
 * | ------ | ---- |
 * | 200Hz  | −18dB |
 * | 800Hz  | −24dB |
 * | 3.2kHz | −36dB |
 *
 * となり、実車の運転室で測られる値とおおむね合う（完全な密閉ではなく、貫通路や
 * 窓のゴム、床下からの回り込みがあるので低域はよく漏れる）。
 */
export class CarBodyInsulation {
  private readonly wall: OnePoleLowPass;

  constructor(sampleRate: number) {
    this.wall = new OnePoleLowPass(sampleRate, CAR_BODY_CORNER);
  }

  /** 車外の音 1 サンプルを、運転台の中で聞こえる大きさへ直す */
  process(outside: number): number {
    return this.wall.process(outside) * CAR_BODY_LOSS;
  }

  reset(): void {
    this.wall.reset();
  }
}

/**
 * 低域での透過（振幅比）。
 *
 * 0.13 は約 −18dB。踏切の警報音は屋外では走行音よりよほど大きい（1m で 90dB 級）
 * のに、運転台の中では走行音に埋もれ気味に聞こえる — その差はほとんどこの
 * 1 つの数字で決まっている。
 */
export const CAR_BODY_LOSS = 0.13;

/**
 * 質量則が効きはじめる周波数 [Hz]。
 * これより上では 2 倍ごとに 6dB ずつ余分に遮られる。
 */
export const CAR_BODY_CORNER = 260;
