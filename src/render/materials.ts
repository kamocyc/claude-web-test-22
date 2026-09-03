import {
  Color,
  DoubleSide,
  MeshStandardMaterial,
  type WebGLProgramParametersWithUniforms,
} from 'three';

/** 表示モードを切り替えるための共有 uniform。 */
export const viewUniforms = {
  /** 1 で診断表示 (勾配・曲率の色分け) を有効にする。 */
  uDiagnostics: { value: 0 },
  /** 地形の等高線の間隔 [m]。0 で非表示。 */
  uContour: { value: 10 },
  /** 1 で地形を傾斜のヒートマップにする。 */
  uSlopeHeat: { value: 0 },
};

/**
 * 診断色のランプ。0 = 余裕、1 = 規格ちょうど、1.4 以上 = 大幅超過。
 *
 * シェーダと HUD の数値で同じ配色を使うため、ここ 1 か所に置いて
 * GLSL へは文字列として埋め込む。
 */
const RISK_OK = [0.24, 0.72, 0.36] as const;
const RISK_WARN = [0.95, 0.79, 0.2] as const;
const RISK_BAD = [0.9, 0.22, 0.18] as const;

const glsl = (rgb: readonly [number, number, number]): string =>
  `vec3(${rgb.map((v) => v.toFixed(2)).join(', ')})`;

/** 診断色 (0..1 の RGB)。シェーダの `riskColor` と同じ計算。 */
export function riskTint(risk: number): readonly [number, number, number] {
  const t = risk < 0.75 ? risk / 0.75 : Math.min(1, Math.max(0, (risk - 0.75) / 0.45));
  const from = risk < 0.75 ? RISK_OK : RISK_WARN;
  const to = risk < 0.75 ? RISK_WARN : RISK_BAD;
  const at = (i: number): number => Math.min(1, Math.max(0, from[i] + (to[i] - from[i]) * t));
  return [at(0), at(1), at(2)];
}

/** 診断色を CSS の `#rrggbb` で返す。 */
export function riskColor(risk: number): string {
  const hex = (v: number): string =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  const [r, g, b] = riskTint(risk);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * 診断表示 (勾配・曲率) を注入したマテリアルを作る。
 *
 * 各頂点の `diag` は (勾配の規格比, 曲率の規格比)。1 を超えると規格超過なので
 * 緑 → 黄 → 赤へ変化させる。
 */
export function createSurfaceMaterial(options?: {
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
  /** false にすると、何かの陰に入っていても必ず描かれる (透視表示)。 */
  depthTest?: boolean;
  polygonOffsetUnits?: number;
  side?: typeof DoubleSide | undefined;
  /** 診断表示の on/off を制御する uniform。既定は全体共有のもの。 */
  diagnostics?: { value: number };
  /** 1 にすると面を赤く塗る (敷設できないプレビュー)。 */
  blocked?: { value: number };
}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    transparent: options?.transparent ?? false,
    opacity: options?.opacity ?? 1,
    depthWrite: options?.depthWrite ?? true,
    depthTest: options?.depthTest ?? true,
    polygonOffset: true,
    // 傾き係数は 0 にする。視線に対して浅い角度で見た面では傾き係数の項が
    // 巨大になり、路面が数十 cm 手前に寄ってしまう。踏切のレールのように
    // 路面のすぐ上にあるものが、その分だけ舗装に飲まれて消えてしまう。
    polygonOffsetFactor: 0,
    polygonOffsetUnits: options?.polygonOffsetUnits ?? -2,
    ...(options?.side ? { side: options.side } : {}),
  });

  const blocked = options?.blocked ?? { value: 0 };
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uDiagnostics = options?.diagnostics ?? viewUniforms.uDiagnostics;
    shader.uniforms.uBlocked = blocked;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 diag;
varying vec2 vDiag;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vDiag = diag;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uDiagnostics;
uniform float uBlocked;
varying vec2 vDiag;

vec3 riskColor(float risk) {
  // 0 = 余裕, 1 = 規格ちょうど, 1.4 以上 = 大幅超過。
  vec3 ok = ${glsl(RISK_OK)};
  vec3 warn = ${glsl(RISK_WARN)};
  vec3 bad = ${glsl(RISK_BAD)};
  if (risk < 0.75) return mix(ok, warn, risk / 0.75);
  return mix(warn, bad, clamp((risk - 0.75) / 0.45, 0.0, 1.0));
}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
if (uDiagnostics > 0.5) {
  float risk = max(vDiag.x, vDiag.y);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, riskColor(risk), 0.82);
}
if (uBlocked > 0.5) {
  gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.92, 0.22, 0.18), 0.85);
}`,
      );
  };
  // uniform の束ね方が違うマテリアル同士でプログラムを共有しないよう、
  // 診断 uniform を差し替えた場合はキーも変える。
  const key = options?.diagnostics ? 'surface-diag-forced' : 'surface-diag';
  material.customProgramCacheKey = () => key;
  return material;
}

/**
 * 手続き的なノイズ (GLSL)。
 *
 * この計画はテクスチャ画像を 1 枚も持たない。地面のむらは値ノイズで作る。
 * `hash21` は 2 次元 → 0..1、`vnoise` はその双一次補間、`fbm2` は 3 オクターブ。
 * オクターブを増やすほど地面の情報は増えるが、地形は画面のほとんどを覆うので
 * フラグメントの計算はそのままフレーム時間に効く。3 で止めてある。
 */
const NOISE_GLSL = `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm2(vec2 p) {
  return vnoise(p) * 0.5 + vnoise(p * 2.03) * 0.3 + vnoise(p * 4.01) * 0.2;
}
`;

/**
 * 地形マテリアル。傾斜による色分け、標高による色味、等高線を入れる。
 */
export function createTerrainMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(1, 1, 1),
    roughness: 1.0,
    metalness: 0.0,
  });

  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uContour = viewUniforms.uContour;
    shader.uniforms.uSlopeHeat = viewUniforms.uSlopeHeat;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;
varying vec3 vWorldNormal;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uContour;
uniform float uSlopeHeat;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
${NOISE_GLSL}
vec3 slopeHeat(float slopeDeg) {
  vec3 flat0 = vec3(0.16, 0.52, 0.78);
  vec3 mid = vec3(0.98, 0.85, 0.30);
  vec3 steep = vec3(0.85, 0.17, 0.20);
  float t = clamp(slopeDeg / 45.0, 0.0, 1.0);
  return t < 0.5 ? mix(flat0, mid, t * 2.0) : mix(mid, steep, (t - 0.5) * 2.0);
}

/**
 * 地面の色。
 *
 * 傾斜と標高だけで決めると、同じ高さの平地がどこまでも同じ緑になる。
 * 3 段のむら — 大 (150 m) で草地と乾いた草・土の混ざりを動かし、中 (18 m) と
 * 小 (1.1 m と 3.6 m) で明るさを振る — を掛けて、面の中に情報を持たせる。
 * 小さいむらは detail で遠くから消す (遠景は地形が 8 m・16 m 格子に落ちるので、
 * 残すとちらつく)。
 */
vec3 terrainColor(float slopeDeg, float height, vec2 xz, float detail) {
  vec3 grass = vec3(0.28, 0.45, 0.19);
  vec3 grassDry = vec3(0.40, 0.47, 0.23);
  vec3 dirt = vec3(0.44, 0.35, 0.22);
  vec3 rock = vec3(0.42, 0.41, 0.40);
  vec3 sand = vec3(0.66, 0.61, 0.46);

  float macro = fbm2(xz / 150.0);
  float meso = vnoise(xz / 18.0);
  float micro = vnoise(xz / 1.1) * 0.6 + vnoise(xz / 3.6) * 0.4;

  // 乾いた草は標高だけでなく、大きなむらでも顔を出す。
  float dryness = clamp(height / 60.0 + (macro - 0.5) * 0.55, 0.0, 1.0);
  vec3 c = mix(grass, grassDry, dryness);
  // 草地の中に土が透ける所を作る。
  c = mix(c, dirt, smoothstep(0.62, 0.92, macro) * 0.35);
  c = mix(c, dirt, smoothstep(14.0, 27.0, slopeDeg));
  c = mix(c, rock, smoothstep(29.0, 42.0, slopeDeg));
  // 水際だけ砂浜にする。
  c = mix(sand, c, smoothstep(0.0, 1.6, height));

  // 明るさのむら。岩肌と砂浜にも通す (平らに見えないように)。
  c *= 1.0 + (meso - 0.5) * 0.12 + (micro - 0.5) * 0.13 * detail;
  return c;
}`,
      )
      // 粗さを振る。一様な艶消しだと、陽の当たり方が面のどこでも同じになる。
      // `roughnessFactor` はこの include が宣言するので、必ずこの後で触る。
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor - (vnoise(vWorldPos.xz / 26.0) - 0.5) * 0.3, 0.6, 1.0);`,
      )
      // 法線を微かに揺らす。地面が幾何的に平らでも、陰影に細かい起伏が出る。
      //
      // 揺らすのは照明に使う `normal` だけで、`vWorldNormal` は触らない。
      // 傾斜の色分け・等高線・傾斜ヒートマップはそちらを見ているので、
      // 見た目の意味が変わらない。近くだけ計算する (遠くではちらつくだけ)。
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
{
  float bumpFade = 1.0 - smoothstep(90.0, 300.0, length(vWorldPos - cameraPosition));
  if (bumpFade > 0.01) {
    float e = 0.5;
    float nx = vnoise((vWorldPos.xz + vec2(e, 0.0)) / 1.9) - vnoise((vWorldPos.xz - vec2(e, 0.0)) / 1.9);
    float nz = vnoise((vWorldPos.xz + vec2(0.0, e)) / 1.9) - vnoise((vWorldPos.xz - vec2(0.0, e)) / 1.9);
    normal = normalize(normal + vec3(-nx, 0.0, -nz) * 0.7 * bumpFade);
  }
}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float slopeDeg = degrees(acos(clamp(normalize(vWorldNormal).y, -1.0, 1.0)));
  // 近くだけ細かいむらを出す。1 画素が覆う地面が広い所では、あっても
  // ちらつくだけなので、1 画素が覆う幅 (fwidth) でも落とす。
  float viewDist = length(vWorldPos - cameraPosition);
  float texel = fwidth(vWorldPos.x) + fwidth(vWorldPos.z);
  float detail = (1.0 - smoothstep(120.0, 420.0, viewDist)) * (1.0 - smoothstep(0.6, 1.6, texel));
  vec3 base = terrainColor(slopeDeg, vWorldPos.y, vWorldPos.xz, detail);
  base = mix(base, slopeHeat(slopeDeg), uSlopeHeat);

  if (uContour > 0.0) {
    float major = uContour;
    float minorStep = major / 5.0;
    float dh = fwidth(vWorldPos.y) + 1e-4;
    float fMajor = abs(fract(vWorldPos.y / major - 0.5) - 0.5) * major;
    float fMinor = abs(fract(vWorldPos.y / minorStep - 0.5) - 0.5) * minorStep;
    float lineMajor = 1.0 - smoothstep(0.0, dh * 1.5, fMajor);
    float lineMinor = 1.0 - smoothstep(0.0, dh * 1.2, fMinor);
    base = mix(base, base * 0.72, lineMinor * 0.5);
    base = mix(base, base * 0.5, lineMajor * 0.7);
  }
  diffuseColor.rgb *= base;
}`,
      );
  };
  material.customProgramCacheKey = () => 'terrain-slope';
  return material;
}

/** 路面標示など、路面のすぐ上に重ねる薄い面のマテリアル。 */
/**
 * 水面の材質。
 *
 * 頂点カラーで深さを塗り分ける。`depthWrite` を切ってあるのは、水面の下の
 * 地形や、水に架かる橋の桁が水面に隠されないようにするため。両面にするのは
 * 水中から見上げる (地下ビュー・乗車モード) ことがあるから。
 */
export function createWaterMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    roughness: 0.12,
    metalness: 0,
    depthWrite: false,
    side: DoubleSide,
  });
}

export function createOverlayMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -8,
  });
  return material;
}

/** 構造物・小物用。両面表示にしてトンネル内側も見えるようにする。 */
export function createPropMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0.05,
    side: DoubleSide,
  });
}

/** 敷設できないプレビューを赤く塗るための uniform。 */
const previewBlocked = { value: 0 };

/*
 * プレビューの濃さ。
 *
 * プレビューは 2 枚重ねで描く (`createPreviewXrayMaterial` を参照)。
 * 隠れている所は透視用の 1 枚だけなので `XRAY` の濃さで薄く透け、地表に
 * 出ている所は 2 枚が重なって
 *   xray + surface - xray * surface
 * の濃さになる。これが `VISIBLE` ちょうどになるよう上に重ねる 1 枚を
 * 逆算するので、見えている所の濃さは 1 枚だった頃と変わらない。
 */

/** 隠れている所 (透視用の 1 枚だけ) の濃さ。 */
const PREVIEW_XRAY_OPACITY = { open: 0.4, blocked: 0.52 };
/** 見えている所 (2 枚重ね) の濃さ。 */
const PREVIEW_VISIBLE_OPACITY = { open: 0.75, blocked: 0.9 };

/** 透視用の 1 枚に重ねて `visible` の濃さになる、上の 1 枚の不透明度。 */
function overlayOpacity(visible: number, xray: number): number {
  return (visible - xray) / (1 - xray);
}

const PREVIEW_OPACITY = {
  open: overlayOpacity(PREVIEW_VISIBLE_OPACITY.open, PREVIEW_XRAY_OPACITY.open),
  blocked: overlayOpacity(PREVIEW_VISIBLE_OPACITY.blocked, PREVIEW_XRAY_OPACITY.blocked),
};

/**
 * 建設プレビュー用の半透明マテリアル。規格違反がすぐ分かるよう、
 * 全体設定にかかわらず常に診断色で表示する。
 */
export function createPreviewMaterial(): MeshStandardMaterial {
  return createSurfaceMaterial({
    transparent: true,
    opacity: PREVIEW_OPACITY.open,
    depthWrite: false,
    polygonOffsetUnits: -16,
    diagnostics: { value: 1 },
    blocked: previewBlocked,
  });
}

/**
 * 隠れたプレビューを透かして出すためのマテリアル。
 *
 * 深度試験をしないので、トンネルのように地形の下へ潜る線形も、丘の陰に
 * 入った線形も必ず描かれる。`createPreviewMaterial` の面より**先に**
 * 描いて (renderOrder を小さくする)、見えている所はその上から塗り直す。
 * こうすると、地表に出ている所は今までどおりの濃さで、隠れている所だけが
 * 薄く透けて見える。裏から見ることになるので両面表示にする。
 */
export function createPreviewXrayMaterial(): MeshStandardMaterial {
  return createSurfaceMaterial({
    transparent: true,
    opacity: PREVIEW_XRAY_OPACITY.open,
    depthWrite: false,
    depthTest: false,
    polygonOffsetUnits: -16,
    side: DoubleSide,
    diagnostics: { value: 1 },
    blocked: previewBlocked,
  });
}

/**
 * 敷設できないときのプレビュー表示。
 * 診断色より優先して赤く塗るので、置けないことが一目で分かる。
 */
export function setPreviewBlocked(
  materials: { preview: MeshStandardMaterial; xray: MeshStandardMaterial },
  blocked: boolean,
): void {
  previewBlocked.value = blocked ? 1 : 0;
  materials.preview.opacity = blocked ? PREVIEW_OPACITY.blocked : PREVIEW_OPACITY.open;
  materials.xray.opacity = blocked ? PREVIEW_XRAY_OPACITY.blocked : PREVIEW_XRAY_OPACITY.open;
}
