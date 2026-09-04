import { DelayLine } from '../math/delay.ts';
import { clamp, sign } from '../math/scalar.ts';
import { GRAVITY, type Meters, type Radians, type Seconds } from '../units.ts';
import type { PassengerSpec } from '../vehicle/spec.ts';

/** 吊り革（受動的な振り子）の振れ */
export interface StrapSwayState {
  /** 左右の振れ角 [rad]（正 = 右へ振られる） */
  lateral: Radians;
  /** 前後の振れ角 [rad]（正 = 前へ振られる＝制動中） */
  longitudinal: Radians;
  /** 左右の振れの角速度 [rad/s] */
  lateralRate: number;
  /** 前後の振れの角速度 [rad/s] */
  longitudinalRate: number;
  /**
   * 瞬時の平衡角 [rad]。比力の向きそのもので、慣性を持たない。
   * 実際の振れ角との差が「まだ振れ切っていない量」＝加加速度の効き具合になる。
   */
  equilibriumLateral: Radians;
  equilibriumLongitudinal: Radians;
}

/** 立っている乗客の、1 面ぶんの姿勢の状態 */
export interface BalanceAxisState {
  /**
   * 床の法線からの上体の傾き [rad]。
   * 正 = その面の正の向き（右／前）へ**倒れている**。定常では比力と逆向き、
   * つまり押される向きへ**よりかかる**ので負になる。
   */
  lean: Radians;
  /** 傾きの角速度 [rad/s] */
  leanRate: number;
  /**
   * 目標の傾き [rad]。見かけの重力に上体を沿わせる角度 `-atan2(f_i, f_z)` で、
   * これに一致していれば足圧中心を動かさずに立っていられる。
   */
  target: Radians;
  /** 目標からのずれ [rad]（`lean - target`）。姿勢制御が消そうとしている量。 */
  error: Radians;
  /** 足圧中心の位置 [m]（正 = 前／右。くるぶし直下が 0） */
  cop: Meters;
  /** その向きへ足圧中心を動かせる限界 [m]（支持基底面 + 手すりぶん） */
  copLimit: Meters;
  /** 姿勢制御の飽和度 0..1（1 = 足圧中心が支持基底面の縁に張り付いている） */
  effort: number;
  /**
   * 外挿重心（XcoM）の支持余裕に対する比。
   *
   * 1 を超えると、いま足を出さないかぎり倒れる — つまり**よろける**。
   * 静止して立っていれば 0、丁寧な加減速なら 0.1 程度にしかならない。
   */
  margin: number;
  /** 踏み出し中か（片足支持） */
  stepping: boolean;
  /** 踏み出しの残り時間 [s] */
  stepTimer: Seconds;
  /** 直近に踏み出した向き（+1 / -1 / 0） */
  stepDirection: number;
  /** 踏み出した回数 */
  steps: number;
  /** 支えきれずに倒れたか（傾きが限界に張り付いている状態） */
  fallen: boolean;
}

/** 立っている乗客（能動的に姿勢を保つ人間）の状態 */
export interface StanceState {
  /** 左右方向（正 = 右） */
  readonly lateral: BalanceAxisState;
  /** 前後方向（正 = 前） */
  readonly longitudinal: BalanceAxisState;
  /**
   * よろけ具合 0..1+。左右・前後の支持余裕を楕円として合成したもの。
   * 1 を超えた瞬間に足が出る。
   */
  stagger: number;
  /** 踏み出しの合計回数（左右 + 前後） */
  steps: number;
  /** どちらかの向きに支えきれずに倒れたか */
  fallen: boolean;
}

/** 車内の乗客の状態（吊り革と、立っている乗客） */
export interface PassengerState {
  /** 吊り革の振れ（つかまっている「物」なので素直な振り子） */
  readonly strap: StrapSwayState;
  /** 立っている乗客（倒立振子 + 遅れのある姿勢制御） */
  readonly stance: StanceState;
}

export function createStrapSwayState(): StrapSwayState {
  return {
    lateral: 0,
    longitudinal: 0,
    lateralRate: 0,
    longitudinalRate: 0,
    equilibriumLateral: 0,
    equilibriumLongitudinal: 0,
  };
}

export function createBalanceAxisState(): BalanceAxisState {
  return {
    lean: 0,
    leanRate: 0,
    target: 0,
    error: 0,
    cop: 0,
    copLimit: 0,
    effort: 0,
    margin: 0,
    stepping: false,
    stepTimer: 0,
    stepDirection: 0,
    steps: 0,
    fallen: false,
  };
}

export function createPassengerState(): PassengerState {
  return {
    strap: createStrapSwayState(),
    stance: {
      lateral: createBalanceAxisState(),
      longitudinal: createBalanceAxisState(),
      stagger: 0,
      steps: 0,
      fallen: false,
    },
  };
}

/** 1 面ぶんの平面振り子（吊り革） */
class PlanarPendulum {
  angle = 0;
  rate = 0;

  /**
   * @param felt      その面の比力 [m/s^2]（正 = その向きへ押される）
   * @param vertical  床に垂直な比力 [m/s^2]
   * @param pivotAcceleration 支点（車体）の角加速度 [rad/s^2]
   */
  step(
    dt: number,
    felt: number,
    vertical: number,
    pivotAcceleration: number,
    length: number,
    damping: number,
  ): number {
    // 見かけの重力の大きさと向き。上下 G が増える曲線では振り子が硬くなる。
    const gEff = Math.hypot(felt, vertical);
    const equilibrium = Math.atan2(felt, vertical);
    const omega = Math.sqrt(Math.max(gEff, 1e-3) / length);
    const acc =
      -omega * omega * Math.sin(this.angle - equilibrium) -
      2 * damping * omega * this.rate -
      pivotAcceleration;
    // 半陰的オイラー（車体動揺と同じ）
    this.rate += acc * dt;
    this.angle += this.rate * dt;
    return equilibrium;
  }

  reset(): void {
    this.angle = 0;
    this.rate = 0;
  }
}

/**
 * 神経のむだ時間。
 *
 * 平衡感覚・足裏の圧覚が変化を捉えてから筋が張り始めるまでには、感覚の伝導・
 * 中枢の処理・電気機械遅延をあわせて 0.1〜0.2 秒かかる。**この遅れこそが
 * 「急な加速度変化にはよろけ、緩やかな変化には抵抗できる」の正体**なので、
 * 一次遅れで鈍らせるのではなく純粋なむだ時間として持つ。
 *
 * 刻み `dt` が分かるのは最初の 1 歩なので、遅延線はそこで作る。
 */
class NeuralDelay {
  private line: DelayLine | null = null;
  private lineDt = 0;

  constructor(private readonly delay: Seconds) {}

  push(value: number, dt: number): number {
    if (this.line === null || Math.abs(dt - this.lineDt) > 1e-12) {
      this.line = new DelayLine(this.delay, dt, 0);
      this.lineDt = dt;
    }
    return this.line.push(value);
  }

  /** 遅延線の中身を `value` で埋め直す（踏み出しで姿勢が飛んだときに使う） */
  reset(value = 0): void {
    this.line?.reset(value);
  }
}

/**
 * 立っている乗客の 1 面ぶん — 倒立振子と、遅れを持つ姿勢制御。
 *
 * ## 力学
 *
 * 上体を、足首を支点とし重心高さ `h` に質量が集まった**倒立**振子とみなす。
 * 床座標系での比力を `(f_i, f_z)`（正 = その向きへ押される / 上向き）とすると、
 * 床の法線からの傾き θ について
 *
 * ```
 * θ̈ = (1/h)(f_z sin θ + f_i cos θ) − (f_z / h²) d − φ̈_車体
 * ```
 *
 * 第 1 項が倒立振子の不安定性そのもの（傾けば傾くほど倒れる）で、吊り革の
 * 振り子と符号が逆になっているのがこの模型の要である。第 2 項が姿勢制御で、
 * `d` は足圧中心（COP）をくるぶし直下からどれだけ動かしたか [m]。床反力の
 * 作用点をずらすことで足首まわりのモーメントを作る、という実際のやり方をそのまま書く。
 *
 * 定常解は `d = 0` のとき `θ* = −atan2(f_i, f_z)`、すなわち**押される向きへ
 * よりかかる**姿勢。加速する電車の中で人が進行方向へ傾いて立っているのはこれである。
 *
 * ## 制御
 *
 * ```
 * d_指令 = k_p e(t − τ) + k_d ė(t − τ),   e = θ − θ*
 * d      → 一次遅れ（筋の立ち上がり）→ 支持基底面でクリップ
 * ```
 *
 * `k_p > h` でなければ倒立振子の不安定性に勝てない（これは実際の足関節スティフネス
 * が体重 × 重心高さを上回っていなければ立てない、という条件と同じ）。
 *
 * 緩やかに加速度が変わるときは `θ*` がゆっくり動くので、むだ時間 τ があっても
 * `e` はほとんど育たない。よりかかる姿勢へ遅れずについていけるので、足圧中心を
 * 少し動かすだけで済み、よろけない。逆に加速度が階段状に変われば `θ*` が飛び、
 * τ のあいだ制御は前の状態のままなので、上体はまるごと取り残される。τ 後に
 * ようやく踏ん張りが始まるが、そのときには倒れる勢いがついている — これがよろけである。
 *
 * 先読みは一切していない。「ゆっくりなら耐えられる」は予測ではなく、
 * **遅れよりゆっくり動く目標には遅れが問題にならない**というだけのことである。
 *
 * ## 足を出す（ステップ戦略）
 *
 * 足圧中心を支持基底面の縁まで動かしても足りなくなったら、人は足を出す。判定には
 * Hof の外挿重心（extrapolated centre of mass）を使う:
 *
 * ```
 * XcoM = h(e + ė / ω₀),   ω₀ = √(f_z / h)
 * ```
 *
 * これが支持基底面の縁を越えたら、その場で立て直すことはもう不可能で、足を出すしかない。
 * 踏み出しは支持基底面ごと重心の下へ移動させるので、着地の瞬間に傾きが跳ねる。
 */
class StanceAxis {
  readonly state = createBalanceAxisState();
  private cop = 0;
  /** 着地してから次の一歩を出せるようになるまでの残り時間 [s] */
  private refractory = 0;
  private readonly errorDelay: NeuralDelay;
  private readonly rateDelay: NeuralDelay;

  constructor(
    private readonly spec: PassengerSpec,
    /** 正の向きへの支持基底面 [m] */
    private readonly forwardBase: Meters,
    /** 負の向きへの支持基底面 [m] */
    private readonly backwardBase: Meters,
  ) {
    this.errorDelay = new NeuralDelay(spec.reactionDelay);
    this.rateDelay = new NeuralDelay(spec.reactionDelay);
  }

  /**
   * @param felt     その面の比力 [m/s^2]（正 = その向きへ押される）
   * @param vertical 床に垂直な比力 [m/s^2]
   * @param pivotAcceleration 床（車体）の角加速度 [rad/s^2]
   */
  step(dt: number, felt: number, vertical: number, pivotAcceleration: number): BalanceAxisState {
    const spec = this.spec;
    const h = spec.comHeight;
    const st = this.state;

    // --- 目標姿勢: 見かけの重力に上体を沿わせる（押される向きへよりかかる）---
    const target = -Math.atan2(felt, vertical);
    const error = st.lean - target;

    // --- 姿勢制御: むだ時間 → 筋の立ち上がり → 支持基底面でクリップ ---
    // 微分項は上体の角速度そのものを使う。目標の動く速さを足すこともできるが、
    // 継目や分岐器の衝撃で目標が跳ねるたびに巨大な指令が出てしまい、
    // 「衝撃を先読みして踏ん張る」という人には無理なことをする模型になる。
    const delayedError = this.errorDelay.push(error, dt);
    const delayedRate = this.rateDelay.push(st.leanRate, dt);
    const command = spec.stiffnessRatio * h * delayedError + spec.dampingGain * delayedRate;
    const muscle = 1 - Math.exp(-dt / spec.muscleTimeConstant);
    this.cop += (command - this.cop) * muscle;

    // 片足支持のあいだは支持基底面が狭い（踏み出している足は床を押せない）
    const support = st.stepping ? spec.singleSupportFactor : 1;
    const positiveLimit = (this.forwardBase + spec.handSupport) * support;
    const negativeLimit = (this.backwardBase + spec.handSupport) * support;
    const applied = clamp(this.cop, -negativeLimit, positiveLimit);
    // 積分状態が縁の外へ際限なく育たないよう、飽和した値を書き戻す（アンチワインドアップ）
    this.cop = applied;
    const limit = applied >= 0 ? positiveLimit : negativeLimit;

    // --- 倒立振子 ---
    const acc =
      (vertical * Math.sin(st.lean) + felt * Math.cos(st.lean)) / h -
      (vertical * applied) / (h * h) -
      pivotAcceleration;
    st.leanRate += acc * dt;
    st.lean += st.leanRate * dt;
    // 支えきれずに倒れた場合。倒立振子は 90 度を超えると一周してしまうので、
    // 「倒れた（あるいはまわりの人にぶつかって止まった）」ところで角度を止める。
    if (Math.abs(st.lean) > spec.maxLean) {
      st.lean = st.lean > 0 ? spec.maxLean : -spec.maxLean;
      st.leanRate = 0;
      st.fallen = true;
    } else if (Math.abs(st.lean) < spec.maxLean * 0.8) {
      st.fallen = false;
    }

    // --- 外挿重心による支持余裕 ---
    // 重心のいまの位置に、いまの速度で ω₀ の時間だけ進む先を足したもの。倒立振子は
    // これが支持基底面の外にあるともう戻せない（Hof の判定）。
    const omega0 = Math.sqrt(Math.max(vertical, 0.5) / h);
    const currentError = st.lean - target;
    const xcom = h * (currentError + st.leanRate / omega0);
    const edge = xcom >= 0 ? positiveLimit : negativeLimit;
    const margin = edge > 0 ? Math.abs(xcom) / edge : 0;

    // --- 踏み出し ---
    if (this.refractory > 0) this.refractory -= dt;
    if (st.stepping) {
      st.stepTimer -= dt;
      if (st.stepTimer <= 0) {
        // 着地。外挿重心がちょうど新しい支持基底面へ収まる位置へ足を置く。
        const shift = clamp(xcom, -spec.stepLength, spec.stepLength);
        st.lean -= shift / h;
        st.leanRate *= spec.stepDissipation;
        st.stepping = false;
        st.stepTimer = 0;
        // 足を出したこと自体が応答なので、遅延線に残っている「倒れかけていたころの
        // 指令」は捨てる。残しておくと、着地してから 0.14 秒のあいだ倒れる向きへ
        // 踏ん張り続けて、必ず反対側へ振られてしまう。
        this.errorDelay.reset(st.lean - target);
        this.rateDelay.reset(st.leanRate);
        this.cop = 0;
        // 着地した足で立て直すまでは次の一歩を出せない（出せると細かく足踏みしてしまう）
        this.refractory = spec.stepDuration;
      }
    } else if (margin > 1 && this.refractory <= 0) {
      st.stepping = true;
      st.stepTimer = spec.stepDuration;
      st.stepDirection = sign(xcom);
      st.steps++;
    }

    st.target = target;
    st.error = currentError;
    st.cop = applied;
    st.copLimit = limit;
    st.effort = limit > 0 ? Math.min(1, Math.abs(applied) / limit) : 0;
    st.margin = margin;
    return st;
  }

  reset(): void {
    const st = this.state;
    st.lean = 0;
    st.leanRate = 0;
    st.target = 0;
    st.error = 0;
    st.cop = 0;
    st.copLimit = 0;
    st.effort = 0;
    st.margin = 0;
    st.stepping = false;
    st.stepTimer = 0;
    st.stepDirection = 0;
    st.steps = 0;
    st.fallen = false;
    this.cop = 0;
    this.refractory = 0;
    this.errorDelay.reset();
    this.rateDelay.reset();
  }
}

/**
 * 車内の乗客。
 *
 * 吊り革は**物**なので減衰振り子でよいが、人は違う。押される向きへよりかかって耐え、
 * 倒れかければ踏ん張り、それでも足りなければ足を出す。振り子として解くと、加速度が
 * ゆっくり変わっても速く変わっても「同じだけ振られてから同じように収まる」という、
 * 人としては起こらない動きになってしまう。
 *
 * ここでは立っている乗客を**足首を支点とした倒立振子 + むだ時間を持つ姿勢制御**として
 * 解く。運転の質との対応は次のようになる。
 *
 * | 加速度の変え方           | 目標姿勢 θ* | 追従の遅れ e | 結果                       |
 * | ------------------------ | ----------- | ------------ | -------------------------- |
 * | 一段ずつ刻む（緩やか）   | ゆっくり動く | ほぼ 0       | 静かによりかかるだけ       |
 * | 一気に入れる（階段状）   | 飛ぶ         | 大きい       | 取り残されて倒れ、足が出る |
 *
 * 同じ最終加速度でも結果が違う、というのがこの模型の目的である。
 */
export class PassengerModel {
  readonly state: PassengerState;
  private readonly strapLat = new PlanarPendulum();
  private readonly strapLon = new PlanarPendulum();
  private readonly stanceLat: StanceAxis;
  private readonly stanceLon: StanceAxis;

  constructor(private readonly spec: PassengerSpec) {
    // 左右は両足の間隔ぶんしか支持基底面が無く、しかも左右対称。
    // 前後は爪先側が広く踵側が狭いので、後ろへ押されるほう（力行）がよろけやすい。
    this.stanceLat = new StanceAxis(spec, spec.footLateral, spec.footLateral);
    this.stanceLon = new StanceAxis(spec, spec.footForward, spec.footBackward);
    this.state = {
      strap: createStrapSwayState(),
      stance: {
        lateral: this.stanceLat.state,
        longitudinal: this.stanceLon.state,
        stagger: 0,
        steps: 0,
        fallen: false,
      },
    };
  }

  step(
    dt: number,
    feltLateral: number,
    feltLongitudinal: number,
    feltVertical: number,
    rollAcceleration: number,
    pitchAcceleration: number,
  ): PassengerState {
    const { strapLength: L, strapDamping: z } = this.spec;
    // 床に垂直な比力。無重量状態では振り子も人も復元力を失うので下限を置く。
    const vertical = Math.max(feltVertical, 0.5);

    // 支点の回転: 車体が右下がりに転がると、吊り革は取り残されて相対的に左へ振れる。
    // ピッチは「正 = 前下がり」で、前へ振れる向きと同じ回転なので符号が逆になる。
    const eqLat = this.strapLat.step(dt, feltLateral, vertical, rollAcceleration, L, z);
    const eqLon = this.strapLon.step(dt, feltLongitudinal, vertical, -pitchAcceleration, L, z);

    // 立っている乗客も足元は車体に固定されているので、同じ支点の回転を受ける。
    const lat = this.stanceLat.step(dt, feltLateral, vertical, rollAcceleration);
    const lon = this.stanceLon.step(dt, feltLongitudinal, vertical, -pitchAcceleration);

    const strap = this.state.strap;
    strap.lateral = this.strapLat.angle;
    strap.longitudinal = this.strapLon.angle;
    strap.lateralRate = this.strapLat.rate;
    strap.longitudinalRate = this.strapLon.rate;
    strap.equilibriumLateral = eqLat;
    strap.equilibriumLongitudinal = eqLon;

    const stance = this.state.stance;
    // 支持基底面は前後に長い楕円と見なせるので、余裕も楕円として合成する。
    stance.stagger = Math.hypot(lat.margin, lon.margin);
    stance.steps = lat.steps + lon.steps;
    stance.fallen = lat.fallen || lon.fallen;
    return this.state;
  }

  reset(): void {
    this.strapLat.reset();
    this.strapLon.reset();
    this.stanceLat.reset();
    this.stanceLon.reset();
    this.state.stance.stagger = 0;
    this.state.stance.steps = 0;
    this.state.stance.fallen = false;
  }
}

/**
 * 振れ角に対応する加速度 [m/s^2]。
 * 吊り革は平衡状態で `tan θ = a / g` なので、角度の目盛りを加速度で読める。
 */
export function swayToAcceleration(angle: Radians): number {
  return GRAVITY * Math.tan(angle);
}
