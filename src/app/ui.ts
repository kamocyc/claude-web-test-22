import { NETWORK_CLASSES } from '../network/classes';
import { viewUniforms } from '../render/materials';
import type { BuildResult } from '../render/worldBuilder';
import type { ToolMode, ToolStatus } from './buildTool';

export interface UiCallbacks {
  onMode: (mode: ToolMode) => void;
  /** 接続の色分け表示を切り替える。 */
  onConnectivityColors: (on: boolean) => void;
  /** 車両の走行表示を切り替える。 */
  onVehicles: (on: boolean) => void;
  onClass: (classId: string) => void;
  onElevation: (steps: number) => void;
  /** 並列敷設の本数を変える。 */
  onParallel: (count: number) => void;
  onRegenerate: () => void;
  onDemo: () => void;
  /** インターチェンジのサンプルを置く。 */
  onInterchange: (kind: 'diamond' | 'trumpet') => void;
  onClear: () => void;
}

interface ToggleSpec {
  id: string;
  label: string;
  initial: boolean;
  apply: (on: boolean) => void;
}

/**
 * 画面上の DOM を組み立て、状態を反映する。
 * 3D 側と分離しておき、ここではイベントを外へ流すだけにする。
 */
export class Ui {
  private readonly modeButtons = new Map<ToolMode, HTMLButtonElement>();
  private readonly classButtons = new Map<string, HTMLButtonElement>();
  private readonly parallelButtons = new Map<number, HTMLButtonElement>();
  private readonly elevationLabel: HTMLElement;
  private readonly statusBody: HTMLElement;
  private readonly warningBody: HTMLElement;
  private readonly statsBody: HTMLElement;

  constructor(root: HTMLElement, callbacks: UiCallbacks) {
    const left = el('div', 'panel panel-left');

    left.append(sectionTitle('ツール'));
    const modes = el('div', 'row');
    for (const [mode, label, hint] of [
      ['build', '敷設', 'B'],
      ['bulldoze', '撤去', 'X'],
      ['inspect', '確認', 'V'],
    ] as [ToolMode, string, string][]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.textContent = `${label} (${hint})`;
      button.addEventListener('click', () => callbacks.onMode(mode));
      this.modeButtons.set(mode, button);
      modes.append(button);
    }
    left.append(modes);

    left.append(sectionTitle('種別'));
    for (const cls of NETWORK_CLASSES) {
      const button = el('button', 'chip wide') as HTMLButtonElement;
      button.innerHTML = `<span>${cls.label}</span><small>R≧${cls.minRadius}m / 勾配≦${(
        cls.maxGrade * 100
      ).toFixed(1)}%</small>`;
      button.addEventListener('click', () => callbacks.onClass(cls.id));
      this.classButtons.set(cls.id, button);
      left.append(button);
    }

    left.append(sectionTitle('高さ'));
    const elevationRow = el('div', 'row');
    const down = button('−', () => callbacks.onElevation(-1));
    const up = button('＋', () => callbacks.onElevation(1));
    this.elevationLabel = el('span', 'elevation');
    elevationRow.append(down, this.elevationLabel, up);
    left.append(elevationRow);
    left.append(hint('PageUp / PageDown でも変更できます'));

    left.append(sectionTitle('並列敷設'));
    const parallelRow = el('div', 'row');
    for (const count of [1, 2, 3, 4]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.textContent = `${count} 本`;
      button.addEventListener('click', () => {
        callbacks.onParallel(count);
        this.setParallel(count);
      });
      this.parallelButtons.set(count, button);
      parallelRow.append(button);
    }
    left.append(parallelRow);
    left.append(hint('同じ線形を横に並べて敷きます。線路の複線はこれで作ります'));

    left.append(sectionTitle('表示'));
    const toggles: ToggleSpec[] = [
      {
        id: 'diag',
        label: '勾配・曲率の診断色',
        initial: false,
        apply: (on) => (viewUniforms.uDiagnostics.value = on ? 1 : 0),
      },
      {
        id: 'slope',
        label: '地形の傾斜ヒートマップ',
        initial: false,
        apply: (on) => (viewUniforms.uSlopeHeat.value = on ? 1 : 0),
      },
      {
        id: 'contour',
        label: '等高線',
        initial: true,
        apply: (on) => (viewUniforms.uContour.value = on ? 10 : 0),
      },
      {
        id: 'connectivity',
        label: '接続の色分け (系統)',
        initial: false,
        apply: (on) => callbacks.onConnectivityColors(on),
      },
      {
        id: 'vehicles',
        label: '車両を走らせる',
        initial: true,
        apply: (on) => callbacks.onVehicles(on),
      },
    ];
    for (const toggle of toggles) {
      left.append(checkbox(toggle.label, toggle.initial, toggle.apply));
      toggle.apply(toggle.initial);
    }

    left.append(sectionTitle('マップ'));
    const mapRow = el('div', 'row');
    mapRow.append(
      button('地形を再生成', callbacks.onRegenerate),
      button('サンプル', callbacks.onDemo),
      button('ダイヤ型 IC', () => callbacks.onInterchange('diamond')),
      button('トランペット IC', () => callbacks.onInterchange('trumpet')),
      button('全消去', callbacks.onClear),
    );
    left.append(mapRow);

    const right = el('div', 'panel panel-right');
    right.append(sectionTitle('状態'));
    this.statusBody = el('div', 'readout');
    right.append(this.statusBody);
    right.append(sectionTitle('集計'));
    this.statsBody = el('div', 'readout');
    right.append(this.statsBody);
    right.append(sectionTitle('警告'));
    this.warningBody = el('div', 'readout warnings');
    right.append(this.warningBody);

    const help = el('div', 'help');
    help.innerHTML = [
      '<b>左クリック</b> 始点 → もう一度で確定 (続けて連結)',
      '<b>右クリック / Esc</b> 中断',
      '<b>Shift</b> 直線・15° スナップ / <b>Ctrl</b> スナップ解除',
      '<b>右ドラッグ</b> 視点移動 / <b>ホイール</b> 拡大縮小',
    ]
      .map((line) => `<div>${line}</div>`)
      .join('');

    root.append(left, right, help);
  }

  setMode(mode: ToolMode): void {
    for (const [key, button] of this.modeButtons) {
      button.classList.toggle('active', key === mode);
    }
  }

  setClass(classId: string): void {
    for (const [key, button] of this.classButtons) {
      button.classList.toggle('active', key === classId);
    }
  }

  setParallel(count: number): void {
    for (const [key, button] of this.parallelButtons) {
      button.classList.toggle('active', key === count);
    }
  }

  updateStatus(status: ToolStatus): void {
    this.elevationLabel.textContent = `${status.elevation >= 0 ? '+' : ''}${status.elevation} m`;

    const rows: [string, string][] = [];
    if (status.drawing) {
      rows.push(['延長', `${status.length.toFixed(1)} m`]);
      rows.push([
        '曲線半径',
        Number.isFinite(status.radius) ? `${status.radius.toFixed(0)} m` : '直線',
      ]);
      rows.push(['勾配', `${(status.grade * 100).toFixed(2)} %`]);
      rows.push(['概算', `¥${Math.round(status.cost).toLocaleString('ja-JP')}`]);
    } else {
      rows.push(['操作', status.mode === 'build' ? 'クリックで始点を指定' : '対象をクリック']);
    }
    if (status.parallel > 1) rows.push(['並列', `${status.parallel} 本`]);
    rows.push([
      'スナップ',
      status.snap === 'node' ? 'ノード' : status.snap === 'segment' ? '既存線形' : 'なし',
    ]);

    this.statusBody.innerHTML = rows
      .map(([k, v]) => `<div class="line"><span>${k}</span><b>${v}</b></div>`)
      .join('');

    // 敷設できない理由は、規格の警告より優先して大きく出す。
    if (status.blockers.length > 0) {
      this.statusBody.innerHTML +=
        '<div class="blocked"><b>ここには敷設できません</b>' +
        status.blockers.map((m) => `<div>${escapeHtml(m)}</div>`).join('') +
        '</div>';
      return;
    }
    const messages = status.diagnostics?.messages ?? [];
    if (messages.length > 0) {
      this.statusBody.innerHTML += messages
        .map((m) => `<div class="line bad">${escapeHtml(m)}</div>`)
        .join('');
    }
  }

  updateBuild(result: BuildResult): void {
    const s = result.stats;
    const rows: [string, string][] = [
      ['セグメント', `${s.segments}`],
      ['交差点', `${s.intersections}`],
      ['分岐器', `${s.turnouts}`],
      ['踏切', `${s.levelCrossings}`],
      ['高架', `${s.bridgeLength.toFixed(0)} m`],
      ['トンネル', `${s.tunnelLength.toFixed(0)} m`],
      ['総延長', `${s.totalLength.toFixed(0)} m`],
      ['総工費', `¥${Math.round(s.cost).toLocaleString('ja-JP')}`],
      ['道路網', `${s.roadNetworks} 系統`],
      ['線路網', `${s.railNetworks} 系統`],
      ['電力網', `${s.powerNetworks} 系統`],
    ];
    this.statsBody.innerHTML = rows
      .map(([k, v]) => `<div class="line"><span>${k}</span><b>${v}</b></div>`)
      .join('');

    // 同じ内容の警告は 1 行にまとめる。
    const counts = new Map<string, { count: number; severity: string }>();
    for (const warning of result.warnings) {
      const entry = counts.get(warning.message);
      if (entry) entry.count++;
      else counts.set(warning.message, { count: 1, severity: warning.severity });
    }
    if (counts.size === 0) {
      this.warningBody.innerHTML = '<div class="line ok">問題はありません</div>';
      return;
    }
    this.warningBody.innerHTML = [...counts]
      .slice(0, 8)
      .map(
        ([message, info]) =>
          `<div class="line ${info.severity === 'error' ? 'bad' : 'warn'}">${escapeHtml(
            message,
          )}${info.count > 1 ? ` <b>×${info.count}</b>` : ''}</div>`,
      )
      .join('');
  }
}

function el(tag: string, className = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  const node = el('h2');
  node.textContent = text;
  return node;
}

function hint(text: string): HTMLElement {
  const node = el('p', 'hint');
  node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'chip') as HTMLButtonElement;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function checkbox(label: string, initial: boolean, apply: (on: boolean) => void): HTMLElement {
  const wrapper = el('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  input.addEventListener('change', () => apply(input.checked));
  const span = document.createElement('span');
  span.textContent = label;
  wrapper.append(input, span);
  return wrapper;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}
