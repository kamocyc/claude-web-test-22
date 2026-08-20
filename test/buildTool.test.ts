import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { Mesh } from 'three';
import { BuildTool } from '../src/app/buildTool';
import { SnapView } from '../src/render/snapView';
import { Network } from '../src/network/network';
import { Heightfield } from '../src/terrain/heightfield';

/**
 * 敷設ツールの操作。
 *
 * 「どこを指すとどこに繋がるか」は、規則の判定と同じくらい大事な所。
 * ここでは平らな地形の上で、カーソル位置からクリックまでを実際に通す。
 */

function flatField(y = 0): Heightfield {
  const field = new Heightfield();
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

  it('少し外して指しても、指した所まで届かない線形は置けない', () => {
    // 真後ろに近い所は、接線に接する円弧が何百 m も回り込む。
    const { tool } = drawn();
    tool.update(new Vector3(60, 0, 12), { straight: false, noSnap: false });
    const status = tool.status();
    expect(status.length).toBeGreaterThan(400);
    expect(status.blockers.join(' ')).toContain('届きません');
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
