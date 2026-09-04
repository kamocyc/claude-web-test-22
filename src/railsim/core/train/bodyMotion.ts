import { GRAVITY, type Meters, type Radians } from '../units.ts';
import type { PassengerSpec, SuspensionSpec } from '../vehicle/spec.ts';
import { PassengerModel, createPassengerState, type PassengerState } from './passenger.ts';

/**
 * 2 次系（ばね・質量・ダンパ）の 1 自由度。
 *
 *   ẍ = ω²(x_target − x) − 2ζω ẋ,   ω = 2πf
 *
 * 車体の動揺は、台車のばねに支えられた車体が固有振動数まわりで揺れる現象なので、
 * 「目標値へ向かって固有振動数と減衰比で追従する」この形で表せる。
 * 目標値には準静的なつり合い位置（横加速度によるロールなど）と
 * 軌道狂いによる強制変位の両方を入れる。
 */
export class Oscillator {
  value = 0;
  rate = 0;
  /** 直近の加速度（体感加速度の算出に使う） */
  acceleration = 0;

  step(dt: number, target: number, frequency: number, damping: number): number {
    const w = 2 * Math.PI * frequency;
    const acc = w * w * (target - this.value) - 2 * damping * w * this.rate;
    this.acceleration = acc;
    // 半陰的オイラー: 速度を更新してから位置を進める
    this.rate += acc * dt;
    this.value += this.rate * dt;
    return this.value;
  }

  reset(value = 0): void {
    this.value = value;
    this.rate = 0;
    this.acceleration = 0;
  }
}

/** 車体の動揺の状態 */
export interface BodyMotionState {
  /** 軌道面に対するロール角 [rad]（正 = 進行方向に対して右下がり） */
  roll: Radians;
  /**
   * カントによる軌道面自体の傾き [rad]（正 = 右下がり）。
   * `Alignment.cantAngleAt()` は外軌が高いほど正なので、その符号を反転した値になる。
   */
  trackRoll: Radians;
  /** 水平面に対する車体の総ロール角 [rad] = `trackRoll + roll` */
  absoluteRoll: Radians;
  /** 軌道面に対するピッチ角 [rad]（正 = 前下がり＝ノーズダイブ） */
  pitch: Radians;
  /**
   * 勾配による床自体の傾き [rad]（正 = 前下がり＝下り勾配）。
   * 勾配角は上りが正なので、その符号を反転した値になる。
   */
  trackPitch: Radians;
  /** 水平面に対する車体の総ピッチ角 [rad] = `trackPitch + pitch` */
  absolutePitch: Radians;
  /** ヨー角 [rad]（正 = 左向き） */
  yaw: Radians;
  /** 左右変位 [m]（正 = 右） */
  lateral: Meters;
  /** 上下変位 [m]（正 = 上） */
  vertical: Meters;
  /** ロール角速度 [rad/s] */
  rollRate: number;
  /** 上下速度 [m/s]（空気ばねが伸縮する速さ） */
  verticalRate: number;
  /** ロールの角加速度 [rad/s^2]（吊り革の支点が振られる量） */
  rollAcceleration: number;
  /** ピッチの角加速度 [rad/s^2] */
  pitchAcceleration: number;
  /**
   * 乗客が感じる左右方向の比力 [m/s^2]（正 = 右へ押される）。
   * 水平面での比力を、カントと車体ロールで傾いた床の座標系へ射影したもの。
   */
  feltLateral: number;
  /**
   * 乗客が感じる前後方向の比力 [m/s^2]（正 = 前へ押される＝制動中）。
   * 加速度だけでなく、勾配で傾いた床に沿う重力成分も含む。
   */
  feltLongitudinal: number;
  /** 乗客が感じる上下方向の比力 [m/s^2]（正 = 上向き。1G = 通常） */
  feltVertical: number;
  /**
   * 車内の乗客。吊り革は比力に遅れて追従する振り子、立っている乗客は
   * むだ時間を持つ姿勢制御つきの倒立振子として解く。
   */
  passenger: PassengerState;
}

export function createBodyMotionState(): BodyMotionState {
  return {
    roll: 0,
    trackRoll: 0,
    absoluteRoll: 0,
    pitch: 0,
    trackPitch: 0,
    absolutePitch: 0,
    yaw: 0,
    lateral: 0,
    vertical: 0,
    rollRate: 0,
    verticalRate: 0,
    rollAcceleration: 0,
    pitchAcceleration: 0,
    feltLateral: 0,
    feltLongitudinal: 0,
    feltVertical: GRAVITY,
    passenger: createPassengerState(),
  };
}

export interface BodyMotionInput {
  /** 軌道面の非平衡横加速度 [m/s^2]（正 = 曲線外側へ押される向き） */
  readonly unbalancedLateral: number;
  /**
   * カント角 [rad]（外軌が高いほど正）。軌道面自体の傾きになる。
   * 水平面内の求心加速度は `unbalancedLateral` とこの角から復元するので、
   * 両者に食い違う値を渡してしまう余地はない。
   */
  readonly cantAngle: Radians;
  /** 車体の前後加速度 [m/s^2]（正 = 加速） */
  readonly longitudinalAcceleration: number;
  /**
   * 勾配角 [rad]（正 = 上り）。床が傾くぶんの重力成分が前後の比力に入る。
   * これが無いと、下り勾配を惰行しているだけで「後ろへ押される」と出てしまう。
   */
  readonly gradeAngle: Radians;
  /** 前台車位置の高低狂い [m] */
  readonly frontVertical: Meters;
  /** 後台車位置の高低狂い [m] */
  readonly rearVertical: Meters;
  /** 前台車位置の通り狂い [m] */
  readonly frontLateral: Meters;
  /** 後台車位置の通り狂い [m] */
  readonly rearLateral: Meters;
  /** 水準狂い [m]（左右レールの高さ差） */
  readonly crossLevel: Meters;
  /** 台車中心間距離 [m] */
  readonly bogieSpacing: Meters;
  /** 軌間 [m] */
  readonly gauge: Meters;
}

/**
 * 車体の動揺（ロール・ピッチ・ヨー・左右・上下）。
 *
 * 揺れの原因を 2 種類に分けて扱う:
 *
 *  1. **加減速と曲線通過による準静的な傾き**
 *     - 曲線でカント不足があると、車体は空気ばねの柔らかさに応じて外側へロールする。
 *       この傾きぶんだけ重力の横方向成分が増えるため、乗客が感じる横 G は
 *       軌道面の値より大きくなる（これが車体傾斜制御が必要になる理由）。
 *     - 力行・制動では前後加速度に応じて車体がピッチングする（ノーズダイブ／スクォート）。
 *
 *  2. **軌道狂いによる強制振動**
 *     水準狂いはロールを、高低狂いは上下動とピッチングを、通り狂いは左右動とヨーイングを
 *     励振する。軌道狂いは距離程の関数なので、同じ場所では常に同じ揺れ方になる。
 *
 * 各自由度は固有振動数と減衰比を持つ 2 次系として積分する。実車の車体固有振動数は
 * ロール 0.7〜1.2Hz、上下 1.0〜1.5Hz 程度であり、この帯域の揺れが乗り心地を支配する。
 */
export class CarBodyMotion {
  readonly state = createBodyMotionState();
  private readonly rollOsc = new Oscillator();
  private readonly pitchOsc = new Oscillator();
  private readonly yawOsc = new Oscillator();
  private readonly swayOsc = new Oscillator();
  private readonly bounceOsc = new Oscillator();
  private readonly passenger: PassengerModel;

  constructor(
    private readonly spec: SuspensionSpec,
    passenger: PassengerSpec,
  ) {
    this.passenger = new PassengerModel(passenger);
  }

  step(dt: number, input: BodyMotionInput): BodyMotionState {
    const s = this.spec;

    // --- 準静的なつり合い ---
    // 軌道面で乗客が感じる横方向の比力（正 = 右）。車体はこの向きへロールする。
    const trackPlaneLateral = input.unbalancedLateral;
    // 車体傾斜率（フレキシビリティ係数）ぶんだけ、つり合い角より余分に傾く
    const rollFromLateral = s.rollFlexibility * Math.atan2(trackPlaneLateral, GRAVITY);
    // 水準狂いは軌道そのものの傾きとしてそのまま車体を傾ける
    const rollFromTrack = input.gauge > 0 ? Math.asin(clamp1(input.crossLevel / input.gauge)) : 0;
    const rollTarget = rollFromLateral + rollFromTrack;

    // 前後加速度によるピッチング（加速時は前上がり＝負のピッチ）
    const pitchFromAccel = -s.pitchGain * input.longitudinalAcceleration;
    // 前後台車の高低差による強制ピッチ
    const pitchFromTrack =
      input.bogieSpacing > 0 ? (input.rearVertical - input.frontVertical) / input.bogieSpacing : 0;
    const pitchTarget = pitchFromAccel + pitchFromTrack;

    const yawTarget =
      input.bogieSpacing > 0 ? (input.frontLateral - input.rearLateral) / input.bogieSpacing : 0;
    const swayTarget =
      s.swayGain * trackPlaneLateral + (input.frontLateral + input.rearLateral) / 2;
    const bounceTarget = (input.frontVertical + input.rearVertical) / 2;

    // --- 2 次系の積分 ---
    const roll = this.rollOsc.step(dt, rollTarget, s.rollFrequency, s.rollDamping);
    const pitch = this.pitchOsc.step(dt, pitchTarget, s.pitchFrequency, s.pitchDamping);
    const yaw = this.yawOsc.step(dt, yawTarget, s.yawFrequency, s.yawDamping);
    const lateral = this.swayOsc.step(dt, swayTarget, s.swayFrequency, s.swayDamping);
    const vertical = this.bounceOsc.step(dt, bounceTarget, s.bounceFrequency, s.bounceDamping);

    // --- 乗客が感じる比力 ---
    // 水平面での比力（右向き a_h、上向き g）を、水平面に対して phi だけ傾いた
    // 車体の床の座標系へ射影する。phi は軌道のカントと車体自身のロールの和。
    //
    //   横   = a_h*cos(phi) + g*sin(phi)
    //   上下 = g*cos(phi) - a_h*sin(phi)
    //
    // 正しくカントの効いた曲線（横が 0 になる釣り合い状態）では上下が g より
    // 大きくなる。これは実際に曲線通過中に体が重く感じられる現象に対応する。
    const trackRoll = -input.cantAngle;
    const absoluteRoll = trackRoll + roll;
    // 軌道面の非平衡横加速度 a = a_h*cos(φ) - g*sin(φ) を a_h について解く
    const ah =
      (trackPlaneLateral + GRAVITY * Math.sin(input.cantAngle)) / Math.cos(input.cantAngle);
    const cos = Math.cos(absoluteRoll);
    const sin = Math.sin(absoluteRoll);
    const feltLateral = ah * cos + GRAVITY * sin;

    // 前後方向も同じ考え方で、勾配とピッチで傾いた床へ重力を射影する。
    //
    //   前後 = g*sin(p) - a          p = 総ピッチ角（正 = 前下がり）
    //
    // 制動（a<0）では前へ押され、上り勾配で停車すると後ろへ押される。下り勾配を
    // 惰行しているときは重力の斜面成分と加速度がほぼ打ち消し合って無感になる
    // （回転部慣性のぶんだけわずかに残るのが正しい）。加速度だけを見て -a と
    // していたころは、下り惰行しているだけで「後ろへ押される」と出ていた。
    const trackPitch = -input.gradeAngle;
    const absolutePitch = trackPitch + pitch;
    const cosPitch = Math.cos(absolutePitch);
    const feltLongitudinal =
      GRAVITY * Math.sin(absolutePitch) - input.longitudinalAcceleration * cosPitch;
    // 床に垂直な成分。前後加速度は床に沿う向きなので、ここには寄与しない
    // （斜面を滑る物体の垂直抗力が m g cos θ になるのと同じ）。
    // 車体が上向きに加速している瞬間は、乗客は座席へ押し付けられる。
    const feltVertical = (GRAVITY * cos - ah * sin) * cosPitch + this.bounceOsc.acceleration;

    // --- 車内の乗客 ---
    // 吊り革は比力に遅れて追従する振り子、立っている乗客は姿勢を保とうとする人間。
    const passenger = this.passenger.step(
      dt,
      feltLateral,
      feltLongitudinal,
      feltVertical,
      this.rollOsc.acceleration,
      this.pitchOsc.acceleration,
    );

    const st = this.state;
    st.roll = roll;
    st.trackRoll = trackRoll;
    st.absoluteRoll = absoluteRoll;
    st.pitch = pitch;
    st.trackPitch = trackPitch;
    st.absolutePitch = absolutePitch;
    st.yaw = yaw;
    st.lateral = lateral;
    st.vertical = vertical;
    st.rollRate = this.rollOsc.rate;
    st.verticalRate = this.bounceOsc.rate;
    st.rollAcceleration = this.rollOsc.acceleration;
    st.pitchAcceleration = this.pitchOsc.acceleration;
    st.feltLateral = feltLateral;
    st.feltLongitudinal = feltLongitudinal;
    st.feltVertical = feltVertical;
    st.passenger = passenger;
    return st;
  }

  reset(): void {
    this.rollOsc.reset();
    this.pitchOsc.reset();
    this.yawOsc.reset();
    this.swayOsc.reset();
    this.bounceOsc.reset();
    this.passenger.reset();
  }
}

const clamp1 = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x);
