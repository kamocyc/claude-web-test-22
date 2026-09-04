import { VOICE, VOICE_COUNT } from '../mix.ts';
import { AirSpringVoice, type AirSpringParams } from './airSpring.ts';
import { AuxiliaryVoice, type AuxiliaryParams } from './auxiliary.ts';
import { AlarmVoice, HornVoice, type AlarmParams, type HornParams } from './cab.ts';
import { BrakeVoice, type BrakeParams } from './brake.ts';
import { ChopperVoice, type ChopperVoiceParams } from './chopperVoice.ts';
import { CurveSquealVoice, type CurveSquealParams } from './curveSquealVoice.ts';
import { DoorVoice, type DoorVoiceParams } from './doorVoice.ts';
import { InverterVoice, type InverterVoiceParams } from './inverterVoice.ts';
import { ResistorVoice, type ResistorVoiceParams } from './resistorVoice.ts';
import { BridgeVoice, type BridgeVoiceParams } from './bridgeVoice.ts';
import { CrossingVoice, type CrossingVoiceParams } from './crossingVoice.ts';
import { PassingVoice, type PassingVoiceParams } from './passingVoice.ts';
import { RailJointVoice, type JointImpact } from './railJointVoice.ts';
import { TurnoutVoice, type TurnoutImpact } from './turnoutVoice.ts';
import {
  GearVoice,
  RollingVoice,
  WindVoice,
  type GearParams,
  type RollingParams,
  type WindParams,
} from './runningGear.ts';

/**
 * `TrainNoiseSynth` へ追加で混ぜられる音源。
 *
 * 隣の線路の列車（`RemoteTrainVoice`）がこれにあたる。あちらは中で
 * `TrainNoiseSynth` をもう 1 つ持つので、型が循環しないようここで細く切ってある。
 */
export interface ExtraVoice {
  /** バッファへ**加算**する */
  render(out: Float32Array): void;
  reset(): void;
}

/** 走行音全体を決める量。シミュレーションのスナップショットから素直に写せる。 */
export interface TrainNoiseParams {
  /**
   * 主回路の音は制御方式ごとに別の音源が受け持つ。動いていない方式には無音の
   * パラメータ（`SILENT_INVERTER` など）を渡す — 方式が走行中に変わることは
   * 無いので、鳴らない音源は毎回そのまま素通りする。
   */
  readonly inverter: InverterVoiceParams;
  readonly resistor: ResistorVoiceParams;
  readonly chopper: ChopperVoiceParams;
  readonly gear: GearParams;
  readonly rolling: RollingParams;
  readonly wind: WindParams;
  readonly brake: BrakeParams;
  readonly auxiliary: AuxiliaryParams;
  readonly airSpring: AirSpringParams;
  readonly curveSqueal: CurveSquealParams;
  /** 橋りょう（桁の寸法から出てくる諸元をそのまま渡す） */
  readonly bridge: BridgeVoiceParams;
  /** 踏切の警報音（線路脇に静止した音源として鳴る） */
  readonly crossing: CrossingVoiceParams;
  /** 対向列車とのすれ違い */
  readonly passing: PassingVoiceParams;
  readonly door: DoorVoiceParams;
  readonly alarm: AlarmParams;
  readonly horn: HornParams;
}

/**
 * 走行音の合成全体。
 *
 * すべての音源をここで足し合わせる。Web Audio のノードグラフを組まずに 1 つの
 * ワークレットで完結させているのは、どの音源も**同じシミュレーション状態から
 * 連続的に駆動される**ためで、ノードに分けても配線が増えるだけで得が無い。
 * 唯一の例外はレール継目と分岐器で、これらは離散的な打撃なのでサンプル位置を
 * 指定して予約する形にしてある。
 *
 * このクラスは Web Audio に一切触れないので、node でオフラインレンダして
 * スペクトルや音量の関係を検定できる。
 */
export class TrainNoiseSynth {
  readonly inverter: InverterVoice;
  readonly resistor: ResistorVoice;
  readonly chopper: ChopperVoice;
  readonly gear: GearVoice;
  readonly rolling: RollingVoice;
  readonly wind: WindVoice;
  readonly brake: BrakeVoice;
  readonly auxiliary: AuxiliaryVoice;
  readonly railJoint: RailJointVoice;
  readonly turnout: TurnoutVoice;
  readonly airSpring: AirSpringVoice;
  readonly curveSqueal: CurveSquealVoice;
  readonly bridge: BridgeVoice;
  readonly crossing: CrossingVoice;
  readonly passing: PassingVoice;
  readonly door: DoorVoice;
  readonly alarm: AlarmVoice;
  readonly horn: HornVoice;

  /**
   * ここへ混ぜる外部の音源（隣の線路を走る列車）。
   *
   * 相手の列車の音は**この合成器をもう 1 つ**回して作る（`RemoteTrainVoice`）。
   * その入れ子を型の上で閉じるために、ここでは最小限の形だけを見ている。
   * 飽和の前に混ぜるので、遠くの列車が近づいても全体の音量が破綻しない。
   */
  extra: ExtraVoice | null = null;

  /** 音源ごとの 2 乗和（`readLevels` で実効値に直して読み出す） */
  private readonly squareSum = new Float64Array(VOICE_COUNT);
  private measured = 0;
  private scratch = new Float32Array(0);

  constructor(readonly sampleRate: number) {
    this.inverter = new InverterVoice(sampleRate);
    this.resistor = new ResistorVoice(sampleRate);
    this.chopper = new ChopperVoice(sampleRate);
    this.gear = new GearVoice(sampleRate);
    this.rolling = new RollingVoice(sampleRate);
    this.wind = new WindVoice(sampleRate);
    this.brake = new BrakeVoice(sampleRate);
    this.auxiliary = new AuxiliaryVoice(sampleRate);
    this.railJoint = new RailJointVoice(sampleRate);
    this.turnout = new TurnoutVoice(sampleRate);
    this.airSpring = new AirSpringVoice(sampleRate);
    this.curveSqueal = new CurveSquealVoice(sampleRate);
    this.bridge = new BridgeVoice(sampleRate);
    this.crossing = new CrossingVoice(sampleRate);
    this.passing = new PassingVoice(sampleRate);
    this.door = new DoorVoice(sampleRate);
    this.alarm = new AlarmVoice(sampleRate);
    this.horn = new HornVoice(sampleRate);
  }

  setParams(params: TrainNoiseParams): void {
    this.inverter.setParams(params.inverter);
    this.resistor.setParams(params.resistor);
    this.chopper.setParams(params.chopper);
    this.gear.setParams(params.gear);
    this.rolling.setParams(params.rolling);
    this.wind.setParams(params.wind);
    this.brake.setParams(params.brake);
    this.auxiliary.setParams(params.auxiliary);
    this.airSpring.setParams(params.airSpring);
    this.curveSqueal.setParams(params.curveSqueal);
    this.bridge.setParams(params.bridge);
    this.crossing.setParams(params.crossing);
    this.passing.setParams(params.passing);
    this.door.setParams(params.door);
    this.alarm.setParams(params.alarm);
    this.horn.setParams(params.horn);
  }

  /** 継目の衝撃を予約する（`delay` は次に render するバッファの先頭からのサンプル数） */
  triggerJoint(impact: JointImpact): void {
    this.railJoint.trigger(impact);
  }

  /** 分岐器の衝撃を予約する（同じくサンプル精度） */
  triggerTurnout(impact: TurnoutImpact): void {
    this.turnout.trigger(impact);
  }

  render(out: Float32Array): void {
    // 音源をいったん別のバッファへ出してから足す。混ざったあとでは各音源が
    // どれだけ鳴っているか分からないので、バランスを調整する UI のために
    // ここで 1 つずつ実効値を測っておく。
    if (this.scratch.length !== out.length) this.scratch = new Float32Array(out.length);
    out.fill(0);
    this.mix(out, VOICE.inverter, (b) => this.inverter.render(b));
    this.mix(out, VOICE.resistor, (b) => this.resistor.render(b));
    this.mix(out, VOICE.chopper, (b) => this.chopper.render(b));
    this.mix(out, VOICE.gear, (b) => this.gear.render(b));
    this.mix(out, VOICE.rolling, (b) => this.rolling.render(b));
    this.mix(out, VOICE.wind, (b) => this.wind.render(b));
    this.mix(out, VOICE.brake, (b) => this.brake.render(b));
    this.mix(out, VOICE.auxiliary, (b) => this.auxiliary.render(b));
    this.mix(out, VOICE.railJoint, (b) => this.railJoint.render(b));
    this.mix(out, VOICE.turnout, (b) => this.turnout.render(b));
    this.mix(out, VOICE.airSpring, (b) => this.airSpring.render(b));
    this.mix(out, VOICE.curveSqueal, (b) => this.curveSqueal.render(b));
    this.mix(out, VOICE.bridge, (b) => this.bridge.render(b));
    this.mix(out, VOICE.crossing, (b) => this.crossing.render(b));
    this.mix(out, VOICE.passing, (b) => this.passing.render(b));
    // 隣の線路の列車。すれ違いの圧力波と同じメータに入れる（どちらも「すれ違い」）。
    if (this.extra) this.mix(out, VOICE.passing, (b) => this.extra!.render(b));
    this.mix(out, VOICE.door, (b) => this.door.render(b));
    this.mix(out, VOICE.alarm, (b) => this.alarm.render(b));
    this.mix(out, VOICE.horn, (b) => this.horn.render(b));
    this.measured += out.length;

    // 飽和は最後に 1 回だけ掛ける。音源ごとに掛けると、混ざったときに
    // それぞれが先に潰れて音量の関係が崩れる。
    for (let i = 0; i < out.length; i++) out[i] = Math.tanh(out[i]!);
  }

  private mix(out: Float32Array, voice: number, render: (buffer: Float32Array) => void): void {
    const scratch = this.scratch;
    scratch.fill(0);
    render(scratch);
    let sum = 0;
    for (let i = 0; i < scratch.length; i++) {
      const x = scratch[i]!;
      out[i] = out[i]! + x;
      sum += x * x;
    }
    this.squareSum[voice] = this.squareSum[voice]! + sum;
  }

  /**
   * 前回の呼び出しからの音源ごとの実効値を `out` へ書き、積算をリセットする。
   * 混ざる前の値なので、どの音源がいま支配しているかがそのまま分かる。
   */
  readLevels(out: Float32Array): void {
    const n = this.measured;
    for (let i = 0; i < VOICE_COUNT; i++) {
      out[i] = n > 0 ? Math.sqrt(this.squareSum[i]! / n) : 0;
      this.squareSum[i] = 0;
    }
    this.measured = 0;
  }

  reset(): void {
    this.inverter.reset();
    this.resistor.reset();
    this.chopper.reset();
    this.gear.reset();
    this.rolling.reset();
    this.wind.reset();
    this.brake.reset();
    this.auxiliary.reset();
    this.railJoint.reset();
    this.turnout.reset();
    this.airSpring.reset();
    this.curveSqueal.reset();
    this.bridge.reset();
    this.crossing.reset();
    this.passing.reset();
    this.door.reset();
    this.alarm.reset();
    this.horn.reset();
    this.extra?.reset();
    this.squareSum.fill(0);
    this.measured = 0;
  }
}
