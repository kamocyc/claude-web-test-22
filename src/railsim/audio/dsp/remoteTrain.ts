import { OnePoleLowPass, Smoothed } from './biquad.ts';
import { CAR_BODY_LOSS, CarBodyInsulation } from './carBody.ts';
import type { JointImpact } from './railJointVoice.ts';
import type { TurnoutImpact } from './turnoutVoice.ts';
import { TrainNoiseSynth, type TrainNoiseParams } from './synth.ts';

/** 隣の線路を走る列車の音を決める量 */
export interface RemoteTrainParams {
  /** 隣の線路に列車がいるか */
  readonly present: boolean;
  /**
   * 相手の列車が出している音そのもの。
   *
   * 自列車に渡すものと**まったく同じ型**で、同じ合成器が受け取る。距離による
   * 減衰は音源ごとに位置が違うので、各 `level` に織り込んだ形で渡す
   * （電動機は相手の M 車の床下、転動音は相手の編成のいちばん近い足元…）。
   */
  readonly train: TrainNoiseParams;
  /** 運転台から相手までの距離 [m]（伝わる時間と空気の吸収を決める） */
  readonly distance: number;
  /** 音量 0..1 */
  readonly level: number;
}

/** 空気中の音速 [m/s] */
const SOUND_SPEED = 343;

/** 扱う最大の距離 [m]（これより遠い音は届かない） */
const MAX_DISTANCE = 500;

/**
 * この距離で高域が失われはじめる [m]。
 * 遠い列車の音がこもって聞こえるのは、空気そのものが高い成分を吸うからである。
 */
const AIR_ABSORPTION_DISTANCE = 25;

/** 空気の吸収を掛けない距離での遮断周波数 [Hz] */
const AIR_ABSORPTION_TOP = 18_000;

/**
 * 音源の音量を「運転台で聞こえる大きさ」から「車外での大きさ」へ直す係数。
 *
 * 各音源の音量は**自分の運転台で聞こえる大きさ**で揃えてある。しかし同じ装置を
 * 車外で聞けばもっと大きい — 自分の車体が遮っているぶんだけである。相手の列車は
 * その車外の音量で放射しており、それがこちらの車体でもう一度遮られて届く。
 *
 * つまり車体という同じ壁を、相手の音は**外向きに 1 回・内向きに 1 回**通る。
 * 低い音では 2 つがほぼ相殺し、高い音では質量則の傾きだけが残る。すれ違う列車が
 * 「自分の走行音と同じくらいの大きさなのに、明らかにこもって聞こえる」のは
 * この非対称のためで、音量を下げるだけでは同じようには聞こえない。
 */
const OUTSIDE_GAIN = 1 / CAR_BODY_LOSS;

/**
 * 隣の線路を走る列車。
 *
 * **自列車と同じ合成器をもう 1 つ持ち、同じパラメータで鳴らす。** インバータの
 * 磁気音も、歯車のかみ合いも、転動音も、継目も、分岐器も、扉も、圧縮機も、
 * 相手の車内で鳴っているのとまったく同じものが出る。相手が力行していれば
 * ゲートの開いた音がするし、ブレーキを掛けていればシューという音がする —
 * 相手の状態がどうであれ、こちらで場合分けする必要が無い。
 *
 * 違うのは**そこから耳へ届くまで**だけで、その経路をこのクラスが受け持つ。
 *
 *  1. **伝わる時間** — 音は 343m/s でしか進まないので、`r/c` だけ遅れて届く。
 *     この遅れは相手が近づけば縮み、遠ざかれば伸びる。つまり遅延の長さを
 *     距離どおりに動かすだけで、**音源の全部にドップラー効果が同時に掛かる**。
 *     音源ごとに周波数を掛け直す必要は無い。これは近似ではなく、ドップラー効果
 *     そのものの定義（波面が届く時刻のずれ）である。真横を過ぎる瞬間に距離の
 *     変化率が 0 になり、そこで音程が元へ戻ることも自然に出る。
 *  2. **空気の吸収** — 遠いほど高域が先に失われる。近づくにつれて音が「開く」。
 *  3. **車体の遮音** — 相手の音は車外の空気を伝わってくるので、窓と車体を
 *     透過するぶんだけ削られてこもる（`CarBodyInsulation`）。
 *
 * 距離による**音量**の減衰だけはここに無い。音源ごとに位置が違う（電動機は
 * 相手の M 車、転動音は相手の全長）ので、それぞれの `level` に織り込んで渡す。
 *
 * すれ違いざまの圧力波（`PassingVoice`）だけはこの経路を通らない。あれは音として
 * 伝わってくるのではなく、相手が押しのけた空気が車体を直接叩く力だからである。
 */
export class RemoteTrainVoice {
  /** 相手の列車そのものの音（自列車と同じ実装） */
  readonly synth: TrainNoiseSynth;

  private readonly body: CarBodyInsulation;
  private readonly airAbsorption: OnePoleLowPass;
  private readonly gain: Smoothed;
  /** 伝搬遅れ。長さを距離どおりに動かすことがそのままドップラー効果になる。 */
  private readonly line: Float32Array;
  private write = 0;
  /** いまの遅れ [サンプル]（前のブロックの終わりの値） */
  private delay = 0;
  private targetDelay = 0;
  private target = 0;
  private scratch = new Float32Array(0);
  private present = false;
  private silent = true;

  constructor(readonly sampleRate: number) {
    this.body = new CarBodyInsulation(sampleRate);
    this.airAbsorption = new OnePoleLowPass(sampleRate, AIR_ABSORPTION_TOP);
    this.gain = new Smoothed(sampleRate, 0.05);
    this.synth = new TrainNoiseSynth(sampleRate);
    this.line = new Float32Array(Math.ceil((MAX_DISTANCE / SOUND_SPEED) * sampleRate) + 4);
  }

  /** 隣に誰も居なければ `null` を渡す（鳴っている音は自然に消える） */
  setParams(p: RemoteTrainParams | null): void {
    this.present = p?.present ?? false;
    if (!p || !p.present) {
      this.target = 0;
      return;
    }
    this.silent = false;
    this.synth.setParams(p.train);
    this.target = p.level;
    const r = Math.min(MAX_DISTANCE, Math.max(0, p.distance));
    this.targetDelay = Math.min(this.line.length - 2, (r / SOUND_SPEED) * this.sampleRate);
    this.airAbsorption.setCutoff(
      Math.max(600, AIR_ABSORPTION_TOP / (1 + r / AIR_ABSORPTION_DISTANCE)),
    );
  }

  /** 相手の軸が踏んだ継目（自列車とまったく同じ音源へ送る） */
  triggerJoint(impact: JointImpact): void {
    this.synth.triggerJoint(impact);
  }

  /** 相手が渡った分岐器 */
  triggerTurnout(impact: TurnoutImpact): void {
    this.synth.triggerTurnout(impact);
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const n = out.length;
    if (this.silent) return;
    if (this.scratch.length !== n) this.scratch = new Float32Array(n);
    const scratch = this.scratch;
    this.synth.render(scratch);

    const from = this.delay;
    const to = this.targetDelay;
    const line = this.line;
    const size = line.length;
    for (let i = 0; i < n; i++) {
      line[this.write] = scratch[i]!;
      // 遅れをブロックのあいだで滑らかに動かす。読む速さが書く速さと変わり、
      // それが音程の変化（ドップラー効果）になる。
      const delay = from + ((to - from) * (i + 1)) / n;
      const read = this.write - delay + size;
      const index = Math.floor(read);
      const frac = read - index;
      const a = line[index % size]!;
      const b = line[(index + 1) % size]!;
      this.write = (this.write + 1) % size;

      const gain = this.gain.process(this.target) * OUTSIDE_GAIN;
      if (gain < 1e-6) continue;
      out[i] = out[i]! + this.body.process(this.airAbsorption.process(a + (b - a) * frac)) * gain;
    }
    this.delay = to;

    // 完全に消えたら合成器ごと止める（隣に誰も居ない区間で回し続けない）
    if (!this.present && this.gain.current < 1e-6) {
      this.silent = true;
      this.synth.reset();
      this.line.fill(0);
      this.body.reset();
      this.airAbsorption.reset();
    }
  }

  reset(): void {
    this.synth.reset();
    this.body.reset();
    this.airAbsorption.reset();
    this.gain.set(0);
    this.line.fill(0);
    this.write = 0;
    this.delay = 0;
    this.targetDelay = 0;
    this.target = 0;
    this.present = false;
    this.silent = true;
  }
}
