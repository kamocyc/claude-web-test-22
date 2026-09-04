import { Biquad, Smoothed } from './biquad.ts';
import { Noise } from './noise.ts';

const TWO_PI = Math.PI * 2;

/** 保安装置の報知音を決める量（`SafetyIndication` から素直に写せる） */
export interface AlarmParams {
  /** 警報ベル（打鈴）が鳴っているか */
  readonly bell: boolean;
  /** 確認扱い後のチャイムが鳴っているか */
  readonly chime: boolean;
  /** パターン接近のブザーが鳴っているか */
  readonly patternApproach: boolean;
  /** 音量 0..1 */
  readonly level: number;
}

/** 打鈴のハンマーが鐘を叩く回数 [Hz]（電磁ベルなので速い連打になる） */
const BELL_STRIKES = 32;

/**
 * 鐘の部分音 [周波数 Hz, Q, 減衰時定数 s, 重み]。
 *
 * 鐘は棒や弦と違って部分音が整数比に**ならない**。「ジリリリ」が音程を持たずに
 * 耳につくのはこのためで、正弦を重ねただけでは電子音になってしまう。
 */
const BELL_PARTIALS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1180, 30, 0.075, 1.0],
  [1790, 34, 0.04, 0.65],
  [3270, 40, 0.025, 0.4],
];

/**
 * 保安装置の報知音。
 *
 * 3 つとも**運転台の中の装置**が鳴らす音なので、距離減衰が掛からない。
 * 走行音がどれだけ大きくても運転士に届かなければ意味が無いのだから、
 * これは設計上そうなっているのであって、都合で大きくしているのではない。
 *
 * - **打鈴**: 電磁ベル。電磁石がハンマーを引き、接点が切れて戻り、また引く、
 *   という自励で高速に連打する。1 打ごとに鐘が鳴って減衰するので、
 *   連打の周期と鐘の減衰の重なりが「ジリリリ」になる
 * - **チャイム**: 確認扱いのあとに続く電子音。打鈴と違って持続する
 * - **ブザー**: ATS-P のパターン接近。断続する矩形波で、チャイムより急かす音
 */
export class AlarmVoice {
  private readonly partials: Biquad[] = [];
  private readonly partialWeights: number[] = [];
  private readonly partialDecays: number[] = [];
  private readonly partialEnvelopes: number[] = [];

  private readonly bellLevel: Smoothed;
  private readonly chimeLevel: Smoothed;
  private readonly buzzerLevel: Smoothed;

  private strikePhase = 0;
  private thetaChimeA = 0;
  private thetaChimeB = 0;
  private thetaBuzzer = 0;
  private thetaBuzzerGate = 0;

  private targetBell = 0;
  private targetChime = 0;
  private targetBuzzer = 0;
  private readonly dt: number;

  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.bellLevel = new Smoothed(sampleRate, 0.01);
    this.chimeLevel = new Smoothed(sampleRate, 0.02);
    this.buzzerLevel = new Smoothed(sampleRate, 0.01);
    for (const [frequency, q, tau, weight] of BELL_PARTIALS) {
      this.partials.push(new Biquad().bandPass(sampleRate, frequency, q));
      this.partialWeights.push(weight);
      this.partialDecays.push(Math.exp(-1 / (sampleRate * tau)));
      this.partialEnvelopes.push(0);
    }
    this.setParams({ bell: false, chime: false, patternApproach: false, level: 0 });
  }

  setParams(p: AlarmParams): void {
    this.targetBell = p.bell ? p.level * 1.8 : 0;
    this.targetChime = p.chime ? p.level * 0.11 : 0;
    this.targetBuzzer = p.patternApproach ? p.level * 0.22 : 0;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const bell = this.bellLevel.process(this.targetBell);
      const chime = this.chimeLevel.process(this.targetChime);
      const buzzer = this.buzzerLevel.process(this.targetBuzzer);

      // --- 打鈴 ---
      let sound = 0;
      if (bell > 1e-5 || this.partialEnvelopes.some((e) => e > 1e-4)) {
        this.strikePhase += BELL_STRIKES * this.dt;
        let struck = 0;
        if (this.strikePhase >= 1) {
          this.strikePhase -= 1;
          struck = bell > 1e-5 ? 1 : 0;
        }
        for (let k = 0; k < this.partials.length; k++) {
          if (struck) this.partialEnvelopes[k] = 1;
          const env = this.partialEnvelopes[k]!;
          // ハンマーの打撃そのものは 1 サンプルの衝撃。あとは鐘が減衰しながら鳴る。
          const excitation = struck ? 1 : env * 0.12;
          sound += this.partials[k]!.process(excitation) * this.partialWeights[k]! * bell * 22;
          this.partialEnvelopes[k] = env * this.partialDecays[k]!;
        }
      }

      // --- チャイム（2 音の持続音）---
      if (chime > 1e-5) {
        this.thetaChimeA = wrap(this.thetaChimeA + TWO_PI * 660 * this.dt);
        this.thetaChimeB = wrap(this.thetaChimeB + TWO_PI * 990 * this.dt);
        sound += (Math.sin(this.thetaChimeA) + 0.45 * Math.sin(this.thetaChimeB)) * chime;
      }

      // --- ブザー（断続する矩形波）---
      if (buzzer > 1e-5) {
        this.thetaBuzzer = wrap(this.thetaBuzzer + TWO_PI * 840 * this.dt);
        this.thetaBuzzerGate = wrap(this.thetaBuzzerGate + TWO_PI * 4 * this.dt);
        const gate = this.thetaBuzzerGate < Math.PI ? 1 : 0;
        sound += (this.thetaBuzzer < Math.PI ? 1 : -1) * 0.5 * buzzer * gate;
      }

      out[i] = out[i]! + sound;
    }
  }

  reset(): void {
    for (const f of this.partials) f.reset();
    this.partialEnvelopes.fill(0);
    this.strikePhase = 0;
    this.thetaChimeA = 0;
    this.thetaChimeB = 0;
    this.thetaBuzzer = 0;
    this.thetaBuzzerGate = 0;
    this.bellLevel.set(0);
    this.chimeLevel.set(0);
    this.buzzerLevel.set(0);
  }
}

/** 警笛を決める量 */
export interface HornParams {
  /** 吹鳴しているか */
  readonly sounding: boolean;
  /** 音量 0..1 */
  readonly level: number;
}

/** 空気笛 2 管の基本周波数 [Hz]。わずかにずらしてあるのでうなりが出る。 */
const HORN_TONES = [311, 370] as const;

/** 圧力の立ち上がり・立ち下がりの時定数 [s] */
const HORN_ATTACK = 0.045;
const HORN_RELEASE = 0.06;

/**
 * 警笛（空気笛・タイフォン）。
 *
 * 電磁弁が開くと元空気溜めの圧縮空気がリードを振動させ、ラッパ（ホーン）で
 * 放射する。**リードの振動なので倍音が豊か**で、正弦を鳴らしても似ない。
 * ここでは倍音を持つ波形をラッパの共振に通して作る。
 *
 * 2 つの管を持つのが普通で、周波数をわずかにずらしてあるためうなりが乗る。
 * これが「単なるブザー」と違って聞こえる最大の要因になっている。
 *
 * 吹き始めは弁が開いてから圧力が立ち上がるまでの間があり、そのあいだは音程が
 * 少し低い（リードの振動数が圧力で決まるため）。空気の吹き出し音も混ざる。
 * 離すと圧力が抜けながら音程が下がって消える。
 */
export class HornVoice {
  private readonly noise = new Noise(0x6b2f);
  private readonly hornBody = new Biquad();
  private readonly airBand = new Biquad();
  private readonly thetas = [0, 0];

  private pressure = 0;
  private target = 0;
  private level = 0;
  private readonly attack: number;
  private readonly release: number;
  private readonly dt: number;

  constructor(sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.attack = Math.exp(-1 / (sampleRate * HORN_ATTACK));
    this.release = Math.exp(-1 / (sampleRate * HORN_RELEASE));
    // ラッパの共振。ここを通すことで「金属のラッパから出た」音色になる。
    this.hornBody.bandPass(sampleRate, 1250, 1.1);
    this.airBand.bandPass(sampleRate, 2800, 0.7);
  }

  setParams(p: HornParams): void {
    this.target = p.sounding ? 1 : 0;
    this.level = p.level;
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const coefficient = this.target > this.pressure ? this.attack : this.release;
      this.pressure = this.target + (this.pressure - this.target) * coefficient;
      // 弁を閉じたあと、圧力が抜けきったところで止める（吹鳴中は素通り）
      if (this.target === 0 && this.pressure < 1e-3) {
        this.pressure = 0;
        continue;
      }
      // リードの振動数は圧力で決まる。立ち上がりで音程がわずかに上がる。
      const bend = 0.93 + 0.07 * this.pressure;

      let tone = 0;
      for (let k = 0; k < HORN_TONES.length; k++) {
        this.thetas[k] = wrap(this.thetas[k]! + TWO_PI * HORN_TONES[k]! * bend * this.dt);
        // リードが作る倍音の豊かな波形（のこぎり波に近い形）
        const theta = this.thetas[k]!;
        tone +=
          Math.sin(theta) +
          0.5 * Math.sin(2 * theta) +
          0.33 * Math.sin(3 * theta) +
          0.22 * Math.sin(4 * theta) +
          0.15 * Math.sin(5 * theta);
      }
      const air = this.airBand.process(this.noise.next()) * 0.25;
      const radiated = (tone * 0.14 + this.hornBody.process(tone) * 0.1 + air) * 0.7;
      out[i] = out[i]! + radiated * this.pressure * this.level;
    }
  }

  reset(): void {
    this.hornBody.reset();
    this.airBand.reset();
    this.thetas[0] = 0;
    this.thetas[1] = 0;
    this.pressure = 0;
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
