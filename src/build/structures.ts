import { Vector3 } from 'three';
import type { Alignment, AlignmentSample } from '../core/alignment';
import { extrudeSkirt, fillPolygon, type MeshBuilder } from '../core/meshbuilder';
import { DECK_THICKNESS, SURFACE_LIFT } from '../core/units';
import type { NetworkClass } from '../network/classes';
import type { Heightfield } from '../terrain/heightfield';
import { addBox, addTube } from './primitives';
import type { RGB } from './surface';
import { interpolateSample } from './rail';

const CONCRETE: RGB = [0.62, 0.61, 0.59];
const CONCRETE_DARK: RGB = [0.46, 0.45, 0.44];
const GIRDER: RGB = [0.52, 0.53, 0.55];
const LINING: RGB = [0.55, 0.55, 0.54];
const PARAPET: RGB = [0.7, 0.69, 0.67];

const UP = new Vector3(0, 1, 0);

/** 橋脚を建てる間隔 [m]。 */
const PIER_PITCH = 26;
/** これ以下の桁下高さでは橋脚を省く (橋台で足りるため)。 */
const MIN_PIER_HEIGHT = 2.0;

/**
 * 断面が一定の閉じた角柱を線形に沿って掃引する。
 * 橋桁・高欄・トンネル側壁など、直方体断面の構造物に使う。
 */
function sweepBox(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  offset: number,
  halfWidth: number,
  yTop: number,
  yBottom: number,
  color: RGB,
): void {
  if (samples.length < 2) return;
  const sections = samples.map((sample) => {
    const cx = sample.pos.x + sample.right.x * offset;
    const cz = sample.pos.z + sample.right.z * offset;
    const rx = sample.right.x * halfWidth;
    const rz = sample.right.z * halfWidth;
    const top = sample.pos.y + yTop;
    const bottom = sample.pos.y + yBottom;
    return [
      new Vector3(cx - rx, top, cz - rz),
      new Vector3(cx + rx, top, cz + rz),
      new Vector3(cx + rx, bottom, cz + rz),
      new Vector3(cx - rx, bottom, cz - rz),
    ];
  });
  addTube(mb, sections, color, true);
}

/**
 * 高架区間の下部構造を作る。
 * 路面自体は地表区間と同じ帯として別に描かれるので、ここでは桁・高欄・
 * 橋脚・橋台だけを担当する。
 */
export function buildBridge(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  field: Heightfield,
): void {
  if (samples.length < 2) return;
  const hw = cls.halfWidth;
  const deckTop = SURFACE_LIFT - 0.15;
  const deckBottom = SURFACE_LIFT - DECK_THICKNESS;

  // 主桁。路面より一回り細くして、路肩が張り出して見えるようにする。
  sweepBox(mb, samples, 0, hw * 0.78, deckTop, deckBottom, GIRDER);
  // 床版 (路面直下の薄い版)。
  sweepBox(mb, samples, 0, hw, deckTop, deckTop - 0.25, CONCRETE_DARK);

  // 高欄。道路では歩道の外側、線路では道床の外側に立てる。
  const parapetHeight = cls.kind === 'rail' ? 0.75 : 0.95;
  const parapetBase = cls.kind === 'rail' ? -0.85 : cls.curbHeight;
  for (const side of [-1, 1]) {
    sweepBox(
      mb,
      samples,
      side * (hw - 0.15),
      0.15,
      parapetBase + parapetHeight,
      parapetBase - 0.1,
      PARAPET,
    );
  }

  buildPiers(mb, samples, cls, field, deckBottom);
  buildAbutment(mb, samples[0], cls, field, deckBottom, 1);
  buildAbutment(mb, samples[samples.length - 1], cls, field, deckBottom, -1);
}

function buildPiers(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  field: Heightfield,
  deckBottom: number,
): void {
  const s0 = samples[0].s;
  const s1 = samples[samples.length - 1].s;
  const span = s1 - s0;
  // 両端の橋台の内側に、等間隔で橋脚を配る。
  const count = Math.max(0, Math.round(span / PIER_PITCH) - 1);
  for (let i = 1; i <= count; i++) {
    const s = s0 + (span * i) / (count + 1);
    const sample = interpolateSample(samples, s);
    if (!sample) continue;
    const ground = field.baseHeightAt(sample.pos.x, sample.pos.z);
    const top = sample.pos.y + deckBottom;
    const height = top - ground;
    if (height < MIN_PIER_HEIGHT) continue;

    const thickness = Math.min(1.4, 0.5 + height * 0.05);
    addBox(
      mb,
      new Vector3(sample.pos.x, (top + ground - 1.2) / 2, sample.pos.z),
      sample.right,
      UP,
      sample.forward,
      { x: cls.halfWidth * 0.42, y: (height + 1.2) / 2, z: thickness },
      CONCRETE,
    );
    // フーチング。地面に少し埋まるようにして浮いて見えないようにする。
    addBox(
      mb,
      new Vector3(sample.pos.x, ground - 0.6, sample.pos.z),
      sample.right,
      UP,
      sample.forward,
      { x: cls.halfWidth * 0.55, y: 0.9, z: thickness + 0.8 },
      CONCRETE_DARK,
    );
  }
}

/**
 * 橋台。整地は橋の footprint で遮断されるので、ここに地形の段差ができる。
 * その段差を覆うように壁を建てて、盛土と桁の間を塞ぐ。
 */
function buildAbutment(
  mb: MeshBuilder,
  sample: AlignmentSample,
  cls: NetworkClass,
  field: Heightfield,
  deckBottom: number,
  inward: number,
): void {
  const ground = field.baseHeightAt(sample.pos.x, sample.pos.z);
  const top = sample.pos.y + deckBottom + 0.2;
  const bottom = Math.min(ground, sample.pos.y - 12) - 1.0;
  const height = top - bottom;
  if (height <= 0.2) return;

  const center = new Vector3(
    sample.pos.x - sample.forward.x * inward * 0.9,
    (top + bottom) / 2,
    sample.pos.z - sample.forward.z * inward * 0.9,
  );
  addBox(
    mb,
    center,
    sample.right,
    UP,
    sample.forward,
    { x: cls.halfWidth + 0.6, y: height / 2, z: 0.9 },
    CONCRETE,
  );
}

/**
 * 高い所にある交差点の床版。
 *
 * 交差点面はセグメントと違って構造物を持たないので、立体交差の上に交差点を
 * 作ると路面だけが宙に浮いて見える。リングを下へ押し出して桁の側面と底面を
 * 作り、必要なら中央に橋脚を建てる。
 */
export function buildJunctionDeck(
  mb: MeshBuilder,
  ring: Vector3[],
  cls: NetworkClass,
  field: Heightfield,
): void {
  if (ring.length < 3) return;
  const top = ring.map((p) => new Vector3(p.x, p.y + SURFACE_LIFT - 0.15, p.z));
  extrudeSkirt(mb, top, DECK_THICKNESS, GIRDER);
  fillPolygon(
    mb,
    top.map((p) => new Vector3(p.x, p.y - DECK_THICKNESS, p.z)),
    CONCRETE_DARK,
    0.1,
    0,
    true,
  );

  const centre = new Vector3();
  for (const p of top) centre.add(p);
  centre.divideScalar(top.length);
  const ground = field.baseHeightAt(centre.x, centre.z);
  const bottom = centre.y - DECK_THICKNESS;
  const height = bottom - ground;
  if (height < MIN_PIER_HEIGHT) return;

  const thickness = Math.min(1.6, 0.6 + height * 0.05);
  addBox(
    mb,
    new Vector3(centre.x, (bottom + ground - 1.2) / 2, centre.z),
    AXIS_X,
    UP,
    AXIS_Z,
    { x: cls.halfWidth * 0.4, y: (height + 1.2) / 2, z: thickness },
    CONCRETE,
  );
  addBox(
    mb,
    new Vector3(centre.x, ground - 0.6, centre.z),
    AXIS_X,
    UP,
    AXIS_Z,
    { x: cls.halfWidth * 0.5, y: 0.9, z: thickness + 0.8 },
    CONCRETE_DARK,
  );
}

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Z = new Vector3(0, 0, 1);

/** トンネル断面の内空 (アーチ) の断面点を返す。 */
function tunnelSection(cls: NetworkClass): { offset: number; height: number }[] {
  const w = cls.carriagewayHalfWidth + (cls.kind === 'rail' ? 1.3 : 0.9);
  const wallTop = cls.kind === 'rail' ? 4.4 : 3.4;
  const crown = cls.kind === 'rail' ? 6.4 : 5.4;
  const pts: { offset: number; height: number }[] = [
    { offset: -w, height: -0.4 },
    { offset: -w, height: wallTop },
  ];
  const steps = 6;
  for (let i = 1; i < steps; i++) {
    const a = Math.PI * (1 - i / steps);
    pts.push({ offset: Math.cos(a) * w, height: wallTop + Math.sin(a) * (crown - wallTop) });
  }
  pts.push({ offset: w, height: wallTop });
  pts.push({ offset: w, height: -0.4 });
  return pts;
}

/**
 * トンネル区間を作る。覆工 (内空面) と、坑口の門型の壁を建てる。
 *
 * 坑口では整地が遮断されて地形が垂直に切り立つので、その面を隠すように
 * 前面の壁を地山の高さまで立ち上げる。
 */
export function buildTunnel(
  mb: MeshBuilder,
  samples: AlignmentSample[],
  cls: NetworkClass,
  field: Heightfield,
): void {
  if (samples.length < 2) return;
  const section = tunnelSection(cls);

  const sections = samples.map((sample) =>
    section.map(
      (p) =>
        new Vector3(
          sample.pos.x + sample.right.x * p.offset,
          sample.pos.y + p.height,
          sample.pos.z + sample.right.z * p.offset,
        ),
    ),
  );
  addTube(mb, sections, LINING, false);

  buildPortal(mb, samples[0], field, section);
  buildPortal(mb, samples[samples.length - 1], field, section);
}

/** 坑門 (ポータル)。左右の柱と上の梁で開口を作る。 */
function buildPortal(
  mb: MeshBuilder,
  sample: AlignmentSample,
  field: Heightfield,
  section: { offset: number; height: number }[],
): void {
  const openingHalf = Math.max(...section.map((p) => p.offset));
  const crown = Math.max(...section.map((p) => p.height));
  const bottom = sample.pos.y - 2.5;
  const pillarHalf = 1.1;

  /**
   * 坑門は地山の切り立った面を塞ぐためのもの。
   * 土被りが深い所 (長いトンネルの途中でセグメントが分かれた所など) では
   * 坑門そのものが地中にあるので、地表より高く立ち上げてはいけない。
   * そうしないと、山の斜面から壁だけが飛び出して見える。
   * 斜面では左右で地面の高さが違うので、柱ごとに足元の地面を見る。
   */
  const topAt = (x: number, z: number): number => {
    const ground = Math.min(field.baseHeightAt(x, z), field.heightAt(x, z));
    const exposed = sample.pos.y + crown + 1.4;
    return ground > exposed ? Math.max(exposed, ground - 0.4) : Math.max(ground + 1.6, exposed);
  };

  let lowestTop = Infinity;
  for (const side of [-1, 1]) {
    const x = sample.pos.x + sample.right.x * side * (openingHalf + pillarHalf);
    const z = sample.pos.z + sample.right.z * side * (openingHalf + pillarHalf);
    const wallTop = topAt(x, z);
    lowestTop = Math.min(lowestTop, wallTop);
    if (wallTop <= bottom + 0.2) continue;
    addBox(
      mb,
      new Vector3(x, (wallTop + bottom) / 2, z),
      sample.right,
      UP,
      sample.forward,
      { x: pillarHalf, y: (wallTop - bottom) / 2, z: 0.7 },
      CONCRETE,
    );
  }

  const lintelBottom = sample.pos.y + crown;
  const lintelTop = Math.min(lowestTop, topAt(sample.pos.x, sample.pos.z));
  if (lintelTop > lintelBottom) {
    addBox(
      mb,
      new Vector3(sample.pos.x, (lintelTop + lintelBottom) / 2, sample.pos.z),
      sample.right,
      UP,
      sample.forward,
      { x: openingHalf + pillarHalf * 2, y: (lintelTop - lintelBottom) / 2, z: 0.7 },
      CONCRETE,
    );
  }
}

/** 橋・トンネルの footprint (整地を遮断する範囲)。 */
export function structureFootprintHalfWidth(cls: NetworkClass, mode: 'bridge' | 'tunnel'): number {
  return mode === 'tunnel' ? cls.halfWidth + 12 : cls.halfWidth + 3;
}

export function alignmentSamplesInRange(
  alignment: Alignment,
  s0: number,
  s1: number,
  spacing = 2.5,
): AlignmentSample[] {
  const out: AlignmentSample[] = [];
  const span = s1 - s0;
  if (span <= 1e-3) return out;
  const n = Math.max(1, Math.ceil(span / spacing));
  for (let i = 0; i <= n; i++) out.push(alignment.sampleAt(s0 + (span * i) / n));
  return out;
}
