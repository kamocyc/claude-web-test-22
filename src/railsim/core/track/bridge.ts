import { SpanTable } from '../math/table.ts';
import type { Hertz, Meters } from '../units.ts';

/**
 * 橋りょう。
 *
 * 橋の上を走ると音が変わるのは「橋だから」ではなく、**車輪とレールが叩いた力の
 * 逃げ場が変わるから**である。土路盤の上では加振力は道床と路盤へ吸われて熱になるが、
 * 橋の上ではそれが桁という薄い鋼板の集まりへ入り、板が面外に振動して空気へ音を放つ。
 * したがって橋の音を決めるのは 2 つだけで、
 *
 *  1. **加振力が桁へどれだけ届くか** — 道床が間に入るか（有道床）、レールが直接
 *     桁に締結されているか（無道床）で 1 桁変わる
 *  2. **桁が音をどれだけ出せるか** — 板の厚さ・大きさで決まる曲げ振動の周波数と、
 *     その周波数での放射効率
 *
 * この 2 つを構造の寸法から出しているので、橋の種類ごとに音を作り分けているのでは
 * なく、寸法を変えた結果として音が変わる。
 */

/** 桁の形式 */
export type BridgeKind =
  /** 上路プレートガーダー（腹板と上下フランジの I 桁） */
  | 'plate-girder'
  /** トラス（下路。細長い部材で組んだ構造の中を列車が通る） */
  | 'truss'
  /** コンクリート桁（PC 桁・RC ラーメン） */
  | 'concrete';

/**
 * 床（軌道の受け方）。
 *
 * - `open`（無道床）— 橋まくらぎを主桁へ直接締結する。道床が無いので加振力が
 *   そのまま桁へ入り、鋼橋ではいちばん大きな音が出る。
 * - `ballasted`（有道床）— 床版の上に通常の道床を敷く。砕石の内部摩擦が加振力を
 *   食うため、桁へ届く力は 1 桁小さくなる。
 */
export type BridgeDeck = 'open' | 'ballasted';

/**
 * 音を出す板 1 枚の寸法。
 *
 * 桁は 1 枚の大きな板ではなく、補剛材や横リブで区切られた区画の集まりで、
 * 振動の単位はその 1 区画である。どの部材が音を出しているかは形式で違う:
 *
 * | 形式               | 音を出す板             | 厚さ  | 1 区画の大きさ |
 * | ------------------ | ---------------------- | ----- | -------------- |
 * | プレートガーダー   | 主桁の腹板             | 12mm  | 桁高 × 補剛材間隔 |
 * | トラス             | 床組（縦桁）の腹板     | 9mm   | 縦桁高 × 横桁間隔 |
 * | コンクリート桁     | 床版                   | 250mm | 版の幅 × 支間 |
 */
export interface BridgePanel {
  /** 板厚 [m] */
  readonly thickness: Meters;
  /** 1 区画の高さ（短辺）[m] */
  readonly height: Meters;
  /** 1 区画の幅（長辺）[m] */
  readonly width: Meters;
}

/** 橋りょう（コンパイル済み） */
export interface Bridge {
  readonly id: string;
  readonly name: string;
  /** 橋りょうの始端（橋台の前面）の距離程 [m] */
  readonly start: Meters;
  /** 橋りょうの終端の距離程 [m] */
  readonly end: Meters;
  readonly kind: BridgeKind;
  readonly deck: BridgeDeck;
  /** 径間長 [m]（支間。橋脚から橋脚まで） */
  readonly spanLength: Meters;
  /** 主構・主桁の高さ [m] */
  readonly girderDepth: Meters;
  /** 音を出す板 1 枚の寸法 */
  readonly panel: BridgePanel;
  /** まくらぎの間隔 [m]（無道床橋の橋まくらぎは本線の並みより密） */
  readonly sleeperSpacing: Meters;
}

/** 橋の長さ [m] */
export const bridgeLength = (bridge: Bridge): Meters => bridge.end - bridge.start;

/** 鋼のヤング率 [Pa]・密度 [kg/m³]・ポアソン比 */
const STEEL_E = 2.06e11;
const STEEL_DENSITY = 7850;
const STEEL_POISSON = 0.3;

/** コンクリートの同じ諸元 */
const CONCRETE_E = 3.0e10;
const CONCRETE_DENSITY = 2400;
const CONCRETE_POISSON = 0.2;

/** 空気中の音速 [m/s] */
const SOUND_SPEED = 343;

/**
 * 板の縦波速度 [m/s]。曲げ振動の周波数も臨界周波数もこれで決まる。
 *
 *   c_L = sqrt(E / (ρ (1 − ν²)))
 *
 * 鋼で約 5400 m/s、コンクリートで約 3600 m/s。
 */
function plateWaveSpeed(e: number, density: number, poisson: number): number {
  return Math.sqrt(e / (density * (1 - poisson * poisson)));
}

/**
 * 四辺支持の長方形板の面外振動の固有周波数 [Hz]。
 *
 *   f_mn = (π/2) sqrt(D / (ρ t)) ((m/a)² + (n/b)²),  D = E t³ / (12 (1 − ν²))
 *
 * 根号の中は `t c_L / √12` にまとまるので、**周波数は板厚に比例し、板の寸法の
 * 2 乗に反比例する**。厚い板ほど、小さい板ほど高い音になる — プレートガーダーの
 * 大きな腹板が「ゴー」と低く鳴り、トラスの細い縦桁が「ガーン」と甲高く鳴る違いは
 * この 1 本の式から出る。
 */
function plateMode(
  thickness: number,
  a: Meters,
  b: Meters,
  m: number,
  n: number,
  speed: number,
): Hertz {
  const stiffness = (thickness * speed) / Math.sqrt(12);
  return (Math.PI / 2) * stiffness * ((m / a) ** 2 + (n / b) ** 2);
}

/**
 * 板の臨界周波数 [Hz]。
 *
 *   f_c = c² / (1.8 c_L t)
 *
 * 曲げ波の伝わる速さが空気中の音速に追いつく周波数で、これを境に板の放射効率が
 * 変わる。下では板の上を進む曲げ波が空気を押しても隣で引き戻してしまい（近接場で
 * 打ち消し合う）、放射できるのは板の縁と角だけになる。板厚 12mm の鋼板で約 1kHz、
 * つまり橋の音の帯域はまるごと臨界周波数より下にある。
 */
function criticalFrequency(thickness: number, speed: number): Hertz {
  return (SOUND_SPEED * SOUND_SPEED) / (1.8 * speed * thickness);
}

/**
 * 板の駆動点モビリティ [m/s per N]。
 *
 *   Y = 1 / (8 √(D ρt)) = √12 / (8 ρ c_L t²)
 *
 * 「同じ力で叩いたとき、その板がどれだけ速く動くか」であり、**板厚の 2 乗に
 * 反比例する**。橋の音の大小はほとんどこれで決まる: 板厚 12mm の鋼板と
 * 厚さ 250mm のコンクリート床版では 2 桁近い差になり、これがコンクリート橋が
 * 静かないちばんの理由である（減衰でも道床でもなく、そもそも動かない）。
 */
function plateMobility(thickness: number, density: number, speed: number): number {
  return Math.sqrt(12) / (8 * density * speed * thickness * thickness);
}

/** 音として出てくる橋の諸元 */
export interface BridgeAcoustics {
  /** 卓越する板の曲げモードの周波数 [Hz]（低い順に 3 つ） */
  readonly modes: readonly [Hertz, Hertz, Hertz];
  /** モードごとの重み（臨界周波数より下での放射効率） */
  readonly weights: readonly [number, number, number];
  /** 減衰比（鋼は小さく長く鳴る。コンクリートと道床は大きく、すぐ止まる） */
  readonly damping: number;
  /**
   * 桁が音を出す強さ。無道床のプレートガーダー橋を 1 とする。
   * 道床による力の減衰・板のモビリティ・板の面積を掛け合わせたもの。
   */
  readonly radiation: number;
  /**
   * 橋の構造が走行音を跳ね返す強さ 0..1。
   *
   * 桁が鳴らなくても橋の上では音が変わる。土路盤の上では地面が音を吸うが、
   * 橋には吸うものが無く、代わりに桁・高欄・（下路橋なら）主構が反射面になる。
   * 有道床のコンクリート橋で聞こえる小さな変化はほとんどこれである。
   */
  readonly reflection: number;
}

/**
 * 道床が加振力を桁へ伝える割合。
 *
 * 砕石の層は、まくらぎからの力を面へ広げながら内部摩擦で減らす。実測では有道床橋の
 * 騒音は同じ桁の無道床橋より 10〜15dB 低い。そのうち力の減り（ここ）が大部分で、
 * 残りは道床が桁の振動を食うことによる減衰の増加（`BALLAST_DAMPING`）が受け持つ。
 */
const BALLAST_TRANSMISSION = 0.35;

/**
 * 放射の強さを 1 に正規化する基準。
 * 支間 30m の上路プレートガーダー橋（腹板厚 12mm・桁高 2.5m・補剛材間隔 1.75m）を採る。
 * 無道床鋼橋の中でもっとも普通の形で、「橋を渡る音」といえばこれである。
 */
const REFERENCE_MOBILITY = plateMobility(
  0.012,
  STEEL_DENSITY,
  plateWaveSpeed(STEEL_E, STEEL_DENSITY, STEEL_POISSON),
);
const REFERENCE_PANEL_AREA = 2.5 * 1.75;

/** 桁の材料ごとの減衰比。鋼は溶接構造でごく小さく、コンクリートはその数倍。 */
const STEEL_DAMPING = 0.004;
const CONCRETE_DAMPING = 0.016;
/** 道床が乗ると桁の振動もそこへ食われるので、見かけの減衰が増える */
const BALLAST_DAMPING = 0.008;

/**
 * 橋の音を決める諸元を、桁の寸法から求める。
 *
 * ここで作り分けているのは「橋の種類」ではなく板の寸法である。同じ
 * プレートガーダーでも有道床にすれば静かになり、コンクリート桁でも無道床に
 * すればよく鳴る — 実物でもそうなる。
 */
export function bridgeAcoustics(bridge: Bridge): BridgeAcoustics {
  const concrete = bridge.kind === 'concrete';
  const speed = concrete
    ? plateWaveSpeed(CONCRETE_E, CONCRETE_DENSITY, CONCRETE_POISSON)
    : plateWaveSpeed(STEEL_E, STEEL_DENSITY, STEEL_POISSON);
  const a = bridge.panel.height;
  const b = bridge.panel.width;
  const t = bridge.panel.thickness;

  // 低次のモードは板全体が同じ向きに動くので、空気を押しては隣で引き戻す
  // （体積速度が打ち消し合う）。実際に音になるのは (2,2) から上あたりで、
  // 板の大きさによって帯域が決まる。
  const modes: [Hertz, Hertz, Hertz] = [
    plateMode(t, a, b, 2, 2, speed),
    plateMode(t, a, b, 3, 3, speed),
    plateMode(t, a, b, 4, 4, speed),
  ];

  // 臨界周波数より下では、放射できるのは板の縁と角だけになる。効率は周波数の
  // 平方根におよそ比例して上がる（縁の放射は √(f/f_c) で効く）ので、高いモードほど
  // 音になりやすい — 薄く小さい板の橋が甲高くうるさいのはこのためである。
  const fc = criticalFrequency(t, speed);
  const efficiency = (f: Hertz): number => Math.min(1, Math.sqrt(f / fc));
  const weights: [number, number, number] = [
    efficiency(modes[0]),
    efficiency(modes[1]),
    efficiency(modes[2]),
  ];

  const damping =
    (concrete ? CONCRETE_DAMPING : STEEL_DAMPING) +
    (bridge.deck === 'ballasted' ? BALLAST_DAMPING : 0);

  // 放射の強さ = 力がどれだけ桁へ届くか × その力で板がどれだけ動くか × 板の広さ。
  // 振幅は放射面積の平方根で効く（放射パワーが面積に比例するため）。
  const mobility = concrete
    ? plateMobility(t, CONCRETE_DENSITY, speed)
    : plateMobility(t, STEEL_DENSITY, speed);
  const transmission = bridge.deck === 'ballasted' ? BALLAST_TRANSMISSION : 1;
  const area = a * b;
  const radiation =
    transmission * (mobility / REFERENCE_MOBILITY) * Math.sqrt(area / REFERENCE_PANEL_AREA);

  return {
    modes,
    weights,
    damping,
    radiation,
    // 下路トラスは主構とその上の横構が列車を囲むので、よく跳ね返る。
    // 上路桁は下にあるだけなので、反射するのは足元と高欄だけになる。
    reflection: bridge.kind === 'truss' ? 0.65 : 0.22,
  };
}

/**
 * 路線上の橋りょうの集まり。
 *
 * 区間として持つのはトンネルと同じで、「いま何両目が橋の上にいるか」を数えられる
 * ようにするためである。橋の音は列車が桁へ乗った瞬間に始まり、最後部が橋台を
 * 抜けた瞬間に終わる — 途中で滑らかに変わるのではなく、桁に乗っている軸の数で
 * 決まる。
 */
export class BridgeTrack {
  readonly bridges: readonly Bridge[];
  private readonly spans: SpanTable<Bridge>;

  constructor(bridges: readonly Bridge[]) {
    this.bridges = [...bridges].sort((a, b) => a.start - b.start);
    this.spans = new SpanTable(this.bridges.map((b) => ({ start: b.start, end: b.end, value: b })));
  }

  get length(): number {
    return this.bridges.length;
  }

  /** 距離程 s を含む橋（無ければ undefined） */
  at(s: Meters): Bridge | undefined {
    return this.spans.at(s)[0]?.value;
  }

  /** 区間 [a, b) に掛かる橋 */
  overlapping(a: Meters, b: Meters): readonly Bridge[] {
    return this.spans.overlapping(a, b).map((sp) => sp.value);
  }
}

/** 橋りょうを持たない路線用の空のテーブル */
export const NO_BRIDGES = new BridgeTrack([]);
