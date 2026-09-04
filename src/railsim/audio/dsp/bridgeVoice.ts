import { Biquad, Smoothed } from './biquad.ts';
import { Noise, PinkFilter } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 橋りょうの音を決める量。桁の寸法から出てくる諸元（`bridgeAcoustics()`）を写す。 */
export interface BridgeVoiceParams {
  /** 車速の大きさ [m/s] */
  readonly speed: number;
  /** 桁に乗っている編成の割合 0..1（橋の外なら 0） */
  readonly coverage: number;
  /** 桁が音を出す強さ（無道床プレートガーダー橋を 1 とする） */
  readonly radiation: number;
  /** 橋の構造が走行音を跳ね返す強さ 0..1 */
  readonly reflection: number;
  /** 板の卓越する曲げモード [Hz]（低い順に 3 つ） */
  readonly modes: readonly number[];
  /** モードごとの放射効率 */
  readonly weights: readonly number[];
  /** 減衰比 */
  readonly damping: number;
  /** まくらぎの間隔 [m]（無道床橋の橋まくらぎは密なので脈動が速い） */
  readonly sleeperSpacing: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_BRIDGE: BridgeVoiceParams = {
  speed: 0,
  coverage: 0,
  radiation: 0,
  reflection: 0,
  modes: [60, 130, 230],
  weights: [0.1, 0.2, 0.3],
  damping: 0.01,
  sleeperSpacing: 0.58,
  level: 0,
};

/** 基準速度 [m/s]。転動音（`runningGear.ts`）と同じ値を使う。 */
const REFERENCE_SPEED = 30;

/**
 * 基準の減衰比。
 *
 * 広帯域で叩かれ続けている構造の応答は減衰に反比例する（`<v²> ∝ 1/η`）ので、
 * 振幅は `sqrt(η₀/η)` で効く。無道床の溶接鋼桁をこの基準に取る — 道床を入れると
 * 桁の振動がそこへ食われて見かけの減衰が増えるので、同じ桁でも静かになる。
 */
const REFERENCE_DAMPING = 0.004;

/**
 * 桁の放射の音量。
 *
 * 無道床プレートガーダー橋を基準速度で渡ったときに、A 特性で測って転動音より
 * 8dB ほど大きくなるように取ってある（実測でも無道床鋼橋の騒音は明かり区間より
 * 10〜20dB 高い）。橋の上では走行音が桁の音に覆われるので、渡っているあいだだけ
 * 音の性格がまるごと入れ替わる。橋どうしの大小は寸法から決まるので、ここで
 * 決めているのは**全体の高さだけ**である。
 */
const RADIATION_LEVEL = 11;

/** 反射成分の音量（走行音が桁と主構に跳ね返って戻ってくるぶん） */
const REFLECTION_LEVEL = 0.24;

/** 帯域の広さ。1 枚の板には多数のモードが密に並ぶので、線ではなく帯になる。 */
const MODE_Q = 2.6;

/**
 * 加振力が落ち始める粗さの波長 [m]。
 *
 * 桁を叩いているのは車輪とレールの粗さだが、**短い波長ほど力にならない**。
 * 車輪とレールは点ではなく 15mm ほどの長さで接しているので、それより短い凹凸は
 * 接触面で均されてしまう（接触フィルタ）。粗さのスペクトル自体も短波長側で
 * 下がる。したがって加振力は `速度 / 波長` を境に落ち、その境は速度とともに
 * 上がっていく。板が薄く小さい橋（高いモードを持つ橋）が、低速ではさほど鳴らず
 * 高速で急にうるさくなるのはこのためである。
 */
const CONTACT_WAVELENGTH = 0.06;

/**
 * まくらぎ通過による脈動の深さ。
 * 無道床橋ではまくらぎが桁へ直接締結されているので、支持剛性の変化が
 * 明かり区間（`runningGear.ts` の 0.22）より強く出る。
 */
const SLEEPER_DEPTH = 0.35;

/**
 * 橋りょうを渡る音。
 *
 * 音源は車輪とレールの粗さで、それは明かり区間と同じである。違うのは**力の
 * 行き先**で、土路盤の上なら道床と路盤へ吸われて熱になる力が、橋では桁という
 * 薄い板の集まりへ入り、板が面外に振動して空気を押す。したがって橋の音は
 *
 *   加振力（速度で決まる） × 桁へ届く割合 × 板の動きやすさ × 放射効率
 *
 * の積であり、この 4 つはすべて桁の寸法から決まる（`bridgeAcoustics()`）。
 * 「プレートガーダーの音」「トラスの音」を別々に作っているのではない。
 *
 * 2 つの成分を持つ:
 *
 *  1. **桁の放射** — 板の曲げモードの帯域に集中する。腹板の大きい上路桁は
 *     60〜250Hz の「ゴー」、床組の板が小さいトラスは 150〜600Hz の甲高い音になる。
 *  2. **反射** — 桁が鳴らなくても、橋の上では地面の吸音が無くなり、桁・高欄・
 *     主構が走行音を跳ね返す。有道床のコンクリート橋で聞こえる小さな変化は
 *     ほとんどこれで、「橋を渡った」ことは分かるが轟音にはならない。
 */
export class BridgeVoice {
  private readonly noise = new Noise(0x3d71);
  private readonly pink = new PinkFilter();
  private readonly bands: Biquad[] = [];
  private readonly reflectionBand = new Biquad();
  private readonly levels: Smoothed[] = [];
  private readonly reflectionLevel: Smoothed;
  private readonly sleeperFrequency: Smoothed;

  private readonly targets = [0, 0, 0];
  private targetReflection = 0;
  private targetSleeper = 0;
  private theta = 0;
  private readonly dt: number;

  constructor(private readonly sampleRate: number) {
    this.dt = 1 / sampleRate;
    for (let m = 0; m < 3; m++) {
      this.bands.push(new Biquad());
      // 橋へ乗った瞬間・降りた瞬間に音が切り替わるのが橋の音の特徴なので、
      // 平滑化は短く取る（長くすると橋台を過ぎてから鳴り出す）。
      this.levels.push(new Smoothed(sampleRate, 0.02));
    }
    this.reflectionLevel = new Smoothed(sampleRate, 0.02);
    this.sleeperFrequency = new Smoothed(sampleRate, 0.05);
    this.reflectionBand.bandPass(sampleRate, 700, 0.5);
    this.setParams(SILENT_BRIDGE);
  }

  setParams(p: BridgeVoiceParams): void {
    const v = Math.abs(p.speed);
    const coverage = Math.max(0, Math.min(1, p.coverage));
    // 加振力は転動音と同じ速度依存（車輪とレールの粗さが音源なので当然そうなる）
    const excitation = Math.pow(v / REFERENCE_SPEED, 1.5) * coverage;
    // 広帯域で叩かれ続ける構造の応答は減衰に反比例する
    const resonanceGain = Math.sqrt(REFERENCE_DAMPING / Math.max(1e-4, p.damping));

    // 加振力が落ち始める周波数。速度で決まるので、同じ橋でも速度で音色が変わる。
    const corner = v > 0.1 ? v / CONTACT_WAVELENGTH : 0;

    for (let m = 0; m < this.bands.length; m++) {
      const frequency = p.modes[m] ?? 0;
      if (frequency > 20) this.bands[m]!.bandPass(this.sampleRate, frequency, MODE_Q);
      const contact = corner > 0 ? 1 / (1 + frequency / corner) : 0;
      this.targets[m] =
        frequency > 20
          ? p.level *
            RADIATION_LEVEL *
            excitation *
            contact *
            p.radiation *
            resonanceGain *
            (p.weights[m] ?? 0)
          : 0;
    }
    this.targetReflection = p.level * REFLECTION_LEVEL * excitation * p.reflection;
    this.targetSleeper = p.sleeperSpacing > 0 ? v / p.sleeperSpacing : 0;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const white = this.noise.next();
      const pink = this.pink.process(white);

      // まくらぎ通過。無道床橋ではまくらぎが桁に直付けなので、1 本踏むごとに
      // 桁を叩くことになり、脈動がそのまま「ドドドド」になる。
      const sleeper = this.sleeperFrequency.process(this.targetSleeper);
      this.theta = wrap(this.theta + TWO_PI * sleeper * this.dt);
      const support = 1 + SLEEPER_DEPTH * Math.sin(this.theta);

      let sum = 0;
      for (let m = 0; m < this.bands.length; m++) {
        sum += this.bands[m]!.process(pink) * this.levels[m]!.process(this.targets[m]!);
      }
      sum +=
        this.reflectionBand.process(white) * this.reflectionLevel.process(this.targetReflection);
      out[i] = out[i]! + sum * support;
    }
  }

  reset(): void {
    this.pink.reset();
    for (const band of this.bands) band.reset();
    this.reflectionBand.reset();
    for (const level of this.levels) level.set(0);
    this.reflectionLevel.set(0);
    this.sleeperFrequency.set(0);
    this.theta = 0;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
