import { binarySearchLE } from '../math/scalar.ts';

/**
 * 区分線形プロファイルの 1 要素。
 * 距離 `length` のあいだに値が `startValue` から `endValue` へ線形に変化する。
 *
 * - 曲率プロファイル: 直線・円曲線は start === end、緩和曲線は線形に変化
 * - 勾配プロファイル: 勾配区間は start === end、縦曲線は線形に変化
 * - カントプロファイル: カント逓減区間で線形に変化
 */
export interface RampSegment {
  readonly length: number;
  readonly startValue: number;
  readonly endValue: number;
}

/**
 * 距離程 s の区分線形関数と、その原始関数（積分値）を保持する。
 *
 * 曲率 κ(s) の積分が方位角 θ(s) に、勾配 i(s) の積分が高さ z(s) になるため、
 * この 1 クラスで平面線形と縦断線形の両方を扱える。
 * 定義域の外側では端点の値が続くものとして扱う（外挿しない）。
 */
export class RampProfile {
  private readonly sStart: number[] = [];
  private readonly len: number[] = [];
  private readonly v0: number[] = [];
  private readonly v1: number[] = [];
  /** 各要素の始端における積分値 */
  private readonly integ: number[] = [];
  readonly totalLength: number;

  constructor(segments: readonly RampSegment[]) {
    let s = 0;
    let acc = 0;
    for (const seg of segments) {
      if (!(seg.length > 0)) {
        throw new Error(`RampProfile の要素長は正である必要があります: ${seg.length}`);
      }
      this.sStart.push(s);
      this.len.push(seg.length);
      this.v0.push(seg.startValue);
      this.v1.push(seg.endValue);
      this.integ.push(acc);
      acc += ((seg.startValue + seg.endValue) / 2) * seg.length;
      s += seg.length;
    }
    this.totalLength = s;
    if (segments.length === 0) {
      // 空のプロファイルは恒等的に 0
      this.sStart.push(0);
      this.len.push(0);
      this.v0.push(0);
      this.v1.push(0);
      this.integ.push(0);
    }
  }

  /** 先頭の値（定義域より手前ではこの値が続く） */
  get firstValue(): number {
    return this.v0[0]!;
  }

  /** 末尾の値（定義域より先ではこの値が続く） */
  get lastValue(): number {
    return this.v1[this.v1.length - 1]!;
  }

  /** 全区間の積分値 */
  get totalIntegral(): number {
    const i = this.integ.length - 1;
    return this.integ[i]! + ((this.v0[i]! + this.v1[i]!) / 2) * this.len[i]!;
  }

  /** 要素の境界の距離程（イベント点の生成に使う） */
  get boundaries(): readonly number[] {
    return this.sStart;
  }

  /** 要素の一覧（始端の距離程つき）。勾配変化点の検出などに使う。 */
  get segments(): readonly (RampSegment & { readonly sStart: number })[] {
    return this.sStart.map((sStart, i) => ({
      sStart,
      length: this.len[i]!,
      startValue: this.v0[i]!,
      endValue: this.v1[i]!,
    }));
  }

  valueAt(s: number): number {
    if (s <= 0) return this.firstValue;
    if (s >= this.totalLength) return this.lastValue;
    const i = Math.max(0, binarySearchLE(this.sStart, s));
    const t = this.len[i]! === 0 ? 0 : (s - this.sStart[i]!) / this.len[i]!;
    return this.v0[i]! + (this.v1[i]! - this.v0[i]!) * t;
  }

  /** 0 から s までの積分値（s < 0 や s > 全長でも端点の値で外挿する） */
  integralAt(s: number): number {
    if (s <= 0) return this.firstValue * s;
    if (s >= this.totalLength) {
      return this.totalIntegral + this.lastValue * (s - this.totalLength);
    }
    const i = Math.max(0, binarySearchLE(this.sStart, s));
    const d = s - this.sStart[i]!;
    const L = this.len[i]!;
    const a = this.v0[i]!;
    const b = L === 0 ? a : a + ((this.v1[i]! - a) * d) / L;
    return this.integ[i]! + ((a + b) / 2) * d;
  }

  /** 区間 [s0, s1] の平均値（車体長にわたる勾配の平均などに使う） */
  averageOver(s0: number, s1: number): number {
    if (s1 === s0) return this.valueAt(s0);
    return (this.integralAt(s1) - this.integralAt(s0)) / (s1 - s0);
  }
}

/** buildRampProfile への入力となる一定値区間 */
export interface ConstantSegment {
  /** 区間長 [m]（遷移部を含む） */
  readonly length: number;
  /** この区間の値 */
  readonly value: number;
  /** 区間の始端で前の値からこの値へ遷移する長さ [m]（緩和曲線長・縦曲線長・カント逓減長） */
  readonly transitionLength?: number;
}

export interface BuildRampOptions {
  /**
   * true のとき遷移区間を境界の前後に半分ずつ配置する（縦曲線の標準的な取り方）。
   * false（既定）のとき遷移区間は後続区間の先頭に置かれる（緩和曲線の標準的な取り方）。
   */
  readonly centered?: boolean;
  /** エラーメッセージ用のラベル */
  readonly label?: string;
}

/**
 * 一定値の区間列から RampProfile を組み立てる。
 * 隣り合う区間で値が不連続な場合、指定した長さの遷移（緩和曲線・縦曲線・カント逓減）を挿入する。
 */
export function buildRampProfile(
  segments: readonly ConstantSegment[],
  options: BuildRampOptions = {},
): RampProfile {
  const label = options.label ?? 'プロファイル';
  const centered = options.centered ?? false;
  const n = segments.length;
  if (n === 0) return new RampProfile([]);

  // 各境界の遷移長を決める（値が連続なら遷移不要）
  const transAt: number[] = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const t = segments[i]!.transitionLength ?? 0;
    transAt[i] = segments[i]!.value === segments[i - 1]!.value ? 0 : t;
  }

  const out: RampSegment[] = [];
  for (let i = 0; i < n; i++) {
    const seg = segments[i]!;
    const inT = transAt[i]!;
    const outT = i + 1 < n ? transAt[i + 1]! : 0;
    // この区間が負担する遷移長
    const headConsumed = centered ? inT / 2 : inT;
    const tailConsumed = centered ? outT / 2 : 0;

    if (inT > 0) {
      // 遷移の後半（centered なら前半は前の区間側で出力済み）
      const half = centered ? inT / 2 : inT;
      const prev = segments[i - 1]!.value;
      if (half > 0) {
        if (centered) {
          const mid = (prev + seg.value) / 2;
          out.push({ length: half, startValue: mid, endValue: seg.value });
        } else {
          out.push({ length: half, startValue: prev, endValue: seg.value });
        }
      }
    }

    const core = seg.length - headConsumed - tailConsumed;
    if (core < -1e-9) {
      throw new Error(
        `${label}: 第 ${i + 1} 区間の長さ ${seg.length}m が遷移長 ` +
          `(前 ${headConsumed}m / 後 ${tailConsumed}m) に対して不足しています`,
      );
    }
    if (core > 1e-9) {
      out.push({ length: core, startValue: seg.value, endValue: seg.value });
    }

    if (centered && outT > 0) {
      // 遷移の前半をこの区間の末尾に出力する
      const next = segments[i + 1]!.value;
      const mid = (seg.value + next) / 2;
      out.push({ length: outT / 2, startValue: seg.value, endValue: mid });
    }
  }
  return new RampProfile(out);
}
