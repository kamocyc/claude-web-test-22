import { CarBodyInsulation } from './carBody.ts';
import { Noise } from './noise.ts';
import { OnePoleLowPass, Smoothed } from './biquad.ts';

const TWO_PI = Math.PI * 2;

/** 警報機の方式 */
export type CrossingBellKind = 'gong' | 'electronic';

/** 踏切の警報音を決める量 */
export interface CrossingVoiceParams {
  /** 鳴動しているか */
  readonly ringing: boolean;
  /** 警報機の方式 */
  readonly bell: CrossingBellKind;
  /** 運転台から踏切までの線路方向の距離 [m]（正 = 前方、負 = 通過済み） */
  readonly distance: number;
  /** 警報機の軌道中心からの横の距離 [m] */
  readonly lateral: number;
  /** 2 台の警報機の線路方向の間隔 [m]（道路の幅ぶん離れて建つ） */
  readonly postSpacing: number;
  /** 自列車の速度 [m/s]（進行方向が正） */
  readonly speed: number;
  /** 音量 0..1 */
  readonly level: number;
}

export const SILENT_CROSSING: CrossingVoiceParams = {
  ringing: false,
  bell: 'electronic',
  distance: 1e6,
  lateral: 3.5,
  postSpacing: 8,
  speed: 0,
  level: 0,
};

/** 空気中の音速 [m/s] */
const SOUND_SPEED = 343;

/**
 * 部分音 [基本周波数に対する比, 重み, 減衰時定数 s]。
 *
 * **電子式**は発振器の音なので、部分音は基本波の整数倍にきれいに乗る。矩形波に
 * 近い倍音構成で、1 打ごとに短く切れる（「カン カン」と粒が立つのはこのため）。
 *
 * **電鐘式**は電磁石でハンマーが鐘を叩く。鐘の部分音は棒や弦と違って整数比に
 * **ならない**ので音程として聞こえず、金属的な響きが長く残る。同じ「カン」でも
 * 電子式と似ないのはここが理由で、比を整数にした瞬間に電子音になってしまう。
 */
const ELECTRONIC_PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1.0, 0.15],
  [2, 0.32, 0.1],
  [3, 0.14, 0.07],
];

const GONG_PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1.0, 0.5],
  [2.17, 0.62, 0.32],
  [3.01, 0.38, 0.2],
  [4.63, 0.22, 0.12],
];

/** 基本周波数 [Hz] */
const ELECTRONIC_BASE = 700;
const GONG_BASE = 545;

/** 1 台あたりの打数 [Hz]。2 台が半周期ずれて鳴るので、聞こえるのはこの 2 倍。 */
const ELECTRONIC_RATE = 1.0;
const GONG_RATE = 1.15;

/** この距離で音量が基準になる [m] */
const REFERENCE_DISTANCE = 8;

/**
 * 基準距離での音量（**車外での**大きさ）。
 *
 * 警報機は道路の利用者へ向けて鳴らす装置なので、屋外ではかなり大きい
 * （1m で 90dB 級）。ここはその車外の音量で、運転台の中でどう聞こえるかは
 * 車体の遮音（`CarBodyInsulation`）を通したあとの話になる。窓を閉めた運転室では
 * 走行音に埋もれ気味になり、それが実際の聞こえ方である。
 */
const BELL_LEVEL = 2.6;

/** 同時に扱う警報機の数（踏切道の両側に 1 台ずつ） */
const POSTS = 2;

/** 部分音の最大数（方式のうち多いほう） */
const MAX_PARTIALS = 4;

/**
 * 踏切の警報音。
 *
 * **踏切の音は踏切のためではなく道路のために鳴っている**。運転台はそれを通り
 * すがりに聞くだけなので、聞こえ方は音そのものではなく位置関係で決まる。
 *
 *  - **距離減衰** — 音源は線路脇の 1 点なので、音圧は距離に反比例する。
 *    600m 手前で鳴り始めても、聞こえ出すのは 100m を切ってからになる。
 *  - **空気の吸収** — 遠いほど高い成分が先に失われる。近づくにつれて音が
 *    「開く」のはこのためで、音量だけを変えても同じようには聞こえない。
 *  - **ドップラー効果** — 音源は止まっていて**自分が動いている**ので、
 *    音源が動く場合の式（`f c/(c−v)`）ではなく観測者が動く場合の式
 *    `f (1 + v_r/c)` になる。v_r は音源へ向かう速度成分なので、真横を過ぎる
 *    瞬間に 0 を通り、そこで音程が最も速く下がる。110km/h なら前後で 1.089 倍と
 *    0.911 倍、およそ 3 半音の落差になる。
 *
 * 警報機は踏切道の両側に 1 台ずつ、半周期ずらして鳴らす。これが「カン カン」の
 * 交互感を作っており、しかも 2 台は線路方向に離れているので、通過の瞬間には
 * **片方が近づきながら、もう片方が遠ざかりながら**鳴ることになる。
 */
export class CrossingVoice {
  private readonly noise = new Noise(0x1f4b);
  /** 車体の遮音。音源は車外にあるので、窓と車体を透過してから耳に届く。 */
  private readonly body: CarBodyInsulation;
  private readonly airAbsorption: OnePoleLowPass[] = [];
  private readonly gains: Smoothed[] = [];

  /** 警報機 × 部分音 の位相と包絡 */
  private readonly phases = new Float64Array(POSTS * MAX_PARTIALS);
  private readonly envelopes = new Float64Array(POSTS * MAX_PARTIALS);
  /** ハンマーの打撃そのもの（広帯域の立ち上がり）の包絡 */
  private readonly strikeEnvelopes = new Float64Array(POSTS);
  /** 打つ周期の位相 */
  private readonly strikePhases = new Float64Array(POSTS);

  /** 警報機ごとの、いま鳴らすべき周波数の倍率（ドップラー）と音量 */
  private readonly doppler = new Float64Array(POSTS);
  private readonly targets = new Float64Array(POSTS);
  private readonly cutoffs = new Float64Array(POSTS);

  private params: CrossingVoiceParams = SILENT_CROSSING;
  private readonly decays = new Float64Array(MAX_PARTIALS);
  private strikeDecay = 0;
  private readonly dt: number;

  constructor(private readonly sampleRate: number) {
    this.dt = 1 / sampleRate;
    this.body = new CarBodyInsulation(sampleRate);
    for (let p = 0; p < POSTS; p++) {
      // 遠い音源ほど高域が失われる。空気の吸収は距離と周波数の両方で効くので、
      // 遮断周波数を距離で動かす 1 次低域通過で表す。
      this.airAbsorption.push(new OnePoleLowPass(sampleRate, 18000));
      this.gains.push(new Smoothed(sampleRate, 0.03));
    }
    // 2 台は半周期ずれて鳴る
    this.strikePhases[1] = 0.5;
    this.setParams(SILENT_CROSSING);
  }

  setParams(p: CrossingVoiceParams): void {
    this.params = p;
    const partials = p.bell === 'gong' ? GONG_PARTIALS : ELECTRONIC_PARTIALS;
    for (let k = 0; k < MAX_PARTIALS; k++) {
      const tau = partials[k]?.[2] ?? 0.1;
      this.decays[k] = Math.exp(-1 / (this.sampleRate * tau));
    }
    // ハンマーが当たる瞬間の広帯域成分。電鐘式は金属どうしが当たるので目立つ。
    this.strikeDecay = Math.exp(-1 / (this.sampleRate * (p.bell === 'gong' ? 0.012 : 0.005)));

    const half = p.postSpacing / 2;
    for (let post = 0; post < POSTS; post++) {
      // 2 台は踏切道の手前側と向こう側に建っている
      const along = p.distance + (post === 0 ? -half : half);
      const r = Math.hypot(along, p.lateral);
      // 音源へ向かう速度成分。真横（along = 0）で 0 になり、そこを境に符号が変わる。
      const radial = r > 1e-6 ? (p.speed * along) / r : 0;
      this.doppler[post] = 1 + radial / SOUND_SPEED;
      this.targets[post] = (p.level * BELL_LEVEL) / (1 + r / REFERENCE_DISTANCE);
      const cutoff = Math.max(700, 18000 / (1 + r / 25));
      this.cutoffs[post] = cutoff;
      this.airAbsorption[post]!.setCutoff(cutoff);
    }
  }

  /** バッファへ**加算**する */
  render(out: Float32Array): void {
    const p = this.params;
    const partials = p.bell === 'gong' ? GONG_PARTIALS : ELECTRONIC_PARTIALS;
    const base = p.bell === 'gong' ? GONG_BASE : ELECTRONIC_BASE;
    const rate = p.bell === 'gong' ? GONG_RATE : ELECTRONIC_RATE;

    for (let i = 0; i < out.length; i++) {
      let sound = 0;
      for (let post = 0; post < POSTS; post++) {
        const gain = this.gains[post]!.process(this.targets[post]!);

        // 打つ周期。鳴動が止まったら新しく叩かないが、鳴っている余韻は残す。
        this.strikePhases[post]! += rate * this.dt;
        let struck = false;
        if (this.strikePhases[post]! >= 1) {
          this.strikePhases[post]! -= 1;
          struck = p.ringing;
        }

        let unit = 0;
        for (let k = 0; k < partials.length; k++) {
          const index = post * MAX_PARTIALS + k;
          if (struck) {
            this.envelopes[index] = partials[k]![1];
            // 打ち直すたびに位相を揃える（同じハンマーが同じ鐘を叩くので）
            this.phases[index] = 0;
          }
          const env = this.envelopes[index]!;
          if (env < 1e-5) continue;
          const frequency = base * partials[k]![0] * this.doppler[post]!;
          this.phases[index] = wrap(this.phases[index]! + TWO_PI * frequency * this.dt);
          unit += Math.sin(this.phases[index]!) * env;
          this.envelopes[index] = env * this.decays[k]!;
        }

        if (struck) this.strikeEnvelopes[post] = 1;
        const strike = this.strikeEnvelopes[post]!;
        if (strike > 1e-5) {
          unit += this.noise.next() * strike * 0.35;
          this.strikeEnvelopes[post] = strike * this.strikeDecay;
        }

        if (unit === 0 && gain < 1e-6) continue;
        // 遠いほど高域が失われる（遮断周波数は `setParams` で距離から決めてある）。
        // 近づくにつれて音が「開く」のはこれで、音量だけを上げても同じにはならない。
        sound += this.airAbsorption[post]!.process(unit) * gain;
      }
      // 車外で鳴っている音なので、車体を透過したぶんだけが運転台へ入る
      out[i] = out[i]! + this.body.process(sound);
    }
  }

  reset(): void {
    this.body.reset();
    this.envelopes.fill(0);
    this.strikeEnvelopes.fill(0);
    this.phases.fill(0);
    this.strikePhases[0] = 0;
    this.strikePhases[1] = 0.5;
    for (const filter of this.airAbsorption) filter.reset();
    for (const gain of this.gains) gain.set(0);
  }
}

function wrap(theta: number): number {
  const t = theta % TWO_PI;
  return t < 0 ? t + TWO_PI : t;
}
