/**
 * 湖の絞り込み。
 *
 * `findLakes` は「埋め立てが戻した量」だけを見ていて、形を問わない。
 * `carveAndFlatten` はしきい値の何倍も深く河床を掘るので、下流へ単調に
 * 下がりきらなかった区間はすべて埋め戻され、**幅 1 セルの「湖」**として
 * 川筋に沿って並ぶ。移植元の実測では湖セルの 87% が川のセルだった。
 *
 * 湖は線ではなく面なので、自分の縁から 1 セルより離れられない成分と、
 * 境界矩形を埋めない成分を落とす。
 */
import { IndexQueue, type HydroGrid } from './grid';

export interface LakeSet {
  /** 絞り込んだマスク。落とした所はただの陸になる。 */
  mask: Uint8Array;
  removed: number;
  kept: number;
}

/** 3x3 が丸ごと入る所が 1 つでもあること。 */
const MIN_LAKE_RADIUS = 2;
/** そのうえで、境界矩形をこの割合以上埋めていること (盆地は埋め、水系網は埋めない)。 */
const MIN_LAKE_FILL = 0.4;

export function refineLakes(g: HydroGrid, lake: Uint8Array): LakeSet {
  const { n, len } = g;
  const mask = new Uint8Array(lake);
  const radius = inscribedRadius(g, mask);
  const seen = new Uint8Array(len);
  const queue = new Int32Array(len);
  let removed = 0;
  let kept = 0;

  for (let root = 0; root < len; root++) {
    if (!mask[root] || seen[root]) continue;
    let head = 0;
    let tail = 0;
    const cells: number[] = [];
    queue[tail++] = root;
    seen[root] = 1;
    let widest = 0;
    let minX = n;
    let maxX = -1;
    let minY = n;
    let maxY = -1;
    while (head < tail) {
      const i = queue[head++];
      cells.push(i);
      if (radius[i] > widest) widest = radius[i];
      const x = i % n;
      const y = (i / n) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const j = ny * n + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
      }
    }
    const fill = cells.length / ((maxX - minX + 1) * (maxY - minY + 1));
    if (widest < MIN_LAKE_RADIUS || fill < MIN_LAKE_FILL) {
      for (const i of cells) mask[i] = 0;
      removed += cells.length;
    } else {
      kept += cells.length;
    }
  }
  return { mask, removed, kept };
}

/** 各セルから、マスクの外までの 8 近傍距離。 */
function inscribedRadius(g: HydroGrid, mask: Uint8Array): Int16Array {
  const { n, len } = g;
  const dist = new Int16Array(len);
  const queue = new IndexQueue(Math.max(1024, n * 4));
  for (let i = 0; i < len; i++) {
    if (mask[i]) {
      dist[i] = 32767;
    } else {
      dist[i] = 0;
      queue.push(i);
    }
  }
  while (queue.length) {
    const i = queue.shift();
    const x = i % n;
    const y = (i / n) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (dist[j] > dist[i] + 1) {
          dist[j] = dist[i] + 1;
          queue.push(j);
        }
      }
    }
  }
  // 盤外は乾いた土地として数える。端に接した湖は、そこでは「広く」ない。
  for (let i = 0; i < len; i++) {
    if (!mask[i]) continue;
    const x = i % n;
    const y = (i / n) | 0;
    dist[i] = Math.min(dist[i], Math.min(x, y, n - 1 - x, n - 1 - y) + 1);
  }
  return dist;
}
