/**
 * 音源ごとの音量バランス。
 *
 * 合成そのものには要らない量で、**聴き手の側の設定**である。物理から決まる
 * 音量（速度・圧力・距離減衰）は各音源が自分で計算しており、ここはその上に
 * 掛かる係数にすぎない。合成器ではなく `TrainAudio` 側で掛けているのはこのため
 * （合成器は「装置がどう鳴るか」だけを担う）。
 *
 * 1.0 が既定で、既定値そのものは実測して決めてある（`README.md` の音響の節）。
 */
export interface NoiseMix {
  /** 全体 0..1 */
  readonly master: number;
  /** インバータ・主電動機（VVVF 車） */
  readonly inverter: number;
  /** 主電動機・起動抵抗・カム軸の進段（抵抗制御車） */
  readonly resistor: number;
  /** チョッパ・主電動機（電機子チョッパ車） */
  readonly chopper: number;
  /** 歯車のかみ合い（M 車の床下） */
  readonly gear: number;
  /** 転動音（全車の足元） */
  readonly rolling: number;
  /** 風切り音（高速でだけ効く） */
  readonly wind: number;
  /**
   * レール継目。
   *
   * 継目は線路の側にあるものなので、**自列車の軸が踏んだ音も、隣の線路の対向列車が
   * 踏んだ音も同じ音源**から出る（違うのは距離と伝わり方だけ）。
   */
  readonly railJoint: number;
  /** 分岐器（トングレール・クロッシング） */
  readonly turnout: number;
  /** 橋りょう（桁の放射と反射） */
  readonly bridge: number;
  /** 踏切の警報音 */
  readonly crossing: number;
  /**
   * 対向列車（と前方のダイヤ列車）。
   *
   * 相手の列車は自列車とまったく同じ合成器で鳴っているので、これは**相手の列車の
   * 音全体**に掛かるつまみになる（主回路も歯車も転動音も継目も扉も）。音源ごとの
   * つまみ（`inverter` や `railJoint`）はその内側で先に効く。すれ違いざまの圧力波も
   * ここに入る。
   */
  readonly passing: number;
  /** ブレーキ（摩擦・鳴き・空気） */
  readonly brake: number;
  /** 補機（空気圧縮機） */
  readonly auxiliary: number;
  /** 空気ばねのきしみ */
  readonly airSpring: number;
  /** 曲線・分岐器での車輪の軋み音 */
  readonly curveSqueal: number;
  /** 客用扉（チャイム・空気・戸当たり） */
  readonly door: number;
  /** 保安装置の報知音（打鈴・チャイム・ブザー） */
  readonly alarm: number;
  /** 警笛 */
  readonly horn: number;
  /**
   * インバータ音がトルクにどれだけ追従するか 0..1。
   *
   * V/f 一定制御では磁束が保たれるので、**実機の磁気音は負荷でそれほど変わらない**。
   * 0 にすればゲートが開いているあいだ一定になり、1 にすればノッチに比例して
   * 大きくなる。惰行ではゲートが閉じるのでいずれにせよ音は消える。
   */
  readonly inverterLoadTracking: number;
  /**
   * 歯車の音がトルクにどれだけ追従するか 0..1。
   *
   * 言い換えれば「惰行しているとき、歯車が全負荷の何割を受け持っていると見なすか」
   * の裏返しである。惰行でも回転部の慣性トルクが歯面に掛かるので、かみ合いの
   * 加振が消えることはない。1 にすると惰行で歯車の音がほぼ落ちきり、0 にすると
   * 力行と惰行で同じ音量になる。
   */
  readonly gearLoadTracking: number;
}

export const DEFAULT_NOISE_MIX: NoiseMix = {
  master: 0.7,
  inverter: 1,
  resistor: 1,
  chopper: 1,
  gear: 1,
  rolling: 1,
  wind: 1,
  railJoint: 1,
  turnout: 1,
  bridge: 1,
  crossing: 1,
  passing: 1,
  brake: 1,
  auxiliary: 1,
  airSpring: 1,
  curveSqueal: 1,
  door: 1,
  alarm: 1,
  horn: 1,
  inverterLoadTracking: 0.3,
  gearLoadTracking: 0.6,
};

/** 音量バランスの調整 UI を組み立てるための項目定義 */
export interface NoiseMixControl {
  readonly key: keyof NoiseMix;
  readonly label: string;
  /** レベルメータに対応する音源の番号（無ければメータを出さない） */
  readonly voice?: VoiceIndex;
}

/**
 * `TrainNoiseSynth` が実効値を測る音源の番号。
 * ミキサのメータはこの順に並ぶ。
 */
export const VOICE = {
  inverter: 0,
  gear: 1,
  rolling: 2,
  wind: 3,
  railJoint: 4,
  turnout: 5,
  brake: 6,
  auxiliary: 7,
  airSpring: 8,
  alarm: 9,
  horn: 10,
  resistor: 11,
  chopper: 12,
  door: 13,
  curveSqueal: 14,
  bridge: 15,
  crossing: 16,
  passing: 17,
} as const;

export type VoiceIndex = (typeof VOICE)[keyof typeof VOICE];

/** 音源の数（メータの配列長） */
export const VOICE_COUNT = 18;

/** 音量のつまみ */
export const NOISE_MIX_LEVELS: readonly NoiseMixControl[] = [
  { key: 'master', label: 'マスター' },
  { key: 'inverter', label: 'インバータ・主電動機', voice: VOICE.inverter },
  { key: 'resistor', label: '主電動機・起動抵抗・進段', voice: VOICE.resistor },
  { key: 'chopper', label: 'チョッパ・主電動機', voice: VOICE.chopper },
  { key: 'gear', label: '歯車', voice: VOICE.gear },
  { key: 'rolling', label: '転動音', voice: VOICE.rolling },
  { key: 'wind', label: '風切り', voice: VOICE.wind },
  { key: 'railJoint', label: 'レール継目', voice: VOICE.railJoint },
  { key: 'turnout', label: '分岐器', voice: VOICE.turnout },
  { key: 'bridge', label: '橋りょう', voice: VOICE.bridge },
  { key: 'crossing', label: '踏切の警報音', voice: VOICE.crossing },
  { key: 'passing', label: '対向列車のすれ違い', voice: VOICE.passing },
  { key: 'brake', label: 'ブレーキ', voice: VOICE.brake },
  { key: 'auxiliary', label: '補機（空気圧縮機）', voice: VOICE.auxiliary },
  { key: 'airSpring', label: '空気ばねのきしみ', voice: VOICE.airSpring },
  { key: 'curveSqueal', label: '曲線の軋み音', voice: VOICE.curveSqueal },
  { key: 'door', label: '客用扉・ドアチャイム', voice: VOICE.door },
  { key: 'alarm', label: '保安装置の報知音', voice: VOICE.alarm },
  { key: 'horn', label: '警笛', voice: VOICE.horn },
];

/** 力行と惰行の差を決めるつまみ */
export const NOISE_MIX_TRACKING: readonly NoiseMixControl[] = [
  { key: 'inverterLoadTracking', label: 'インバータの負荷追従' },
  { key: 'gearLoadTracking', label: '歯車の負荷追従' },
];
