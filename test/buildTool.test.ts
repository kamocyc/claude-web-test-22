import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Mesh } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { SnapView } from '../src/render/snapView';
import { Network } from '../src/network/network';
import { Vector2, MeshBasicMaterial, type MeshStandardMaterial } from 'three';
import { getClass } from '../src/network/classes';
import { anchorFromNode, computePlacement, placeSegment } from '../src/network/editing';
import { formatRadius } from '../src/app/inspect';
import { buildDemoNetwork } from '../src/app/demo';
import { WorldBuilder } from '../src/render/worldBuilder';
import { DEFAULT_TERRAIN, generateTerrain } from '../src/terrain/generator';
import { TerrainMesh } from '../src/terrain/terrainMesh';
import { Heightfield } from '../src/terrain/heightfield';
import { testField } from './support/field';
import { stationOf } from '../src/network/parallel';
import { junctionReach } from '../src/network/rules';
import { DEG } from '../src/core/units';

/**
 * 敷設ツールの操作。
 *
 * 「どこを指すとどこに繋がるか」は、規則の判定と同じくらい大事な所。
 * ここでは平らな地形の上で、カーソル位置からクリックまでを実際に通す。
 */

function flatField(y = 0): Heightfield {
  const field = testField();
  field.base.fill(y);
  field.resetWork();
  return field;
}

const MODS = { straight: true, noSnap: false };

/** カーソルを置いてクリックする。 */
function clickAt(tool: BuildTool, x: number, z: number): void {
  tool.update(new Vector3(x, 0, z), MODS);
  tool.click();
}

/** 東西の道路と、原点から北へ伸びる道路 (T 字) を作る。 */
function tJunction(parallelSnap = false): { tool: BuildTool; network: Network } {
  const network = new Network();
  const tool = new BuildTool(network, flatField(), () => {});
  tool.setClass('road_medium');
  tool.setParallelSnap(parallelSnap);
  clickAt(tool, -150, 0);
  clickAt(tool, 150, 0);
  tool.cancel();
  clickAt(tool, 0, 0);
  clickAt(tool, 0, 120);
  tool.cancel();
  return { tool, network };
}

/** 原点のノード。 */
function junctionNode(network: Network) {
  return [...network.nodes.values()].find((n) => Math.hypot(n.pos.x, n.pos.z) < 1)!;
}

describe('敷設ツール', () => {
  it('T 字ができている', () => {
    const { network } = tJunction();
    expect(network.branchesAt(junctionNode(network).id).length).toBe(3);
  });

  describe('T 字路を十字路にする', () => {
    /**
     * 交差点の面の中で既存の線形を分割しても、交差点の形が保てない
     * (必ず「交差点が近すぎます」になる)。面の中を指したときは、その
     * 交差点のノードに繋ぐ。
     */
    for (const [name, x, z] of [
      ['交差点の真上', 0, 0],
      ['交差点の面の中 (東側の枝の上)', 4, 0],
      ['交差点の面の中 (北側の枝の上)', 0, 5],
      ['交差点の面の中 (枝の間)', 3, 3],
    ] as [string, number, number][]) {
      it(`${name}を指すと交差点に繋がる`, () => {
        const { tool, network } = tJunction();
        const before = network.nodes.size;
        const node = junctionNode(network);
        tool.update(new Vector3(x, 0, z), MODS);
        expect(tool.status().snap).toBe('node');
        tool.click();
        tool.update(new Vector3(0, 0, -120), MODS);
        expect(tool.status().blockers).toEqual([]);
        tool.click();
        // 交差点が 4 枝になり、余計なノードは増えていない。
        expect(network.branchesAt(node.id).length).toBe(4);
        expect(network.nodes.size).toBe(before + 1);
      });
    }

    it('編集を続けたまま引いても同じ十字路になる', () => {
      // 北から引いてきて交差点に取り付き、そのまま南へ続ける。
      const network = new Network();
      const tool = new BuildTool(network, flatField(), () => {});
      tool.setClass('road_medium');
      tool.setParallelSnap(false);
      clickAt(tool, -150, 0);
      clickAt(tool, 150, 0);
      tool.cancel();
      clickAt(tool, 0, 120);
      clickAt(tool, 0, 0); // T 字ができる
      const node = junctionNode(network);
      expect(network.branchesAt(node.id).length).toBe(3);
      // 解除せずにそのまま南へ。
      tool.update(new Vector3(0, 0, -120), MODS);
      expect(tool.status().blockers).toEqual([]);
      tool.click();
      expect(network.branchesAt(node.id).length).toBe(4);
    });

    it('取り付いた直後でも、続きの向きに縛られずに引ける', () => {
      // 北から交差点に取り付き、そのまま北東へ (曲線モード)。続きの接線を
      // 引き継ぐと、南向きから北東へ回る急な曲線になって置けなくなる。
      const network = new Network();
      const tool = new BuildTool(network, flatField(), () => {});
      tool.setClass('road_medium');
      tool.setParallelSnap(false);
      clickAt(tool, -150, 0);
      clickAt(tool, 150, 0);
      tool.cancel();
      clickAt(tool, 0, 120);
      clickAt(tool, 0, 0);
      const curve = { straight: false, noSnap: false };
      tool.update(new Vector3(120, 0, 120), curve);
      // 一度やめて交差点を指し直した場合と同じであること。
      const continued = tool.status();
      tool.cancel();
      tool.update(new Vector3(0, 0, 0), curve);
      tool.click();
      tool.update(new Vector3(120, 0, 120), curve);
      const restarted = tool.status();
      expect(continued.blockers).toEqual([]);
      expect(continued.blockers).toEqual(restarted.blockers);
      expect(continued.length).toBeCloseTo(restarted.length, 3);
      expect(continued.radius).toBeCloseTo(restarted.radius, 3);
    });

    it('交差点の面の中でも、種別が違えばそのまま交差する (踏切・立体交差)', () => {
      const { tool, network } = tJunction();
      tool.setClass('rail_single');
      tool.update(new Vector3(4, 0, 0), MODS);
      // 線路を道路の交差点に繋いではいけない。
      expect(tool.status().snap).not.toBe('node');
      void network;
    });

    it('交差点から離れた所では、今までどおり既存の線形を分割して取り付く', () => {
      const { tool, network } = tJunction();
      const before = network.nodes.size;
      tool.update(new Vector3(80, 0, 0), MODS);
      expect(tool.status().snap).toBe('segment');
      tool.click();
      tool.update(new Vector3(80, 0, -120), MODS);
      expect(tool.status().blockers).toEqual([]);
      tool.click();
      // 分割で 1 つ、終点で 1 つ増える。
      expect(network.nodes.size).toBe(before + 2);
    });
  });
});

/**
 * スナップの表示。
 *
 * 「吸い付いているかどうか」は線形の形からは読み取れない。吸い付いた点に
 * 目印を出し、平行なら基準の線形もなぞる。
 */
describe('スナップの目印', () => {
  it('交差点に吸い付くと、その面の広さの輪が出る', () => {
    const { tool, network } = tJunction();
    tool.update(new Vector3(4, 0, 0), MODS);
    const [marker, ...rest] = tool.status().markers;
    expect(rest).toEqual([]);
    expect(marker.kind).toBe('node');
    const node = junctionNode(network);
    expect(marker.pos.distanceTo(node.pos)).toBeLessThan(0.01);
    // 交差点の面 (取り付き部 + 隅の丸め) を覆う大きさ。
    expect(marker.radius).toBeGreaterThan(9);
  });

  it('既存の線形に取り付くときは、分割する位置に横棒が出る', () => {
    const { tool } = tJunction();
    tool.update(new Vector3(80, 0, 0), MODS);
    const [marker] = tool.status().markers;
    expect(marker.kind).toBe('segment');
    expect(marker.pos.x).toBeCloseTo(80, 0);
    // 相手の舗装を横切る長さ (幹線道路の半幅 8.9 m 以上)。
    expect(marker.bar?.length() ?? 0).toBeGreaterThan(8.9);
    // 棒は相手の線形と直交する (ここでは東西の道路なので南北向き)。
    expect(Math.abs(marker.bar?.x ?? 1)).toBeLessThan(0.01);
  });

  it('平行に敷いている間は、基準の線形をなぞって間隔を示す', () => {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('rail_single');
    tool.setParallelSnap(true);
    clickAt(tool, -150, 0);
    clickAt(tool, 150, 0);
    tool.cancel();
    // 1 本目の隣から引き始める。
    const gap = 4.6; // parallelSpacing(rail_single)
    tool.update(new Vector3(-120, 0, gap), MODS);
    expect(tool.status().snap).toBe('parallel');
    tool.click();
    tool.update(new Vector3(60, 0, gap), MODS);
    const status = tool.status();
    expect(status.snap).toBe('parallel');
    const marker = status.markers.find((m) => m.kind === 'parallel');
    expect(marker).toBeDefined();
    // 基準の線形をなぞる線と、間隔を示す渡り線。
    expect((marker?.guide ?? []).length).toBeGreaterThan(10);
    expect(marker?.tie).toBeDefined();
    const [from, to] = marker!.tie!;
    expect(Math.hypot(from.x - to.x, from.z - to.z)).toBeCloseTo(gap, 1);
    expect(status.blockers).toEqual([]);
  });

  it('引き始めた点の目印は、引いている間ずっと出る', () => {
    const { tool } = tJunction();
    tool.update(new Vector3(0, 0, 0), MODS);
    tool.click();
    tool.update(new Vector3(-60, 0, -60), MODS);
    const markers = tool.status().markers;
    expect(markers.length).toBe(1);
    expect(markers[0].fixed).toBe(true);
    expect(markers[0].kind).toBe('node');
    // やめれば消える。
    tool.cancel();
    tool.update(new Vector3(-60, 0, -60), MODS);
    expect(tool.status().markers).toEqual([]);
  });

  it('撤去モードでは目印を出さない', () => {
    const { tool } = tJunction();
    tool.setMode('bulldoze');
    tool.update(new Vector3(0, 0, 0), MODS);
    expect(tool.status().markers).toEqual([]);
  });
});

describe('高さで選ぶスナップ', () => {
  /**
   * 東西の道路 (地表) と、その上を南北に跨ぐ高架。平面で見ると 2 本は
   * 交差点で重なるので、「どちらに吸い付くか」は高さでしか決められない。
   */
  function overpass(): { tool: BuildTool; network: Network; ground: number; bridge: number } {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('road_medium');
    tool.setParallelSnap(false);
    clickAt(tool, -150, 0);
    clickAt(tool, 150, 0);
    tool.cancel();
    const ground = [...network.segments.keys()][0];
    // 高さ設定を +12 m にして南北に跨ぐ。
    tool.adjustElevation(4);
    clickAt(tool, 0, -150);
    clickAt(tool, 0, 150);
    tool.cancel();
    tool.adjustElevation(-4);
    const bridge = [...network.segments.keys()].find((id) => id !== ground)!;
    return { tool, network, ground, bridge };
  }

  /** カーソルの高さを指定して指す。 */
  function point(tool: BuildTool, x: number, y: number, z: number): void {
    tool.update(new Vector3(x, y, z), MODS);
  }

  it('高架の真下 (地表) を指しても、頭上の高架には吸い付かない', () => {
    const { tool } = overpass();
    point(tool, 0, 0, -40);
    expect(tool.status().snap).toBe('none');
  });

  it('高さ設定を高架に合わせれば、その高架に吸い付く', () => {
    const { tool } = overpass();
    tool.adjustElevation(4);
    point(tool, 0, 0, -40);
    expect(tool.status().snap).toBe('segment');
  });

  it('カーソルが高架に当たっていれば、高さ設定によらずその高架に吸い付く', () => {
    const { tool } = overpass();
    // 路面に当たったカーソル (地形より 12 m 高い)。
    point(tool, 0, 12, -40);
    expect(tool.status().snap).toBe('segment');
  });

  it('地表の道路にはこれまでどおり取り付く', () => {
    const { tool } = overpass();
    point(tool, 60, 0, 0);
    expect(tool.status().snap).toBe('segment');
  });

  it('撤去モードでも、指した高さのものを選ぶ', () => {
    const { tool, ground, bridge } = overpass();
    tool.setMode('bulldoze');
    // 高架の真下 (平面では高架の方が近い) でも、地表を指せば地表の道路。
    point(tool, 0, 0, 10);
    expect(tool.status().hoverSegment).toBe(ground);
    // 高架の路面を指せば高架。
    point(tool, 0, 12, 10);
    expect(tool.status().hoverSegment).toBe(bridge);
  });
});

describe('地形に隠れたプレビュー', () => {
  /** 地下へ 1 段下げた線路を引きかけの状態にする。 */
  function underground(): BuildTool {
    const network = new Network();
    const tool = new BuildTool(network, flatField(10), () => {});
    tool.setClass('rail_single');
    tool.setParallelSnap(false);
    // 地表 (標高 10 m) より下を通す。
    tool.adjustElevation(-2);
    clickAt(tool, -60, 0);
    tool.update(new Vector3(60, 0, 0), MODS);
    return tool;
  }

  function meshes(tool: BuildTool): { surface: Mesh; xray: Mesh } {
    return {
      surface: tool.previewGroup.getObjectByName('preview-surface') as Mesh,
      xray: tool.previewGroup.getObjectByName('preview-xray') as Mesh,
    };
  }

  it('地形の下でも見えるよう、深度試験なしの面を重ねて描く', () => {
    const { surface, xray } = meshes(underground());
    const material = xray.material as MeshStandardMaterial;
    // 深度試験をしないので、地形やその他の物に隠れても必ず描かれる。
    expect(material.depthTest).toBe(false);
    expect(material.transparent).toBe(true);
    // 地表に出ている所は本体が上から塗り直せるよう、先に描く。
    expect(xray.renderOrder).toBeLessThan(surface.renderOrder);
    expect((surface.material as MeshStandardMaterial).depthTest).toBe(true);
  });

  it('透ける面は本体と同じ形 (プレビューが二重にずれない)', () => {
    const tool = underground();
    const { surface, xray } = meshes(tool);
    expect(surface.geometry.getAttribute('position').count).toBeGreaterThan(0);
    expect(xray.geometry).toBe(surface.geometry);

    // 引き直しても同じ形を指したままにする。
    tool.update(new Vector3(40, 0, 30), MODS);
    expect(xray.geometry).toBe(surface.geometry);
  });

  it('置けないときは本体も透ける面も赤く濃くなる', () => {
    const tool = underground();
    const { surface, xray } = meshes(tool);
    const open = {
      surface: (surface.material as MeshStandardMaterial).opacity,
      xray: (xray.material as MeshStandardMaterial).opacity,
    };
    // 短い区間で一気に持ち上げると、最大勾配を超えて置けなくなる。
    tool.adjustElevation(20);
    tool.update(new Vector3(-40, 0, 0), MODS);
    expect(tool.status().blockers.length).toBeGreaterThan(0);
    expect((surface.material as MeshStandardMaterial).opacity).toBeGreaterThan(open.surface);
    expect((xray.material as MeshStandardMaterial).opacity).toBeGreaterThan(open.xray);
  });
});

describe('引いてきた道の上への折り返し', () => {
  /** 東西の道路を 1 本引いて、終点に居る (続きを引ける) 状態にする。 */
  function drawn(mods = MODS): { tool: BuildTool; network: Network } {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('road_medium');
    tool.setParallelSnap(false);
    tool.update(new Vector3(0, 0, 0), mods);
    tool.click();
    tool.update(new Vector3(150, 0, 0), mods);
    tool.click();
    return { tool, network };
  }

  /**
   * 終点から 180° 反対 (引いてきた道の上) を指した場合。接線に接して
   * 真後ろを通る円弧は無いので、線形の解が直線に潰れて、道の上に道を
   * 重ねられてしまっていた。
   */
  for (const x of [120, 100, 40, 5]) {
    it(`終点から x=${x} (引いてきた道の上) は置けない`, () => {
      const { tool } = drawn();
      tool.update(new Vector3(x, 0, 0), MODS);
      expect(tool.status().blockers.join(' ')).toContain('折り返');
    });
  }

  it('一度やめて端点を指し直しても同じ (折り返せない)', () => {
    const { tool, network } = drawn();
    tool.cancel();
    const before = network.segments.size;
    tool.update(new Vector3(150, 0, 0), MODS);
    expect(tool.status().snap).toBe('node');
    tool.click();
    tool.update(new Vector3(60, 0, 0), MODS);
    expect(tool.status().blockers.join(' ')).toContain('折り返');
    tool.click();
    expect(network.segments.size).toBe(before);
  });

  /** 東西に一定の勾配で下る地形。 */
  function slopedField(dropPerMetre = 0.05): Heightfield {
    const field = testField();
    for (let iz = 0; iz <= field.cells; iz++) {
      for (let ix = 0; ix <= field.cells; ix++) {
        field.base[field.index(ix, iz)] = 200 - field.worldX(ix) * dropPerMetre;
      }
    }
    field.resetWork();
    return field;
  }

  it('届いた所の高さは、その真下の地形で決める (カーソルの下ではない)', () => {
    // カーソルと、線形が実際に届く所は何百 m も離れる。カーソルの下の
    // 高さをそのまま使うと、届いた所が勝手に築堤やトンネルになる。
    const field = slopedField();
    const network = new Network();
    const tool = new BuildTool(network, field, () => {});
    tool.setClass('road_medium');
    tool.setParallelSnap(false);
    tool.update(new Vector3(0, field.heightAt(0, 0), 0), MODS);
    tool.click();
    tool.update(new Vector3(150, field.heightAt(150, 0), 0), MODS);
    tool.click();
    // 端点から見て後ろ寄り。円弧は掃引角で頭打ちになり、遠くで終わる。
    tool.update(new Vector3(60, field.heightAt(60, 12), 12), { straight: false, noSnap: false });
    tool.click();

    const added = network.getSegment([...network.segments.keys()].pop()!);
    const tip = network.getNode(added.b).pos;
    expect(Math.hypot(tip.x - 60, tip.z - 12)).toBeGreaterThan(5);
    // 届いた所の地形に乗っている (高さ設定は 0 なので地表ちょうど)。
    expect(tip.y).toBeCloseTo(field.heightAt(tip.x, tip.z), 3);
    // カーソルの下の高さとは、はっきり違う。
    expect(Math.abs(tip.y - field.heightAt(60, 12))).toBeGreaterThan(5);
  });

  it('高さ設定 (地下・高架) は届いた所でも保つ', () => {
    const field = slopedField();
    const network = new Network();
    const tool = new BuildTool(network, field, () => {});
    tool.setClass('road_medium');
    tool.setParallelSnap(false);
    tool.update(new Vector3(0, field.heightAt(0, 0), 0), MODS);
    tool.click();
    tool.update(new Vector3(150, field.heightAt(150, 0), 0), MODS);
    tool.click();
    tool.adjustElevation(2); // +6 m
    tool.update(new Vector3(60, field.heightAt(60, 12), 12), { straight: false, noSnap: false });
    tool.click();

    const added = network.getSegment([...network.segments.keys()].pop()!);
    const tip = network.getNode(added.b).pos;
    expect(tip.y - field.heightAt(tip.x, tip.z)).toBeCloseTo(6, 3);
  });

  it('少し外して指しても、届く所まで敷ける (警告は出さない)', () => {
    // 真後ろに近い所は、接線に接する円弧が何百 m も回り込む。掃引角の
    // 制限でその円弧は指した所まで届かないが、届く所までは敷ける。
    const { tool, network } = drawn();
    tool.update(new Vector3(60, 0, 12), { straight: false, noSnap: false });
    const status = tool.status();
    expect(status.length).toBeGreaterThan(400);
    expect(status.blockers).toEqual([]);

    tool.click();
    expect(network.segments.size).toBe(2);
    // 端点は指した所ではなく、線形が実際に届いた所に立つ。プレビューに
    // 出ていた形のまま残るので、敷いたあとで線形が歪まない。
    const added = network.getSegment([...network.segments.keys()].pop()!);
    const alignment = network.alignmentOf(added.id);
    expect(alignment.length).toBeCloseTo(status.length, 1);
    const tip = alignment.sampleAt(alignment.length).pos;
    expect(Math.hypot(tip.x - 60, tip.z - 12)).toBeGreaterThan(5);
  });

  it('前へ続けるのはそのまま置ける', () => {
    const { tool, network } = drawn();
    tool.update(new Vector3(260, 0, 40), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    expect(network.segments.size).toBe(2);
  });

  it('道の途中から引き返して同じ道に戻ることもできない', () => {
    // 端点の接線が無い所 (道路は途中接続で向きを引き継がない) でも、
    // 出てきた線形の上に戻る線形は止まる。
    const { tool, network } = drawn();
    tool.cancel();
    const before = network.segments.size;
    tool.update(new Vector3(120, 0, 0), MODS);
    expect(tool.status().snap).toBe('segment');
    tool.click();
    tool.update(new Vector3(20, 0, 0), MODS);
    expect(tool.status().blockers.join(' ')).toContain('重なって');
    tool.click();
    expect(network.segments.size).toBe(before);
  });

  it('道から離れて戻る迂回路は置ける', () => {
    const { tool, network } = drawn();
    tool.cancel();
    tool.update(new Vector3(120, 0, 0), MODS);
    tool.click();
    tool.update(new Vector3(60, 0, 80), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.update(new Vector3(20, 0, 0), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    expect(network.segments.size).toBeGreaterThan(2);
  });
});

describe('スナップ目印の描画', () => {
  /** 目印のメッシュの頂点。 */
  function vertices(view: SnapView): number[] {
    const mesh = view.group.children[0] as Mesh;
    const position = mesh.geometry.getAttribute('position');
    return position ? Array.from(position.array as Float32Array) : [];
  }

  it('目印が無ければ何も描かない', () => {
    const view = new SnapView();
    view.update([]);
    expect(vertices(view).length).toBe(0);
    view.dispose();
  });

  it('案内線は基準の線形をなぞる (端から端まで面ができる)', () => {
    const view = new SnapView();
    const guide = [new Vector3(0, 5, 0), new Vector3(50, 5, 0), new Vector3(100, 5, 0)];
    view.update([
      {
        kind: 'parallel',
        pos: new Vector3(100, 5, 4.6),
        radius: 2,
        guide,
        tie: [new Vector3(100, 5, 0), new Vector3(100, 5, 4.6)],
      },
    ]);
    const xs: number[] = [];
    const ys: number[] = [];
    const v = vertices(view);
    expect(v.length).toBeGreaterThan(0);
    for (let i = 0; i < v.length; i += 3) {
      xs.push(v[i]);
      ys.push(v[i + 1]);
    }
    // 案内線が基準の全長にわたって引かれている。
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(99);
    // 路面より上に浮かせて描く (舗装に埋もれない)。
    expect(Math.min(...ys)).toBeGreaterThan(5);
    view.dispose();
  });
});

describe('確認モードの読み取り', () => {
  /** カーソルの高さを指定して指す。 */
  function look(tool: BuildTool, p: Vector3): void {
    tool.update(p.clone(), { straight: false, noSnap: false });
  }

  /** 直線から `side` 側へ曲がる線形を 1 本引く。 */
  function curve(classId: string, side: 1 | -1): { network: Network; segment: number } {
    const network = new Network();
    const cls = getClass(classId);
    const a = network.addNode(new Vector3(-300, 0, 0));
    const b = network.addNode(new Vector3(0, 0, 0));
    network.addSegment({
      classId,
      a: a.id,
      b: b.id,
      ctrlA: new Vector2(-200, 0),
      ctrlB: new Vector2(-100, 0),
      gradeA: 0,
      gradeB: 0,
    });
    const tip = network.getNode(b.id);
    const anchor = anchorFromNode(network, tip, cls);
    const target = new Vector3(240, 0, side * 70);
    const preview = computePlacement(anchor, target, { straight: false, cls });
    const result = placeSegment(network, classId, anchor, { pos: target }, preview);
    return { network, segment: result.segment };
  }

  /** 線形の 3 点から外接円の半径を出す (報告された半径の突き合わせ用)。 */
  function circumradius(p0: Vector3, p1: Vector3, p2: Vector3): number {
    const a = Math.hypot(p1.x - p0.x, p1.z - p0.z);
    const b = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const c = Math.hypot(p2.x - p0.x, p2.z - p0.z);
    const area = Math.abs(
      (p1.x - p0.x) * (p2.z - p0.z) - (p2.x - p0.x) * (p1.z - p0.z),
    ) / 2;
    return area < 1e-9 ? Infinity : (a * b * c) / (4 * area);
  }

  it('曲がる向きが符号で分かる (左右を取り違えない)', () => {
    for (const side of [1, -1] as const) {
      const { network, segment } = curve('rail_single', side);
      const tool = new BuildTool(network, flatField(), () => {});
      tool.setMode('inspect');
      const alignment = network.alignmentOf(segment);
      look(tool, alignment.sampleAt(alignment.length * 0.8).pos);
      const inspect = tool.status().inspect!;
      expect(inspect.segment).toBe(segment);
      // 線形の向きに見て右カーブが正。読み取りの見出しもその向きで出す。
      expect(Math.sign(inspect.curvature)).toBe(side);
      expect(formatRadius(inspect.curvature).startsWith(side > 0 ? '右' : '左')).toBe(true);
    }
  });

  it('報告された曲線半径が、実際の線形の曲がり方と合っている', () => {
    const { network, segment } = curve('rail_single', 1);
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setMode('inspect');
    const alignment = network.alignmentOf(segment);
    const s = alignment.length * 0.85;
    look(tool, alignment.sampleAt(s).pos);
    const inspect = tool.status().inspect!;
    const reported = 1 / Math.abs(inspect.curvature);
    // 前後 5 m の 3 点を通る円の半径。別の求め方で突き合わせる。
    const want = circumradius(
      alignment.sampleAt(inspect.s - 5).pos,
      alignment.sampleAt(inspect.s).pos,
      alignment.sampleAt(inspect.s + 5).pos,
    );
    expect(reported / want).toBeGreaterThan(0.97);
    expect(reported / want).toBeLessThan(1.03);
  });

  it('線路では曲率が立ち上がる様子が読める (道路は跳ぶ)', () => {
    const rail = curve('rail_single', 1);
    const road = curve('road_medium', 1);
    const profileOf = (made: { network: Network; segment: number }): Float32Array => {
      const tool = new BuildTool(made.network, flatField(), () => {});
      tool.setMode('inspect');
      const alignment = made.network.alignmentOf(made.segment);
      look(tool, alignment.sampleAt(alignment.length * 0.5).pos);
      return tool.status().inspect!.profile.curvature;
    };

    const railK = profileOf(rail);
    const peak = Math.max(...railK);
    // 入口は 0 から始まり、単調に増えて頭打ちになる。
    expect(Math.abs(railK[0])).toBeLessThan(peak * 0.05);
    for (let i = 1; i < railK.length; i++) expect(railK[i]).toBeGreaterThan(railK[i - 1] - 1e-5);
    // 立ち上がりの途中の点がいくつもある (跳んでいない)。
    expect(railK.filter((k) => k > peak * 0.1 && k < peak * 0.9).length).toBeGreaterThan(1);

    // 道路は緩和曲線を入れないので、入口から曲率が付いている。
    const roadK = profileOf(road);
    expect(Math.abs(roadK[0])).toBeGreaterThan(Math.max(...roadK) * 0.9);
  });

  it('直線の上では直線と出る', () => {
    const { network, segment } = curve('rail_single', 1);
    void segment;
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setMode('inspect');
    // 最初に置いた直線区間の途中。
    look(tool, new Vector3(-150, 0, 0));
    const inspect = tool.status().inspect!;
    expect(Math.abs(inspect.curvature)).toBeLessThan(1e-6);
    expect(formatRadius(inspect.curvature)).toBe('直線');
  });

  it('道路にはカントが無い (0 ではなく「無い」)', () => {
    const { network, segment } = curve('road_medium', 1);
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setMode('inspect');
    const alignment = network.alignmentOf(segment);
    look(tool, alignment.sampleAt(alignment.length * 0.8).pos);
    expect(tool.status().inspect!.cant).toBeNull();
  });

  it('線形から離れた所を指すと何も出ない', () => {
    const { network } = curve('rail_single', 1);
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setMode('inspect');
    look(tool, new Vector3(-150, 0, 200));
    expect(tool.status().inspect).toBeNull();
  });

  it('敷設モードのスナップ表示が残らない', () => {
    const { tool } = tJunction();
    tool.update(new Vector3(0, 0, 0), MODS);
    expect(tool.status().snap).not.toBe('none');
    tool.setMode('inspect');
    tool.update(new Vector3(0, 0, 0), { straight: false, noSnap: false });
    expect(tool.status().snap).toBe('none');
  });

  it('描画側を渡すと、構造形式とカントも読める', () => {
    // 実際に組み立てた世界で確かめる。カントも構造形式も、線形だけからは
    // 決まらない (描画側が持っている) ため。
    const field = testField();
    generateTerrain(field, DEFAULT_TERRAIN);
    const network = new Network();
    buildDemoNetwork(network, field);
    const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
    const result = world.rebuild();
    const tool = new BuildTool(network, field, () => {}, world);
    tool.setMode('inspect');

    // 橋になっている区間を探して、その真ん中を指す。
    let bridge: { segment: number; s: number } | null = null;
    for (const [segment, runs] of result.structures) {
      for (const run of runs) {
        if (run.mode === 'bridge' && run.s1 - run.s0 > 20) {
          bridge = { segment, s: (run.s0 + run.s1) / 2 };
        }
      }
    }
    expect(bridge).not.toBeNull();
    look(tool, network.alignmentOf(bridge!.segment).sampleAt(bridge!.s).pos);
    expect(tool.status().inspect!.structure).toBe('bridge');

    // カントの付いている線路を探して指す。
    let canted: { segment: number; s: number } | null = null;
    for (const seg of network.segments.values()) {
      if (network.classOf(seg).kind !== 'rail') continue;
      const alignment = network.alignmentOf(seg.id);
      for (let i = 1; i < 20; i++) {
        const s = (alignment.length * i) / 20;
        if (Math.abs(world.cantAt(seg.id, s)) > 0.01) canted = { segment: seg.id, s };
      }
    }
    expect(canted).not.toBeNull();
    look(tool, network.alignmentOf(canted!.segment).sampleAt(canted!.s).pos);
    const inspect = tool.status().inspect!;
    expect(inspect.cant).not.toBeNull();
    expect(inspect.cant!).toBeGreaterThan(0.01);
    expect(inspect.structure).not.toBeNull();
  });
});

/**
 * 踏切の作り方。
 *
 * 踏切は「作る」操作ではなく、同じ高さで交差させた結果です。ただし線路を
 * **道路の上で止めて**、そこから先へ伸ばす、という引き方ができないと不便
 * です (舗装の中で止めると道床と重なって敷設できない)。種別の違う線形の
 * 上では中心線 = 交点になる点へ吸い付かせて、そこで止められるようにします。
 */
describe('踏切', () => {
  /** 東西にまっすぐな道路 1 本。線路を引く用意までする。 */
  function withRoad(): { tool: BuildTool; network: Network } {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('road_medium');
    clickAt(tool, -250, 0);
    clickAt(tool, 250, 0);
    tool.cancel();
    tool.setClass('rail_single');
    return { tool, network };
  }

  /** 交差角 `deg` で原点を通る向きの、原点から `t` [m] の点。 */
  function along(deg: number, t: number): { x: number; z: number } {
    const rad = (deg * Math.PI) / 180;
    return { x: Math.cos(rad) * t, z: Math.sin(rad) * t };
  }

  it('道路の上ではどこを指しても、中心線 (交点) に吸い付く', () => {
    const { tool } = withRoad();
    const road = getClass('road_medium');
    let snapped = 0;
    for (let z = -12; z <= 12; z += 1.5) {
      tool.update(new Vector3(0, 0, z), MODS);
      const status = tool.status();
      if (Math.abs(z) <= road.halfWidth) {
        // 舗装の上なら必ず吸い付く。
        expect(status.snap, `z=${z}`).toBe('crossing');
        expect(status.markers[0].kind).toBe('crossing');
        // 吸い付く先は道路の中心線 (= 踏切になる点)。
        expect(status.markers[0].pos.z).toBeCloseTo(0, 6);
        snapped++;
      }
    }
    expect(snapped).toBeGreaterThan(8);
    // 舗装から十分離れれば吸い付かない。
    tool.update(new Vector3(0, 0, 30), MODS);
    expect(tool.status().snap).toBe('none');
  });

  it('交点で止めてから伸ばすと、踏切ができる', () => {
    for (const deg of [90, 60, 45, 25]) {
      const { tool, network } = withRoad();
      const field = flatField();
      const start = along(deg, -150);
      clickAt(tool, start.x, start.z);
      // 舗装の上を、中心線から外して指す。吸い付いて交点に落ちる。
      const on = along(deg, -5);
      tool.update(new Vector3(on.x, 0, on.z), MODS);
      expect(tool.status().snap, `${deg}°`).toBe('crossing');
      expect(tool.status().blockers, `${deg}° 交点で止められない`).toEqual([]);
      tool.click();
      // そこから先へ伸ばす。
      const end = along(deg, 150);
      tool.update(new Vector3(end.x, 0, end.z), MODS);
      expect(tool.status().blockers, `${deg}° 交点から伸ばせない`).toEqual([]);
      tool.click();
      tool.cancel();

      // 線路は交点で 2 本に分かれ、道路はそのまま。踏切が 1 か所できる。
      expect(network.segments.size, `${deg}°`).toBe(3);
      const world = new WorldBuilder(network, field, new TerrainMesh(field, new MeshBasicMaterial()));
      const result = world.rebuild();
      expect(result.stats.levelCrossings, `${deg}°`).toBe(1);
      expect(result.warnings.map((w) => w.message), `${deg}°`).toEqual([]);
    }
  });

  it('高さを上げているときは吸い付かない (立体交差にする人の邪魔をしない)', () => {
    const { tool } = withRoad();
    tool.adjustElevation(1);
    tool.update(new Vector3(0, 3, 3), MODS);
    expect(tool.status().snap).toBe('none');
    tool.adjustElevation(-1);
    tool.update(new Vector3(0, 0, 3), MODS);
    expect(tool.status().snap).toBe('crossing');
  });
});

/**
 * ルートに沿った平行敷設。
 *
 * 既存の複線は、橋・踏切・分岐のたびにノードが入って何本にも分かれている。
 * 基準の 1 本ぶんで止まってしまうと、その隣を敷くのに何度もクリックし直す
 * ことになる。始点の隣から終点の隣まで、線路のルートをたどって一度に敷ける
 * ようにしたのがここ。
 */
/**
 * 線路の分岐。
 *
 * 線路の交差点には中身が無いので、折れたまま枝が集まると角がそのまま残る。
 * 交差点の中で振り分ける余地が無く、置いてから直せないので、置く前に止める。
 */
describe('線路の分岐', () => {
  function railLine(): { tool: BuildTool; network: Network } {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('rail_single');
    for (const x of [-200, 200]) {
      tool.update(new Vector3(x, 0, 0), MODS);
      tool.click();
    }
    tool.cancel();
    return { tool, network };
  }

  it('直線モードで斜めに分けようとすると止まる', () => {
    const { tool } = railLine();
    tool.update(new Vector3(0, 0, 0), MODS);
    expect(tool.status().snap).toBe('segment');
    tool.click();
    tool.update(new Vector3(120, 0, -120), MODS);
    expect(tool.status().blockers.some((b) => b.includes('分岐角'))).toBe(true);
  });

  it('接線に沿って分ければ置ける', () => {
    const { tool, network } = railLine();
    const soft = { straight: false, noSnap: false };
    tool.update(new Vector3(0, 0, 0), soft);
    tool.click();
    tool.update(new Vector3(120, 0, -120), soft);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();
    const node = junctionNode(network);
    expect(network.branchesAt(node.id).length).toBe(3);
  });

  it('端点から続けて引くぶんには、折れても止めない (継ぎ目は均される)', () => {
    const { tool, network } = railLine();
    // 東の端点から北東へ。2 枝の継ぎ目なので `smoothJoint` が折れを均す。
    tool.update(new Vector3(200, 0, 0), MODS);
    tool.click();
    tool.update(new Vector3(300, 0, -60), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();
    expect(network.segments.size).toBe(2);
  });
});

describe('ルートに沿った平行敷設', () => {
  const GAP = 4.6; // parallelSpacing(rail_single)

  /** 途中にノードのある線路を引く (経由点ごとに 1 本ずつのセグメントになる)。 */
  function line(xs: number[], straight = true): { tool: BuildTool; network: Network } {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('rail_single');
    tool.setParallelSnap(true);
    const mods = { straight, noSnap: false };
    for (const x of xs) {
      tool.update(new Vector3(x, 0, 0), mods);
      tool.click();
    }
    tool.cancel();
    return { tool, network };
  }

  /** 敷いた区間を「(始点)->(終点)」の並びにする。 */
  function laid(network: Network, from: number): string[] {
    return [...network.segments.values()].slice(from).map((seg) => {
      const a = network.getNode(seg.a).pos;
      const b = network.getNode(seg.b).pos;
      return `(${a.x.toFixed(0)},${a.z.toFixed(1)})->(${b.x.toFixed(0)},${b.z.toFixed(1)})`;
    });
  }

  it('途中で分かれている線路の隣を、一度に端から端まで敷ける', () => {
    const { tool, network } = line([-150, -50, 50, 150]);
    expect(network.segments.size).toBe(3);

    tool.update(new Vector3(-140, 0, GAP), MODS);
    expect(tool.status().snap).toBe('parallel');
    tool.click();
    tool.update(new Vector3(140, 0, GAP), MODS);
    const status = tool.status();
    expect(status.snap).toBe('parallel');
    expect(status.blockers).toEqual([]);
    // 長さは基準をたどった全長 (1 本ぶんの 100 m ではない)。
    expect(status.length).toBeCloseTo(280, 0);

    tool.click();
    // 基準と同じ位置で区切られる。橋・トンネルの境目が隣どうしで揃う。
    expect(laid(network, 3)).toEqual([
      '(-140,4.6)->(-50,4.6)',
      '(-50,4.6)->(50,4.6)',
      '(50,4.6)->(140,4.6)',
    ]);
  });

  it('引く向きも基準の向きも、敷く側を変えない', () => {
    for (const reverseMiddle of [false, true]) {
      for (const backwards of [false, true]) {
        const name = `rev=${reverseMiddle} back=${backwards}`;
        const { tool, network } = line([-150, -50, 50, 150]);
        // 真ん中だけ線形の向きを入れ替える (弧長の向きが逆になる)。
        if (reverseMiddle) network.reverseSegment(2);
        const [from, to] = backwards ? [140, -140] : [-140, 140];

        tool.update(new Vector3(from, 0, GAP), MODS);
        tool.click();
        tool.update(new Vector3(to, 0, GAP), MODS);
        expect(tool.status().blockers, name).toEqual([]);
        tool.click();

        const placed = laid(network, 3);
        expect(placed.length, name).toBe(3);
        // どう引いても、同じ側 (z = +4.6) に同じ位置で区切られる。
        for (const seg of [...network.segments.values()].slice(3)) {
          for (const node of [seg.a, seg.b]) {
            expect(network.getNode(node).pos.z, `${name} ${placed}`).toBeCloseTo(GAP, 1);
          }
        }
      }
    }
  });

  it('基準の途中で止めれば、そこまでで区切って敷ける', () => {
    const { tool, network } = line([-150, -50, 50, 150]);
    tool.update(new Vector3(-140, 0, GAP), MODS);
    tool.click();
    tool.update(new Vector3(20, 0, GAP), MODS);
    expect(tool.status().length).toBeCloseTo(160, 0);
    tool.click();
    expect(laid(network, 3)).toEqual(['(-140,4.6)->(-50,4.6)', '(-50,4.6)->(20,4.6)']);
  });

  /**
   * 線路の交差点には面が無いので、分岐器のノードの真横で区切ってよい。
   * (面があった頃は、そこに端点を置くと「交差点の中に端点があります」で
   *  止まり、分岐器を 1 つ越えるだけで複線化できなかった。)
   */
  it('分岐器の真横でも、基準と同じ位置で区切って敷ける', () => {
    const { tool, network } = line([-150, 0, 150]);
    // 原点から南東へ側線を分ける (原点が分岐器になる)。線路の分岐は接線に
    // 沿ってしか作れないので、曲線モードで引く。
    const soft = { straight: false, noSnap: false };
    tool.update(new Vector3(0, 0, 0), soft);
    tool.click();
    tool.update(new Vector3(120, 0, -120), soft);
    expect(tool.status().blockers).toEqual([]);
    tool.click();
    tool.cancel();
    const base = network.segments.size;
    const node = [...network.nodes.values()].find((n) => Math.hypot(n.pos.x, n.pos.z) < 1)!;
    expect(network.branchesAt(node.id).length).toBe(3);
    expect(junctionReach(network, node.id)).toBe(0);

    // 分岐と反対側 (北) に、分岐器を越えて敷く。
    tool.update(new Vector3(-140, 0, GAP), MODS);
    tool.click();
    tool.update(new Vector3(140, 0, GAP), MODS);
    expect(tool.status().blockers).toEqual([]);
    tool.click();

    const placed = [...network.segments.values()].slice(base);
    expect(placed.length).toBe(2);
    // 区切りは基準のノードの真横。
    const joint = network.getNode(placed[0].b).pos;
    expect(Math.abs(joint.x - node.pos.x)).toBeLessThan(1);
  });

  it('曲がった線路でも、間隔と終点の接線が基準に揃う', () => {
    const network = new Network();
    const tool = new BuildTool(network, flatField(), () => {});
    tool.setClass('rail_single');
    tool.setParallelSnap(true);
    const soft = { straight: false, noSnap: false };
    for (const [x, z] of [[-200, 0], [-60, 0], [60, 60], [200, 180]] as [number, number][]) {
      tool.update(new Vector3(x, 0, z), soft);
      tool.click();
    }
    tool.cancel();
    const base = network.segments.size;
    expect(base).toBe(3);

    tool.update(new Vector3(-190, 0, -GAP), soft);
    expect(tool.status().snap).toBe('parallel');
    tool.click();
    tool.update(new Vector3(150, 0, 130 - GAP), soft);
    expect(tool.status().blockers).toEqual([]);
    tool.click();

    const placed = [...network.segments.values()].slice(base);
    expect(placed.length).toBeGreaterThan(1);
    // 間隔はどこでも一定。
    for (const seg of placed) {
      const own = network.alignmentOf(seg.id);
      for (let i = 0; i <= 8; i++) {
        const p = own.sampleAt((own.length * i) / 8).pos;
        let nearest = Infinity;
        for (let id = 1; id <= base; id++) {
          const ref = network.alignmentOf(id);
          const s = stationOf(ref, p.x, p.z);
          nearest = Math.min(nearest, ref.sampleAt(s).pos.distanceTo(p));
        }
        expect(Math.abs(nearest - GAP)).toBeLessThan(0.6);
      }
    }
    // 終点の接線は、その所の基準の接線と揃う。
    const last = placed[placed.length - 1];
    const own = network.alignmentOf(last.id);
    const end = own.sampleAt(own.length);
    const reference = network.alignmentOf(base);
    const at = reference.sampleAt(stationOf(reference, end.pos.x, end.pos.z));
    expect(end.forwardXZ.dot(at.forwardXZ)).toBeGreaterThan(Math.cos(2 * DEG));
  });
});
