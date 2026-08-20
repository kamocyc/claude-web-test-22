import { Vector3 } from 'three';
import { surfaceHeightScale } from '../../src/build/crossing';
import { profileFor, profilePointAt } from '../../src/build/surface';
import { SURFACE_LIFT } from '../../src/core/units';
import { selfIntersects } from '../../src/network/junction';
import { classify } from '../../src/network/structure';
import {
  drawnSampleAt,
  insidePolygonXZ,
  junctionSurfaceRing,
  polygonSurfaceY,
  ribbonEndSection,
  trianglesOf,
  verticesOf,
  type Scene,
  type Violation,
} from './adversarial';

/**
 * 交差点の見た目に関する不変条件。
 *
 * どれも「実際に描かれたもの」から測る。交差点面は描画と同じ earcut 分割で
 * 補間し、垂れ壁や構造物は `world.group` の実メッシュの頂点を見る。
 */


/**
 * トンネルの中の交差点か。
 *
 * トンネル区間では地形を切らない (地山をそのまま残す) 仕様なので、
 * 交差点面が地形より下にあるのが正しい。囲いは覆工の空洞が受け持つ
 * ので、「地形に埋まらない」「構造物が食い込まない」の検査からは外す。
 */
function inTunnel(scene: Scene, node: unknown): boolean {
  const n = scene.network.getNode(node as never);
  return classify(n.pos.y, scene.field.baseHeightAt(n.pos.x, n.pos.z)) === 'tunnel';
}

function push(
  out: Violation[],
  scene: Scene,
  amount: number,
  where: Vector3,
  what: string,
): void {
  out.push({ scene: scene.name, amount, where, what });
}

/** (1) 交差点面と、枝の帯の断面が 1 点ずつ共有されているか (継ぎ目)。 */
export function seamViolations(scene: Scene, tolerance = 0.01): Violation[] {
  const out: Violation[] = [];
  for (const [id, junction] of scene.world.junctions) {
    const ringPts: Vector3[] = [];
    for (const ring of junction.rings) {
      for (const p of ring) ringPts.push(new Vector3(p.x, p.y + SURFACE_LIFT, p.z));
    }
    const sections = junction.approaches.map((ap) =>
      ribbonEndSection(scene, ap.branch.segment, ap.branch.atStart),
    );
    if (ringPts.length > 0) {
      sections.forEach((section, i) => {
        for (const p of section) {
          let best = Infinity;
          for (const q of ringPts) best = Math.min(best, p.distanceTo(q));
          if (best > tolerance) {
            push(
              out,
              scene,
              best,
              p,
              `交差点面と帯の継ぎ目が開く: node=${id} kind=${junction.kind} seg=${junction.approaches[i].branch.segment}`,
            );
          }
        }
      });
      continue;
    }
    if (sections.length !== 2) continue;
    const [a, b] = sections;
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      const dy = Math.abs(a[i].y - b[b.length - 1 - i].y);
      if (dy > tolerance) push(out, scene, dy, a[i], `帯どうしの段差: node=${id}`);
    }
  }
  return out;
}

/** 枝の口 (トリム位置の断面) の情報。 */
interface Mouth {
  origin: Vector3;
  forward: Vector3;
  right: Vector3;
  cls: ReturnType<Scene['network']['classOf']>;
  ring: Vector3[];
  levels: number[];
  label: string;
}

function mouths(scene: Scene): Mouth[] {
  const out: Mouth[] = [];
  for (const [id, junction] of scene.world.junctions) {
    const ring = junctionSurfaceRing(junction.rings);
    if (!ring) continue;
    const levelOf = (ap: (typeof junction.approaches)[number]): number => {
      const profile = profileFor(ap.branch.cls);
      const levels = Math.max(1, profile.length >> 1);
      const range = scene.result.ranges.get(ap.branch.segment)!;
      const s = ap.branch.atStart ? range.s0 : range.s1;
      const sample = drawnSampleAt(scene, ap.branch.segment, s);
      return sample.pos.y + profile[Math.min(levels - 1, profile.length - 1)].height + SURFACE_LIFT;
    };
    const levels = junction.approaches.map(levelOf);
    for (const ap of junction.approaches) {
      const range = scene.result.ranges.get(ap.branch.segment)!;
      const s = ap.branch.atStart ? range.s0 : range.s1;
      const sample = drawnSampleAt(scene, ap.branch.segment, s);
      out.push({
        origin: sample.pos.clone(),
        forward: new Vector3(ap.dir.x, 0, ap.dir.y).normalize(),
        right: sample.right.clone(),
        cls: ap.branch.cls,
        ring,
        levels,
        label: `node=${id} kind=${junction.kind} seg=${ap.branch.segment}`,
      });
    }
  }
  return out;
}

function profileHeightAt(profile: { offset: number; height: number }[], offset: number): number {
  if (offset <= profile[0].offset) return profile[0].height;
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i];
    const b = profile[i + 1];
    if (offset <= b.offset) {
      if (b.offset - a.offset < 1e-9) return b.height;
      return a.height + ((b.height - a.height) * (offset - a.offset)) / (b.offset - a.offset);
    }
  }
  return profile[profile.length - 1].height;
}

/** (2) 枝の口を横切る立ち上がり (縁石・垂れ壁のはみ出し) が無いか。 */
export function curbAcrossMouthViolations(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const list = mouths(scene);
  if (list.length === 0) return out;
  const tris = trianglesOf(scene, 'surfaces');
  const ab = new Vector3();
  const ac = new Vector3();
  const normal = new Vector3();
  const centroid = new Vector3();
  for (const tri of tris) {
    centroid.copy(tri.a).add(tri.b).add(tri.c).divideScalar(3);
    ab.copy(tri.b).sub(tri.a);
    ac.copy(tri.c).sub(tri.a);
    normal.crossVectors(ab, ac);
    if (normal.lengthSq() < 1e-16) continue;
    normal.normalize();
    if (Math.abs(normal.y) >= 0.35) continue;
    for (const mouth of list) {
      const dx = centroid.x - mouth.origin.x;
      const dz = centroid.z - mouth.origin.z;
      if (Math.abs(dx * mouth.forward.x + dz * mouth.forward.z) > 0.35) continue;
      const lat = dx * mouth.right.x + dz * mouth.right.z;
      if (Math.abs(lat) > mouth.cls.carriagewayHalfWidth * 0.85) continue;
      const expected = mouth.origin.y + profileHeightAt(profileFor(mouth.cls), lat) + SURFACE_LIFT;
      if (Math.abs(centroid.y - expected) > 3) continue;
      const span = Math.max(tri.a.y, tri.b.y, tri.c.y) - Math.min(tri.a.y, tri.b.y, tri.c.y);
      const levelSpan = Math.max(...mouth.levels) - Math.min(...mouth.levels);
      if (span <= levelSpan + 0.02) continue;
      push(out, scene, span, centroid.clone(), `枝の口に立ち上がり: ${mouth.label}`);
      break;
    }
  }
  return out;
}

/** (3) 交差点面が枝の車道面と段差なく繋がっているか。 */
export function mouthStepViolations(scene: Scene, tolerance = 0.03): Violation[] {
  const out: Violation[] = [];
  for (const mouth of mouths(scene)) {
    const profile = profileFor(mouth.cls);
    const levels = Math.max(1, profile.length >> 1);
    const innerHeight = profile[Math.min(levels - 1, profile.length - 1)].height;
    const half = mouth.cls.carriagewayHalfWidth;
    for (let i = -4; i <= 4; i++) {
      const lat = (half * 0.85 * i) / 4;
      const x = mouth.origin.x - mouth.forward.x * 0.05 + mouth.right.x * lat;
      const z = mouth.origin.z - mouth.forward.z * 0.05 + mouth.right.z * lat;
      const surfaceY = polygonSurfaceY(mouth.ring, x, z);
      if (surfaceY === null) continue;
      const expected = mouth.origin.y + innerHeight + SURFACE_LIFT;
      const low = Math.min(expected, ...mouth.levels);
      const high = Math.max(expected, ...mouth.levels);
      const gap = Math.max(low - surfaceY, surfaceY - high);
      if (gap > tolerance) {
        push(
          out,
          scene,
          gap,
          new Vector3(x, surfaceY, z),
          `枝の口で段差: ${mouth.label} 面=${surfaceY.toFixed(3)} 枝=${expected.toFixed(3)}`,
        );
      }
    }
  }
  return out;
}

/** (4) 交差点面より上に整地後の地形が来ていないか (面が埋まる)。 */
export function junctionBuriedViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const f = scene.field;
  for (const junction of scene.world.junctions.values()) {
    if (inTunnel(scene, junction.node)) continue;
    const ring = junctionSurfaceRing(junction.rings);
    if (!ring) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of ring) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    for (let iz = Math.max(0, Math.ceil(f.toGridZ(minZ))); iz <= Math.min(f.cells, Math.floor(f.toGridZ(maxZ))); iz++) {
      for (let ix = Math.max(0, Math.ceil(f.toGridX(minX))); ix <= Math.min(f.cells, Math.floor(f.toGridX(maxX))); ix++) {
        const x = f.worldX(ix);
        const z = f.worldZ(iz);
        const surfaceY = polygonSurfaceY(ring, x, z);
        if (surfaceY === null) continue;
        const terrain = f.work[f.index(ix, iz)];
        if (terrain - surfaceY > tolerance) {
          push(
            out,
            scene,
            terrain - surfaceY,
            new Vector3(x, terrain, z),
            `交差点面が地形に埋まる: node=${junction.node} kind=${junction.kind}`,
          );
        }
      }
    }
  }
  return out;
}

/** 面メッシュの頂点索引 (垂れ壁の下端を測る)。 */
class SurfaceFloor {
  private readonly buckets = new Map<string, number[]>();
  private readonly cell = 0.25;

  constructor(scene: Scene) {
    const pos = verticesOf(scene, 'surfaces');
    for (let i = 0; i < pos.count; i++) {
      const key = `${Math.round(pos.x(i) / this.cell)},${Math.round(pos.z(i) / this.cell)}`;
      const list = this.buckets.get(key);
      if (list) list.push(pos.x(i), pos.y(i), pos.z(i));
      else this.buckets.set(key, [pos.x(i), pos.y(i), pos.z(i)]);
    }
  }

  lowestAt(x: number, z: number, radius = 0.05, ceiling = Infinity): number | null {
    let best: number | null = null;
    const cx = Math.round(x / this.cell);
    const cz = Math.round(z / this.cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.buckets.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          if (Math.abs(list[i] - x) > radius || Math.abs(list[i + 2] - z) > radius) continue;
          if (list[i + 1] > ceiling) continue;
          if (best === null || list[i + 1] < best) best = list[i + 1];
        }
      }
    }
    return best;
  }
}

/** (5) 交差点の外周・路端の垂れ壁が地形まで届いているか (穴が開かない)。 */
export function skirtGapViolations(scene: Scene, tolerance = 0.05): Violation[] {
  const out: Violation[] = [];
  const floor = new SurfaceFloor(scene);
  for (const junction of scene.world.junctions.values()) {
    const ring = junction.ring;
    if (ring.length < 3) continue;
    const node = scene.network.getNode(junction.node);
    // 橋・トンネルの上の交差点は地形を切らない (遮断する) 仕様なので除く。
    if (Math.abs(node.pos.y - scene.field.baseHeightAt(node.pos.x, node.pos.z)) > 6) continue;
    for (const p of ring) {
      const top = p.y + SURFACE_LIFT;
      const bottom = floor.lowestAt(p.x, p.z, 0.05, top + 0.05);
      if (bottom === null) continue;
      const terrain = scene.field.heightAt(p.x, p.z);
      if (bottom - terrain > tolerance) {
        push(
          out,
          scene,
          bottom - terrain,
          new Vector3(p.x, terrain, p.z),
          `交差点の外周に穴: node=${junction.node} 垂れ壁下端=${bottom.toFixed(2)} 地形=${terrain.toFixed(2)}`,
        );
      }
    }
  }
  // 路端 (地表区間) も見る。相手の舗装・道床に覆われている所は、いちばん
  // 低い頂点が相手の面になるので外す (踏切のまわり)。
  const covered = footprints(scene);
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const edge = profileFor(cls)[0];
    for (const run of scene.result.structures.get(seg.id) ?? []) {
      if (run.mode !== 'ground') continue;
      for (let s = run.s0 + 4; s <= run.s1 - 4; s += 1) {
        const sample = drawnSampleAt(scene, seg.id, s);
        const scale = surfaceHeightScale(scene.result.blends.get(seg.id) ?? [], s);
        for (const side of [-1, 1]) {
          const p = profilePointAt(
            sample,
            side * Math.abs(edge.offset),
            edge.height * scale,
            new Vector3(),
          );
          if (covered(seg.id, p.x, p.z, p.y)) continue;
          const bottom = floor.lowestAt(p.x, p.z, 0.15, p.y + 0.05);
          if (bottom === null) continue;
          const terrain = scene.field.heightAt(p.x, p.z);
          if (bottom - terrain > tolerance) {
            push(
              out,
              scene,
              bottom - terrain,
              new Vector3(p.x, terrain, p.z),
              `路端に穴: seg=${seg.id} s=${s.toFixed(1)} 下端=${bottom.toFixed(2)} 地形=${terrain.toFixed(2)}`,
            );
          }
        }
      }
    }
  }
  return out;
}


/**
 * 「その点が別の線形の舗装 (道床) に覆われているか」を返す関数を作る。
 *
 * 踏切のように 2 つの帯が重なる所では、いちばん低い頂点が相手の面になり、
 * 垂れ壁の下端を測ったつもりが別のものを測ってしまう。
 */
function footprints(scene: Scene): (own: string | number, x: number, z: number, y: number) => boolean {
  const lines: { id: string | number; half: number; pts: Vector3[] }[] = [];
  for (const seg of scene.network.segments.values()) {
    const cls = scene.network.classOf(seg);
    const alignment = scene.network.alignmentOf(seg.id);
    const range = scene.result.ranges.get(seg.id);
    if (!range) continue;
    const pts: Vector3[] = [];
    const n = Math.max(2, Math.ceil((range.s1 - range.s0) / 2));
    for (let i = 0; i <= n; i++) {
      pts.push(alignment.sampleAt(range.s0 + ((range.s1 - range.s0) * i) / n).pos.clone());
    }
    lines.push({ id: seg.id, half: cls.halfWidth + 0.6, pts });
  }
  return (own, x, z, y) => {
    for (const line of lines) {
      if (line.id === own) continue;
      for (const p of line.pts) {
        if (Math.abs(p.y - y) > 3) continue;
        if ((p.x - x) ** 2 + (p.z - z) ** 2 <= line.half * line.half) return true;
      }
    }
    return false;
  };
}

/**
 * (6) 交差点の面の上に、橋・トンネルの構造物が食い込んでいないか。
 *
 * 交差点の車道面の真上 (建築限界 = 路面から 4.5 m) に橋脚・橋台・坑門の
 * 頂点があると、交差点が構造物に隠れて通れなくなる。
 */
export function structureIntrusionViolations(scene: Scene, clearance = 4.5): Violation[] {
  const out: Violation[] = [];
  const rings: { ring: Vector3[]; node: string }[] = [];
  for (const junction of scene.world.junctions.values()) {
    // 線路の分岐器はレール・枕木が面の上に出るのが正しいので見ない。
    if (junction.approaches.some((ap) => ap.branch.cls.kind !== 'road')) continue;
    // トンネルの中の交差点は覆工そのものが面を囲うので見ない (坑口の
    // 坑門が交差点に食い込まないことは、専用の検査で見る)。
    if (inTunnel(scene, junction.node)) continue;
    const ring = junctionSurfaceRing(junction.rings);
    if (ring) rings.push({ ring, node: String(junction.node) });
  }
  if (rings.length === 0) return out;
  const pos = verticesOf(scene, 'structures');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.x(i);
    const y = pos.y(i);
    const z = pos.z(i);
    for (const { ring, node } of rings) {
      if (!insidePolygonXZ(ring, x, z)) continue;
      const surfaceY = polygonSurfaceY(ring, x, z);
      if (surfaceY === null) continue;
      if (y <= surfaceY - 0.05 || y >= surfaceY + clearance) continue;
      push(
        out,
        scene,
        Math.min(y - surfaceY, surfaceY + clearance - y),
        new Vector3(x, y, z),
        `交差点の建築限界に構造物: node=${node} 面=${surfaceY.toFixed(2)} 構造物=${y.toFixed(2)}`,
      );
      break;
    }
  }
  return out;
}

/** (7) 交差点のリングが自己交差していないか (ねじれ)。警告があるものは除く。 */
export function ringShapeViolations(scene: Scene): Violation[] {
  const out: Violation[] = [];
  for (const junction of scene.world.junctions.values()) {
    if (junction.ring.length < 3) continue;
    if (junction.warnings.length > 0) continue; // 警告つきは「形が乱れる」と伝えている
    if (selfIntersects(junction.ring)) {
      push(
        out,
        scene,
        1,
        junction.ring[0].clone(),
        `交差点のリングがねじれている (警告なし): node=${junction.node} kind=${junction.kind}`,
      );
    }
    for (const ring of junction.rings) {
      if (ring.length !== junction.ring.length) {
        push(
          out,
          scene,
          Math.abs(ring.length - junction.ring.length),
          junction.ring[0].clone(),
          `リングの点数が揃っていない: node=${junction.node}`,
        );
      }
    }
  }
  return out;
}

/**
 * (8) 別々の交差点の面どうしが重なっていないか。
 *
 * 交差点が近すぎると 2 つの面が同じ場所に描かれ、z 争いや段差になる。
 */
export function junctionOverlapViolations(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const list: { ring: Vector3[]; node: string }[] = [];
  for (const junction of scene.world.junctions.values()) {
    const ring = junctionSurfaceRing(junction.rings);
    if (ring) list.push({ ring, node: String(junction.node) });
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (const p of list[j].ring) {
        if (!insidePolygonXZ(list[i].ring, p.x, p.z)) continue;
        const y = polygonSurfaceY(list[i].ring, p.x, p.z);
        if (y === null || Math.abs(y - p.y) > 3) continue;
        push(
          out,
          scene,
          1,
          p.clone(),
          `交差点面どうしが重なる: node=${list[i].node} と node=${list[j].node}`,
        );
        break;
      }
    }
  }
  return out;
}

/**
 * (9) 交差点の面の中に小物 (信号機・標識・遮断機・柱) が立っていないか。
 *
 * 面の中に立つと、車が通る所に柱が立っていることになる。
 */
export function propInJunctionViolations(scene: Scene): Violation[] {
  const out: Violation[] = [];
  const rings: { ring: Vector3[]; node: string }[] = [];
  for (const junction of scene.world.junctions.values()) {
    const ring = junctionSurfaceRing(junction.rings);
    if (ring) rings.push({ ring, node: String(junction.node) });
  }
  for (const prop of scene.result.props) {
    for (const { ring, node } of rings) {
      if (!insidePolygonXZ(ring, prop.position.x, prop.position.z)) continue;
      const surfaceY = polygonSurfaceY(ring, prop.position.x, prop.position.z);
      // 立体交差で下をくぐる交差点の上に立っている柱は別物。
      if (surfaceY === null || Math.abs(prop.position.y - surfaceY) > 2) continue;
      push(
        out,
        scene,
        1,
        prop.position.clone(),
        `交差点の面の中に小物: kind=${prop.kind} node=${node}`,
      );
      break;
    }
  }
  return out;
}
