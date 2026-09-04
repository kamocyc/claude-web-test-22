import { GRAVITY, type Meters, type PerMeter, type Radians, type Slope } from '../units.ts';
import { vec3, type Vec3 } from '../math/vec3.ts';
import type { RampProfile } from './profile.ts';

/** 軌道上のある距離程における幾何情報 */
export interface TrackPoint {
  /** 距離程 [m] */
  readonly s: Meters;
  /** 軌道中心線の 3 次元位置（y が高さ） */
  readonly position: Vec3;
  /** 方位角 [rad]（正の曲率で増加する。進行方向は (cos, 0, -sin)） */
  readonly heading: Radians;
  /** 曲率 [1/m]（正 = 左曲がり、0 = 直線） */
  readonly curvature: PerMeter;
  /** 勾配 [m/m]（正 = 上り） */
  readonly grade: Slope;
  /** カント [m]（曲率と同じ符号。正 = 左曲線で外軌側=右レールが高い） */
  readonly cant: Meters;
  /** カント角 [rad] */
  readonly cantAngle: Radians;
}

/**
 * 勾配変化点。勾配標を建てる場所そのものである。
 *
 * 縦曲線がある場合、`s` はその中心（＝前後の勾配線を延長したときの交点。実物の
 * 用語では縦曲線の変化点）を指す。縦曲線の中では勾配が連続的に変化しているが、
 * 「勾配が変わる地点」はあくまでこの 1 点である。
 */
export interface GradeChange {
  /** 勾配変化点の距離程 [m] */
  readonly s: Meters;
  /** 手前の勾配 [m/m]（正 = 上り） */
  readonly from: Slope;
  /** この先の勾配 [m/m]（勾配標に書かれるのはこちら） */
  readonly to: Slope;
  /** 縦曲線長 [m]。縦曲線が無ければ 0。 */
  readonly verticalCurveLength: Meters;
}

/**
 * 曲線 1 か所。緩和曲線を含めた「曲線区間」ひとまとまりを表す。
 *
 * 実物の線路では、この 4 点にそれぞれ標識が建つ:
 *
 * | 点 | 略号 | 意味 |
 * |----|------|------|
 * | `start`         | BTC | 緩和曲線始点（直線から曲率が立ち上がりはじめる） |
 * | `circularStart` | BCC | 円曲線始点（曲率とカントが所定の値になる） |
 * | `circularEnd`   | ECC | 円曲線終点 |
 * | `end`           | ETC | 緩和曲線終点（直線へ戻る） |
 */
export interface CurveSection {
  /** 緩和曲線始点 BTC の距離程 [m] */
  readonly start: Meters;
  /** 円曲線始点 BCC の距離程 [m] */
  readonly circularStart: Meters;
  /** 円曲線終点 ECC の距離程 [m] */
  readonly circularEnd: Meters;
  /** 緩和曲線終点 ETC の距離程 [m] */
  readonly end: Meters;
  /** 曲線半径 [m]（符号を持たない） */
  readonly radius: Meters;
  /** 左曲線か（曲率が正） */
  readonly leftHand: boolean;
  /** 円曲線部のカント [m]（符号を持たない） */
  readonly cant: Meters;
  /** 曲線長 [m]（BTC 〜 ETC） */
  readonly length: Meters;
  /** 緩和曲線を持つか（分岐器のリード曲線は持たない） */
  readonly hasTransition: boolean;
}

/** 軌道中心線を組み立てるための入力 */
export interface AlignmentInput {
  /** 曲率プロファイル [1/m] */
  readonly curvature: RampProfile;
  /** 勾配プロファイル [m/m] */
  readonly grade: RampProfile;
  /** カントプロファイル [m] */
  readonly cant: RampProfile;
  /** 軌間 [m]（カント不足の算出に使う） */
  readonly gauge: Meters;
  /** 全長 [m] */
  readonly length: Meters;
  /** 起点の位置・方位・高さ */
  readonly origin?: { position?: Vec3; heading?: Radians };
  /** 位置サンプルの刻み [m]（既定 1 m） */
  readonly sampleStep?: Meters;
}

/** 4 点ガウス・ルジャンドル求積の節点と重み（区間 [-1,1]） */
const GL_NODES = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const GL_WEIGHTS = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];

/**
 * 軌道中心線。
 *
 * 平面線形は曲率プロファイル κ(s) で定義され、方位角は θ(s) = θ0 + ∫κ ds（解析的に厳密）、
 * 平面位置は x = ∫cos θ ds, z = -∫sin θ ds をガウス・ルジャンドル求積で数値積分して求める。
 * 直線・円曲線だけでなく緩和曲線（曲率が線形に変化する区間）も同じ枠組みで扱える。
 *
 * 縦断線形は勾配プロファイル i(s) の積分で高さを与える。縦曲線は勾配が線形に変化する区間として
 * 表現されるため、高さは s の 2 次関数となり、これも厳密に積分される。
 */
export class Alignment {
  readonly length: Meters;
  readonly gauge: Meters;
  private readonly curvatureProfile: RampProfile;
  private readonly gradeProfile: RampProfile;
  private readonly cantProfile: RampProfile;
  private readonly heading0: Radians;
  private readonly origin: Vec3;
  private readonly step: Meters;
  /** sampleStep ごとの平面位置（累積積分のキャッシュ） */
  private readonly sampleX: Float64Array;
  private readonly sampleZ: Float64Array;
  private readonly sampleS: Float64Array;

  constructor(input: AlignmentInput) {
    this.length = input.length;
    this.gauge = input.gauge;
    this.curvatureProfile = input.curvature;
    this.gradeProfile = input.grade;
    this.cantProfile = input.cant;
    this.heading0 = input.origin?.heading ?? 0;
    this.origin = input.origin?.position ?? vec3(0, 0, 0);
    this.step = input.sampleStep ?? 1;

    const n = Math.max(1, Math.ceil(this.length / this.step)) + 1;
    this.sampleS = new Float64Array(n);
    this.sampleX = new Float64Array(n);
    this.sampleZ = new Float64Array(n);
    let x = this.origin.x;
    let z = this.origin.z;
    for (let i = 0; i < n; i++) {
      const s = Math.min(i * this.step, this.length);
      this.sampleS[i] = s;
      this.sampleX[i] = x;
      this.sampleZ[i] = z;
      if (i + 1 < n) {
        const sNext = Math.min((i + 1) * this.step, this.length);
        const d = this.integrateXZ(s, sNext);
        x += d.dx;
        z += d.dz;
      }
    }
  }

  /** 方位角 θ(s) = θ0 + ∫κ ds */
  headingAt(s: Meters): Radians {
    return this.heading0 + this.curvatureProfile.integralAt(s);
  }

  /** 曲率 [1/m]（正 = 左曲がり） */
  curvatureAt(s: Meters): PerMeter {
    return this.curvatureProfile.valueAt(s);
  }

  /** 曲線半径 [m]（直線では Infinity）。符号は持たない。 */
  radiusAt(s: Meters): Meters {
    const k = Math.abs(this.curvatureAt(s));
    return k < 1e-9 ? Infinity : 1 / k;
  }

  /**
   * 曲線区間の一覧（曲線標・カント標・緩和曲線の始終端標を建てる場所）。
   *
   * 曲率プロファイルは「曲率一定の区間（直線と円曲線）」と「曲率が線形に変化する
   * 区間（緩和曲線）」の列なので、直線を挟まずに続く非零の要素をひとまとめにすれば
   * 曲線 1 か所になる。そのうち曲率が一定の部分が円曲線、前後が緩和曲線である。
   *
   * 曲率が符号をまたぐ要素（直線を挟まない反向曲線）は零点で切り、別々の曲線として
   * 扱う。1 本の緩和曲線で右から左へ折り返す線形でも、右の曲線と左の曲線に分かれる。
   */
  get curveSections(): readonly CurveSection[] {
    // 符号をまたぐ要素は零点で切っておく（以降は 1 要素が 1 つの向きだけを持つ）
    type Piece = { sStart: number; length: number; startValue: number; endValue: number };
    const pieces: Piece[] = [];
    for (const seg of this.curvatureProfile.segments) {
      if (seg.startValue * seg.endValue < 0) {
        const zero = (seg.length * seg.startValue) / (seg.startValue - seg.endValue);
        pieces.push({ sStart: seg.sStart, length: zero, startValue: seg.startValue, endValue: 0 });
        pieces.push({
          sStart: seg.sStart + zero,
          length: seg.length - zero,
          startValue: 0,
          endValue: seg.endValue,
        });
      } else {
        pieces.push({ ...seg });
      }
    }

    const isStraight = (p: Piece): boolean => p.startValue === 0 && p.endValue === 0;
    const signOf = (p: Piece): number => Math.sign(p.startValue !== 0 ? p.startValue : p.endValue);

    const out: CurveSection[] = [];
    for (let i = 0; i < pieces.length;) {
      if (isStraight(pieces[i]!)) {
        i++;
        continue;
      }
      const sign = signOf(pieces[i]!);
      let j = i;
      while (
        j + 1 < pieces.length &&
        !isStraight(pieces[j + 1]!) &&
        signOf(pieces[j + 1]!) === sign
      ) {
        j++;
      }

      const start = pieces[i]!.sStart;
      const end = pieces[j]!.sStart + pieces[j]!.length;
      // 円曲線部 = 曲率が一定で 0 でない部分。緩和曲線はその前後に付く。
      let circularStart: number | null = null;
      let circularEnd: number | null = null;
      let peak = 0;
      for (let k = i; k <= j; k++) {
        const p = pieces[k]!;
        if (p.startValue === p.endValue && p.startValue !== 0) {
          if (circularStart === null) circularStart = p.sStart;
          circularEnd = p.sStart + p.length;
        }
        peak = Math.max(peak, Math.abs(p.startValue), Math.abs(p.endValue));
      }
      // 円曲線部を持たない（緩和曲線だけで折り返す）線形では、頂点を 1 点として扱う
      if (circularStart === null || circularEnd === null) {
        circularStart = (start + end) / 2;
        circularEnd = circularStart;
      }

      out.push({
        start,
        circularStart,
        circularEnd,
        end,
        radius: peak > 0 ? 1 / peak : Infinity,
        leftHand: sign > 0,
        cant: Math.abs(this.cantAt((circularStart + circularEnd) / 2)),
        length: end - start,
        hasTransition: circularStart > start || end > circularEnd,
      });
      i = j + 1;
    }
    return out;
  }

  /** 勾配 [m/m]（正 = 上り） */
  gradeAt(s: Meters): Slope {
    return this.gradeProfile.valueAt(s);
  }

  /**
   * 勾配変化点の一覧（勾配標の建植位置）。
   *
   * 勾配プロファイルは「一定勾配の区間」と「勾配が線形に変化する区間（縦曲線）」の
   * 列なので、変化率が等しく連続する要素をひとまとめにすれば縦曲線 1 か所に対応する。
   * その中点が前後の勾配線の交点、すなわち勾配変化点になる。縦曲線を持たない
   * 勾配変化（値が段差になっている境界）もここで拾う。
   *
   * 距離程を一定間隔でサンプルして勾配の差を見る方法だと、縦曲線の中はどこを取っても
   * 勾配が変わっているため、1 か所の変化点が何点にも化ける。そうならないよう、
   * サンプルではなく線形の要素そのものから求める。
   */
  get gradeChanges(): readonly GradeChange[] {
    const segs = this.gradeProfile.segments;
    const rateOf = (i: number): number => {
      const seg = segs[i]!;
      return seg.length === 0 ? 0 : (seg.endValue - seg.startValue) / seg.length;
    };
    // 勾配の変化率どうしを比べるので、許容差も変化率の大きさに合わせる
    const sameRate = (a: number, b: number): boolean =>
      Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE);

    const out: GradeChange[] = [];
    for (let i = 0; i < segs.length;) {
      const rate = rateOf(i);
      if (rate === 0) {
        // 一定勾配の区間。次の要素との間に段差があれば、縦曲線の無い勾配変化点
        const next = segs[i + 1];
        if (next !== undefined && next.startValue !== segs[i]!.endValue) {
          out.push({
            s: next.sStart,
            from: segs[i]!.endValue,
            to: next.startValue,
            verticalCurveLength: 0,
          });
        }
        i++;
        continue;
      }
      // 同じ変化率で続くかぎり 1 つの縦曲線とみなす
      let j = i;
      while (
        j + 1 < segs.length &&
        sameRate(rateOf(j + 1), rate) &&
        segs[j + 1]!.startValue === segs[j]!.endValue
      ) {
        j++;
      }
      const first = segs[i]!;
      const last = segs[j]!;
      const length = last.sStart + last.length - first.sStart;
      out.push({
        s: first.sStart + length / 2,
        from: first.startValue,
        to: last.endValue,
        verticalCurveLength: length,
      });
      i = j + 1;
    }
    return out;
  }

  /** 区間 [s0, s1] の平均勾配。車体長にわたる勾配力の平均に使う。 */
  averageGrade(s0: Meters, s1: Meters): Slope {
    return this.gradeProfile.averageOver(s0, s1);
  }

  /** 区間 [s0, s1] の平均曲率 */
  averageCurvature(s0: Meters, s1: Meters): PerMeter {
    return this.curvatureProfile.averageOver(s0, s1);
  }

  /** 高さ [m] = 起点高さ + ∫i ds */
  elevationAt(s: Meters): Meters {
    return this.origin.y + this.gradeProfile.integralAt(s);
  }

  /** カント [m] */
  cantAt(s: Meters): Meters {
    return this.cantProfile.valueAt(s);
  }

  /**
   * カント角 [rad]。**外軌（曲線外側のレール）が高いほど正**で、
   * 曲率が正（左曲線）ならカント角も正になる。
   *
   * 車体のロール角は「右側が下がるほど正」という逆の約束なので、
   * カントが車体に与えるロールは `-cantAngleAt(s)` になる。描画・体感加速度とも
   * この符号を取り違えると軌道と車体が逆向きに傾く。
   */
  cantAngleAt(s: Meters): Radians {
    return Math.asin(Math.max(-1, Math.min(1, this.cantAt(s) / this.gauge)));
  }

  /**
   * 均衡カント [m]。速度 v で走行したとき、重力と遠心力の合力が軌道面に垂直になる
   * （＝非平衡横加速度が 0 になる）カント量。
   *
   * 釣り合いの条件は tan(φ) = v^2*κ/g。カントは軌間に対するレール頭頂面の高低差なので
   * C = G*sin(φ) であり、t = v^2*κ/g とおくと
   *
   *   C_eq = G * t / sqrt(1 + t^2)
   *
   * 慣用式 C = G V^2 / (127 R) は G*tan(φ) に相当する小角度近似で、
   * 実用範囲（カント不足を含めて 10 度程度まで）では 0.5% ほど大きい値になる。
   * 設計上の制限速度の算出には慣用式を使う（`packages/data` 側）が、
   * ここでは `lateralAcceleration()` と厳密に整合する定義を採る。
   */
  equilibriumCant(s: Meters, v: number): Meters {
    const t = (v * v * this.curvatureAt(s)) / GRAVITY;
    return (this.gauge * t) / Math.sqrt(1 + t * t);
  }

  /**
   * カント不足 [m] = 均衡カント - 実カント。**向き付きの量**で、
   * 曲率と同符号なら曲線外側へ超過遠心力が働いていることを表す。
   *
   * 左曲線（曲率が正）では正が不足・負が超過だが、**右曲線では逆になる**。
   * 「何 mm 不足しているか」を人に見せる用途には向かないので、
   * その場合は `cantDeficiencyAmount()` を使うこと。
   */
  cantDeficiency(s: Meters, v: number): Meters {
    return this.equilibriumCant(s, v) - this.cantAt(s);
  }

  /**
   * カント過不足量 [m]。**正 = 不足、負 = 超過**で、曲線の左右によらない。
   *
   * `cantDeficiency()` を曲線の向きへ射影したもので、実務で言う「カント不足量」
   * （許容値 60mm などと比べる量）はこちら。表示・警告・評価にはこれを使う。
   */
  cantDeficiencyAmount(s: Meters, v: number): Meters {
    const k = this.curvatureAt(s);
    if (k === 0) return 0;
    return this.cantDeficiency(s, v) * Math.sign(k);
  }

  /**
   * 軌道面内の非平衡（未補償）左右加速度 [m/s^2]。
   *
   * 水平面内の求心加速度 v^2*κ（正 = 左向き）を軌道面へ射影した成分から、
   * カントによって重力が肩代わりする分 g*sin(カント角) を差し引いたもの。
   * 正なら左向きの求心力が不足しており、乗客は曲線外側（右）へ押される。
   * 乗り心地評価と転覆・脱線余裕の判定に使う。
   *
   *   a = v^2*κ*cos(φ) - g*sin(φ)
   *
   * cos(φ) は 1 に近いが、カント 90mm・軌間 1067mm では φ = 4.84 度あり、
   * 省略すると 0.4% の誤差になる。
   */
  lateralAcceleration(s: Meters, v: number): number {
    const k = this.curvatureAt(s);
    const phi = this.cantAngleAt(s);
    return v * v * k * Math.cos(phi) - GRAVITY * Math.sin(phi);
  }

  /** 平面位置 (x, z) */
  private planeAt(s: Meters): { x: number; z: number } {
    if (s <= 0) {
      const th = this.heading0;
      return { x: this.origin.x + Math.cos(th) * s, z: this.origin.z - Math.sin(th) * s };
    }
    if (s >= this.length) {
      const last = this.sampleS.length - 1;
      const th = this.headingAt(this.length);
      const d = s - this.length;
      return {
        x: this.sampleX[last]! + Math.cos(th) * d,
        z: this.sampleZ[last]! - Math.sin(th) * d,
      };
    }
    const i = Math.min(Math.floor(s / this.step), this.sampleS.length - 1);
    const s0 = this.sampleS[i]!;
    const d = this.integrateXZ(s0, s);
    return { x: this.sampleX[i]! + d.dx, z: this.sampleZ[i]! + d.dz };
  }

  /** 区間 [a, b] の平面変位をガウス・ルジャンドル求積で計算する */
  private integrateXZ(a: number, b: number): { dx: number; dz: number } {
    const half = (b - a) / 2;
    const mid = (a + b) / 2;
    let dx = 0;
    let dz = 0;
    for (let k = 0; k < GL_NODES.length; k++) {
      const s = mid + half * GL_NODES[k]!;
      const th = this.headingAt(s);
      dx += GL_WEIGHTS[k]! * Math.cos(th);
      dz -= GL_WEIGHTS[k]! * Math.sin(th);
    }
    return { dx: dx * half, dz: dz * half };
  }

  /** 3 次元位置 */
  positionAt(s: Meters): Vec3 {
    const p = this.planeAt(s);
    return vec3(p.x, this.elevationAt(s), p.z);
  }

  /** 進行方向の単位ベクトル */
  tangentAt(s: Meters): Vec3 {
    const th = this.headingAt(s);
    const i = this.gradeAt(s);
    const n = Math.sqrt(1 + i * i);
    return vec3(Math.cos(th) / n, i / n, -Math.sin(th) / n);
  }

  at(s: Meters): TrackPoint {
    return {
      s,
      position: this.positionAt(s),
      heading: this.headingAt(s),
      curvature: this.curvatureAt(s),
      grade: this.gradeAt(s),
      cant: this.cantAt(s),
      cantAngle: this.cantAngleAt(s),
    };
  }

  /** 描画用に等間隔でサンプリングする */
  sample(step: Meters, from: Meters = 0, to: Meters = this.length): TrackPoint[] {
    const out: TrackPoint[] = [];
    const n = Math.max(1, Math.ceil((to - from) / step));
    for (let i = 0; i <= n; i++) {
      out.push(this.at(Math.min(from + i * step, to)));
    }
    return out;
  }

  /** 曲率・勾配・カントの要素境界（イベント点生成用） */
  get elementBoundaries(): number[] {
    const set = new Set<number>();
    for (const b of this.curvatureProfile.boundaries) set.add(b);
    for (const b of this.gradeProfile.boundaries) set.add(b);
    for (const b of this.cantProfile.boundaries) set.add(b);
    return [...set].sort((a, b) => a - b);
  }

  /** 位置サンプルの刻み [m] */
  get sampleStep(): Meters {
    return this.step;
  }
}
