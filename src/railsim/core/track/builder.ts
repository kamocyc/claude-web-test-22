import { permilToSlope, type Meters, type Radians } from '../units.ts';
import type { Vec3 } from '../math/vec3.ts';
import { Alignment } from './alignment.ts';
import { buildRampProfile, type ConstantSegment } from './profile.ts';

/** 平面線形の 1 区間 */
export interface HorizontalSegment {
  /** 区間長 [m]（先頭の緩和曲線を含む） */
  readonly length: Meters;
  /**
   * 曲線半径 [m]。正 = 左曲がり、負 = 右曲がり。
   * 省略・null・Infinity のときは直線。
   */
  readonly radius?: Meters | null;
  /** 区間先頭に挿入する緩和曲線の長さ [m]。カント逓減もこの区間で行う。 */
  readonly transitionLength?: Meters;
  /**
   * カント量 [m]（大きさ）。符号は半径の向きから自動で決まる。
   * 負の値を与えれば逆カントも表現できる。
   */
  readonly cant?: Meters;
}

/** 縦断線形の 1 区間 */
export interface VerticalSegment {
  /** 区間長 [m]（縦曲線の半分を含む） */
  readonly length: Meters;
  /** 勾配 [‰]（正 = 上り） */
  readonly gradePermil: number;
  /** 縦曲線長 [m]。勾配変化点を中心に前後へ半分ずつ配置される。 */
  readonly verticalCurveLength?: Meters;
}

export interface AlignmentBuildInput {
  /** 軌間 [m]（狭軌 1.067 / 標準軌 1.435） */
  readonly gauge: Meters;
  readonly horizontal: readonly HorizontalSegment[];
  readonly vertical: readonly VerticalSegment[];
  readonly origin?: { position?: Vec3; heading?: Radians };
  readonly sampleStep?: Meters;
}

const curvatureOf = (radius: Meters | null | undefined): number => {
  if (radius === null || radius === undefined) return 0;
  if (!Number.isFinite(radius)) return 0;
  if (radius === 0) throw new Error('曲線半径に 0 は指定できません');
  return 1 / radius;
};

/**
 * 平面線形・縦断線形の区間列から軌道中心線を組み立てる。
 *
 * - 曲率とカントは緩和曲線区間で線形に変化する（曲率が s に対して線形＝クロソイド／
 *   3 次放物線と同じ曲率変化。日本の在来線で用いられる 3 次放物線は曲率変化が線形なので
 *   この表現と一致する）。
 * - 勾配は縦曲線区間で線形に変化し、勾配変化点を中心に前後へ半分ずつ配置される。
 *   その結果、縦曲線区間の高さは s の 2 次関数となり、円曲線による縦曲線と一致する。
 */
export function buildAlignment(input: AlignmentBuildInput): Alignment {
  const hLength = input.horizontal.reduce((a, s) => a + s.length, 0);
  const vLength = input.vertical.reduce((a, s) => a + s.length, 0);
  if (hLength <= 0) throw new Error('平面線形の全長が 0 です');

  const curvatureSegs: ConstantSegment[] = input.horizontal.map((s) => ({
    length: s.length,
    value: curvatureOf(s.radius),
    ...(s.transitionLength === undefined ? {} : { transitionLength: s.transitionLength }),
  }));

  const cantSegs: ConstantSegment[] = input.horizontal.map((s) => {
    const k = curvatureOf(s.radius);
    const magnitude = s.cant ?? 0;
    const dir = k === 0 ? 0 : Math.sign(k);
    return {
      length: s.length,
      value: magnitude * (dir === 0 ? 1 : dir),
      ...(s.transitionLength === undefined ? {} : { transitionLength: s.transitionLength }),
    };
  });

  // 縦断線形が平面線形より短い場合は末尾の勾配で延長する
  const verticalSegs: ConstantSegment[] = input.vertical.map((s) => ({
    length: s.length,
    value: permilToSlope(s.gradePermil),
    ...(s.verticalCurveLength === undefined ? {} : { transitionLength: s.verticalCurveLength }),
  }));
  if (vLength < hLength - 1e-6) {
    const lastGrade = verticalSegs.length > 0 ? verticalSegs[verticalSegs.length - 1]!.value : 0;
    verticalSegs.push({ length: hLength - vLength, value: lastGrade });
  } else if (vLength > hLength + 1e-6) {
    throw new Error(`縦断線形の全長 ${vLength}m が平面線形の全長 ${hLength}m を超えています`);
  }

  return new Alignment({
    curvature: buildRampProfile(curvatureSegs, { label: '曲率プロファイル' }),
    cant: buildRampProfile(cantSegs, { label: 'カントプロファイル' }),
    grade: buildRampProfile(verticalSegs, { centered: true, label: '勾配プロファイル' }),
    gauge: input.gauge,
    length: hLength,
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.sampleStep === undefined ? {} : { sampleStep: input.sampleStep }),
  });
}
