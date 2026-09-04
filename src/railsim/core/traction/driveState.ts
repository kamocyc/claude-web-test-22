import type { Amperes, Hertz, Ohms, RadiansPerSecond, Volts, Watts } from '../units.ts';
import type { InverterState } from './modulation.ts';
import { modulationLabel } from './modulation.ts';

/**
 * 駆動装置の詳細状態（表示・音響用）。
 *
 * `TractionState` が「どれだけの力が出ているか」を持つのに対し、こちらは
 * 「その力をどうやって作っているか」を持つ。走りには一切関与しない。
 *
 * 制御方式ごとに中身はまるで違うが、**回転の量だけはどの方式にも共通**である。
 * 歯車のかみ合い音も軸受の音も主回路が何であろうと同じように鳴るので、共通部分を
 * `DriveRotationState` として切り出し、方式固有の量を判別可能 union で足す。
 * こうしておくと、音と表示の側は「まず回転を読み、必要なときだけ `kind` で分岐する」
 * という書き方ができる。
 */
export interface DriveRotationState {
  /** 電動機の回転角速度 [rad/s]（大きさ） */
  motorAngularVelocity: RadiansPerSecond;
  /** 電動機の回転数 [rpm] */
  motorRpm: number;
  /** 歯車のかみ合い周波数 [Hz] = 電動機回転数/60 × 小歯車の歯数 */
  gearMeshFrequency: Hertz;
  /** 定格に対する電動機トルクの比（正 = 力行、負 = 電気ブレーキ） */
  torqueRatio: number;
}

/**
 * 直流直巻電動機の音に効く回転周波数（抵抗制御・電機子チョッパが共有する）。
 *
 * 3 つとも回転数に次数を掛けただけの量だが、**次数が桁で違う**ので音の性格が
 * まるで違う。この 3 つを別々に持たせているのは、どれか 1 つで電動機を代表させると
 * 音程を取り違えるからである（`packages/audio/src/dsp/dcMotorVoice.ts`）。
 */
export interface DcMotorRotationState extends DriveRotationState {
  /** ブラシが整流子片を渡る周波数 [Hz] = 回転数/60 × 整流子片数 */
  commutatorFrequency: Hertz;
  /** 電機子スロットの通過周波数 [Hz] = 回転数/60 × スロット数（電磁音の主役） */
  slotFrequency: Hertz;
  /** 通風ファンの翼通過周波数 [Hz] = 回転数/60 × 翼数 */
  ventilationFrequency: Hertz;
}

/** 抵抗制御（カム軸進段・直並列切替・弱め界磁）の状態 */
export interface ResistorDriveState extends DcMotorRotationState {
  kind: 'resistor';
  /** 主接触器が入っているか（惰行・切では false） */
  gate: boolean;
  /** 現在の段（`camSteps` の添字） */
  step: number;
  /** 進段表の総段数 */
  stepCount: number;
  /** 1 分岐に直列に入っている電動機の数 */
  motorsInSeries: number;
  /** 並列に並んでいる分岐の数（編成の総電動機数 / motorsInSeries） */
  branches: number;
  /** 1 分岐に残っている起動抵抗 [Ω] */
  resistance: Ohms;
  /** 界磁率（1 = 全界磁） */
  fieldRatio: number;
  /** 電機子電流 [A]（1 台あたり） */
  armatureCurrent: Amperes;
  /** 電動機 1 台あたりの端子電圧 [V] */
  armatureVoltage: Volts;
  /** 逆起電力 [V]（1 台あたり） */
  backEmf: Volts;
  /** 起動抵抗で熱にしている電力 [W]（編成合計）。全短絡した段では 0 になる。 */
  resistorPower: Watts;
  /** 直並列の組替え（渡り）の最中か。このあいだトルクは出ない。 */
  transitioning: boolean;
  /** 発電ブレーキとして動作中か */
  dynamicBraking: boolean;
  /**
   * カム軸が進段した回数（単調増加）。
   * 音は「いま何段目か」ではなく「進んだ瞬間」に鳴るので、状態ではなくカウンタで
   * 渡す。受け手は増分を見て撃力を鳴らす。
   */
  stepEvents: number;
  /** 直並列の組替えが起きた回数（単調増加）。進段より重い音になる。 */
  groupEvents: number;
}

/** 電機子チョッパ制御の状態 */
export interface ChopperDriveState extends DcMotorRotationState {
  kind: 'chopper';
  /** チョッパが動作しているか（惰行では false） */
  gate: boolean;
  /** 通流率 0..1 */
  duty: number;
  /** チョッパ周波数 [Hz] */
  chopFrequency: Hertz;
  /** 界磁率（1 = 全界磁） */
  fieldRatio: number;
  /** 電機子電流 [A]（1 台あたり・平均値） */
  armatureCurrent: Amperes;
  /** 電機子電流のリップル [A]（p-p）。通流率 0.5 で最大、全通流で 0。 */
  currentRipple: Amperes;
  /** 電動機 1 台あたりの端子電圧 [V] */
  armatureVoltage: Volts;
  /** 逆起電力 [V]（1 台あたり） */
  backEmf: Volts;
  /** 回生ブレーキとして動作中か */
  regenerating: boolean;
}

/** 動力装置を持たない編成の状態（回転量だけ） */
export interface IdleDriveState extends DriveRotationState {
  kind: 'none';
}

/** 駆動装置の状態（制御方式ごとの判別可能 union） */
export type DriveState = InverterState | ResistorDriveState | ChopperDriveState | IdleDriveState;

export function createIdleDriveState(): IdleDriveState {
  return {
    kind: 'none',
    motorAngularVelocity: 0,
    motorRpm: 0,
    gearMeshFrequency: 0,
    torqueRatio: 0,
  };
}

export function createResistorDriveState(): ResistorDriveState {
  return {
    kind: 'resistor',
    motorAngularVelocity: 0,
    motorRpm: 0,
    gearMeshFrequency: 0,
    torqueRatio: 0,
    gate: false,
    step: 0,
    stepCount: 0,
    motorsInSeries: 1,
    branches: 1,
    resistance: 0,
    fieldRatio: 1,
    armatureCurrent: 0,
    armatureVoltage: 0,
    backEmf: 0,
    commutatorFrequency: 0,
    slotFrequency: 0,
    ventilationFrequency: 0,
    resistorPower: 0,
    transitioning: false,
    dynamicBraking: false,
    stepEvents: 0,
    groupEvents: 0,
  };
}

export function createChopperDriveState(chopFrequency: Hertz = 0): ChopperDriveState {
  return {
    kind: 'chopper',
    motorAngularVelocity: 0,
    motorRpm: 0,
    gearMeshFrequency: 0,
    torqueRatio: 0,
    gate: false,
    duty: 0,
    chopFrequency,
    fieldRatio: 1,
    armatureCurrent: 0,
    currentRipple: 0,
    armatureVoltage: 0,
    backEmf: 0,
    commutatorFrequency: 0,
    slotFrequency: 0,
    ventilationFrequency: 0,
    regenerating: false,
  };
}

/**
 * 抵抗制御のつなぎ方の表示名。
 *
 * 「何台直列か」だけでは決まらない。4 台の車なら 2 台直列は直並列だが、
 * MM' ユニット 8 台なら 4 台直列がそれにあたる。分岐が 1 本なら全直列、
 * 電動機が 1 台ずつ並んでいれば全並列、その中間が直並列である。
 */
export function groupingLabel(motorsInSeries: number, branches: number): string {
  if (branches <= 1) return '直列';
  if (motorsInSeries <= 1) return '並列';
  return '直並列';
}

/** 抵抗制御の状態の表示名（例: `直列 5/19 段`、`並列 16/19 段 界磁 60%`） */
export function resistorLabel(state: ResistorDriveState): string {
  if (state.dynamicBraking) return `発電制動 ${state.armatureCurrent.toFixed(0)}A`;
  if (state.transitioning) return '渡り';
  if (!state.gate) return '切';
  const grouping = groupingLabel(state.motorsInSeries, state.branches);
  const steps = `${state.step + 1}/${state.stepCount} 段`;
  if (state.fieldRatio >= 1) return `${grouping} ${steps}`;
  return `${grouping} ${steps} 界磁 ${(state.fieldRatio * 100).toFixed(0)}%`;
}

/** 電機子チョッパの状態の表示名（例: `通流率 62% (400Hz)`） */
export function chopperLabel(state: ChopperDriveState): string {
  if (!state.gate) return '切';
  const head = state.regenerating ? '回生 ' : '';
  const duty =
    state.duty >= 0.995
      ? '全通流'
      : `通流率 ${(state.duty * 100).toFixed(0)}% (${state.chopFrequency.toFixed(0)}Hz)`;
  if (state.fieldRatio >= 1) return `${head}${duty}`;
  return `${head}${duty} 界磁 ${(state.fieldRatio * 100).toFixed(0)}%`;
}

/** 駆動装置の状態の表示名（方式によらず使える） */
export function driveLabel(state: DriveState): string {
  switch (state.kind) {
    case 'vvvf':
      return modulationLabel(state);
    case 'resistor':
      return resistorLabel(state);
    case 'chopper':
      return chopperLabel(state);
    case 'none':
      return '—';
  }
}

/** HUD の 1 行目の見出し */
export function driveRowLabel(state: DriveState): string {
  return state.kind === 'vvvf' ? '変調' : '制御';
}

/** HUD の 2 行目の見出し */
export function driveDetailRowLabel(state: DriveState): string {
  return state.kind === 'vvvf' ? '出力 / すべり' : '電流 / 電圧';
}

/**
 * HUD の 2 行目。方式ごとに「いま主回路で何が起きているか」を数値で出す。
 * VVVF は周波数、直流機は電流と電圧 — どちらもその方式で音を決めている量である。
 */
export function driveDetail(state: DriveState): string {
  const rpm = `（${state.motorRpm.toFixed(0)} rpm）`;
  switch (state.kind) {
    case 'vvvf':
      return state.mode === 'off'
        ? `— / — ${rpm}`
        : `${state.fundamentalFrequency.toFixed(1)} / ${state.slipFrequency.toFixed(2)} Hz${rpm}`;
    case 'resistor':
    case 'chopper':
      return state.armatureCurrent <= 0
        ? `— / — ${rpm}`
        : `${state.armatureCurrent.toFixed(0)} A / ${state.armatureVoltage.toFixed(0)} V${rpm}`;
    case 'none':
      return `— / — ${rpm}`;
  }
}
