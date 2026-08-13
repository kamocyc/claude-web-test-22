import type { NetworkKind } from './classes';
import type { Junction } from './junction';
import type { Network, NodeId, SegmentId } from './network';

/**
 * 「どこからどこへ繋がっているか」を表すグラフ。
 *
 * 見た目だけでなく、交通シミュレーションや電力網の判定にそのまま使える
 * ようにしておく。道路は交差点で全ての枝が互いに繋がるが、線路は
 * 分岐器で繋がる組が決まっており、ダイヤモンドクロッシングでは
 * 交差するだけで繋がらない。この違いをここで表現する。
 */

/** ノードで繋がる 2 本の線形。 */
export interface Link {
  node: NodeId;
  a: SegmentId;
  b: SegmentId;
  /** 線路で直進側の進路か (道路では常に false)。 */
  through: boolean;
}

/** 連結成分 (ひと繋がりの系統)。 */
export interface NetworkComponent {
  id: number;
  kind: NetworkKind;
  segments: SegmentId[];
  /** 総延長 [m]。 */
  length: number;
}

export interface Connectivity {
  links: Link[];
  components: NetworkComponent[];
  /** セグメントが属する系統番号。 */
  componentOf: Map<SegmentId, number>;
  /** どこにも繋がっていないセグメント。 */
  isolated: SegmentId[];
}

/**
 * ネットワークの接続関係を解く。
 *
 * 道路の交差点では、集まる枝は互いに通行できるものとして全対全で繋ぐ。
 * 線路では `Junction.connections` (分岐器の進路) だけを繋ぐので、
 * ダイヤモンドクロッシングは「交差するが繋がらない」ことが表現される。
 */
export function buildConnectivity(
  network: Network,
  junctions: Map<NodeId, Junction>,
): Connectivity {
  const links: Link[] = [];

  for (const junction of junctions.values()) {
    if (junction.kind === 'invalid' || junction.kind === 'end') continue;
    const branches = junction.approaches.map((a) => a.branch);
    if (branches.length < 2) continue;

    if (branches[0].cls.kind === 'rail') {
      for (const connection of junction.connections) {
        links.push({
          node: junction.node,
          a: connection.from,
          b: connection.to,
          through: connection.through,
        });
      }
      continue;
    }

    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        links.push({
          node: junction.node,
          a: branches[i].segment,
          b: branches[j].segment,
          through: false,
        });
      }
    }
  }

  const parent = new Map<SegmentId, SegmentId>();
  for (const id of network.segments.keys()) parent.set(id, id);
  const find = (x: SegmentId): SegmentId => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // 経路圧縮。
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const link of links) {
    const ra = find(link.a);
    const rb = find(link.b);
    if (ra !== rb) parent.set(ra, rb);
  }

  const groups = new Map<SegmentId, SegmentId[]>();
  for (const id of network.segments.keys()) {
    const root = find(id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }

  const components: NetworkComponent[] = [];
  const componentOf = new Map<SegmentId, number>();
  // 番号が実行ごとに揺れないよう、代表セグメントの順に並べる。
  for (const root of [...groups.keys()].sort((a, b) => a - b)) {
    const segments = groups.get(root)!.sort((a, b) => a - b);
    const id = components.length;
    let length = 0;
    for (const segment of segments) {
      componentOf.set(segment, id);
      length += network.alignmentOf(segment).length;
    }
    components.push({
      id,
      kind: network.classOf(network.getSegment(segments[0])).kind,
      segments,
      length,
    });
  }

  const connected = new Set<SegmentId>();
  for (const link of links) {
    connected.add(link.a);
    connected.add(link.b);
  }
  const isolated = [...network.segments.keys()].filter((id) => !connected.has(id));

  return { links, components, componentOf, isolated };
}

/** 2 本の線形が同じ系統 (行き来できる) か。 */
export function sameNetwork(
  connectivity: Connectivity,
  a: SegmentId,
  b: SegmentId,
): boolean {
  const ca = connectivity.componentOf.get(a);
  const cb = connectivity.componentOf.get(b);
  return ca !== undefined && ca === cb;
}
