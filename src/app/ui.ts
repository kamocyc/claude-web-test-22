import { NETWORK_CLASSES, getClass } from '../network/classes';
import { riskColor, viewUniforms } from '../render/materials';
import type { BuildResult } from '../render/worldBuilder';
import type { ToolMode, ToolStatus } from './buildTool';
import type { StationToolSettings } from './buildTool';
import { stationPlatformRange, STATION_LENGTHS, type StationId } from '../network/station';
import type { RideStatus } from './ride';
import {
  GRAPH_W,
  formatCant,
  formatGrade,
  formatRadius,
  formatStation,
  formatStructure,
  formatVerticalRadius,
  renderInspectGraph,
  type InspectProfile,
  type PointInspection,
} from './inspect';

export interface UiCallbacks {
  onMode: (mode: ToolMode) => void;
  onStationSettings: (patch: Partial<Omit<StationToolSettings, 'heading'>>) => void;
  onStationRotate: (steps: number) => void;
  onStationRename: (id: StationId, name: string) => void;
  /** 接続の色分け表示を切り替える。 */
  onConnectivityColors: (on: boolean) => void;
  /** 車両の走行表示を切り替える。 */
  onVehicles: (on: boolean) => void;
  /** 地形を透かして地下線形を実深度で見る。 */
  onUndergroundView: (on: boolean) => void;
  /** 乗車モード (一人称視点) の出入り。 */
  onRide: () => void;
  /** 乗る車両を次に変える。 */
  onRideNext: () => void;
  onClass: (classId: string) => void;
  onElevation: (steps: number) => void;
  /** 平行スナップの入り切りを変える。 */
  onParallelSnap: (on: boolean) => void;
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
  private readonly parallelButtons = new Map<boolean, HTMLButtonElement>();
  private readonly elevationLabel: HTMLElement;
  private readonly rideButton: HTMLButtonElement;
  private readonly vehiclesToggle: HTMLInputElement;
  private readonly undergroundToggle: HTMLInputElement;
  private readonly statusBody: HTMLElement;
  private readonly stationNameInput: HTMLInputElement;
  private readonly stationTrackSelect: HTMLSelectElement;
  private readonly stationPlatformSelect: HTMLSelectElement;
  private readonly stationLengthSelect: HTMLSelectElement;
  private readonly stationHeadingLabel: HTMLElement;
  private readonly stationEditBody: HTMLElement;
  /** Platform options only depend on the selected track count. */
  private stationOptionTracks = 0;
  private readonly graphBody: HTMLElement;
  private readonly warningBody: HTMLElement;
  private readonly statsBody: HTMLElement;
  /** 直前に描いた状態の HTML。毎フレーム組み直さないための控え。 */
  private statusHtml = '';
  /** グラフを描いた線形。同じ線形の間は SVG を作り直さない。 */
  private graphProfile: InspectProfile | null = null;
  private graphCursor: SVGLineElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: UiCallbacks,
  ) {
    const left = el('div', 'panel panel-left');

    left.append(sectionTitle('ツール'));
    const modes = el('div', 'row');
    for (const [mode, label, hint] of [
      ['build', '敷設', 'B'],
      ['station', '駅', 'S'],
      ['scissors', 'シーサス', 'C'],
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

    left.append(sectionTitle('駅の設定'));
    this.stationNameInput = document.createElement('input');
    this.stationNameInput.className = 'text-input';
    this.stationNameInput.value = '駅 1';
    this.stationNameInput.maxLength = 40;
    this.stationNameInput.placeholder = '駅名';
    this.stationNameInput.addEventListener('input', () =>
      callbacks.onStationSettings({ name: this.stationNameInput.value }),
    );
    left.append(this.stationNameInput);

    const stationCounts = el('div', 'row');
    this.stationTrackSelect = select(
      Array.from({ length: 6 }, (_, i) => [String(i + 1), `${i + 1}線`] as const),
      '2',
      (value) => {
        const trackCount = Number(value);
        this.refreshPlatformOptions(trackCount);
        callbacks.onStationSettings({
          trackCount,
          platformCount: Number(this.stationPlatformSelect.value),
        });
      },
    );
    this.stationPlatformSelect = select([], '2', (value) =>
      callbacks.onStationSettings({ platformCount: Number(value) }),
    );
    this.refreshPlatformOptions(2);
    stationCounts.append(this.stationTrackSelect, this.stationPlatformSelect);
    left.append(stationCounts);

    const stationLengthRow = el('div', 'row');
    this.stationLengthSelect = select(
      STATION_LENGTHS.map((length) => [String(length), `${length} m`] as const),
      '120',
      (value) => callbacks.onStationSettings({ length: Number(value) as (typeof STATION_LENGTHS)[number] }),
    );
    const rotateLeft = button('↺ (N)', () => callbacks.onStationRotate(-1));
    const rotateRight = button('↻ (M)', () => callbacks.onStationRotate(1));
    this.stationHeadingLabel = el('span', 'elevation');
    stationLengthRow.append(this.stationLengthSelect, rotateLeft, rotateRight, this.stationHeadingLabel);
    left.append(stationLengthRow);
    left.append(hint('駅長を選び、N / M で回転して空き地をクリックします'));

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

    left.append(sectionTitle('平行スナップ'));
    const parallelRow = el('div', 'row');
    for (const [on, label] of [
      [true, 'あり'],
      [false, 'なし'],
    ] as [boolean, string][]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.textContent = label;
      button.addEventListener('click', () => {
        callbacks.onParallelSnap(on);
        this.setParallelSnap(on);
      });
      this.parallelButtons.set(on, button);
      parallelRow.append(button);
    }
    left.append(parallelRow);
    left.append(
      hint('既存の線路・道路の隣から引くと、その線形に平行してスナップします (Ctrl で一時解除)'),
    );

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
        id: 'underground',
        label: '地下ビュー (U)',
        initial: false,
        apply: (on) => callbacks.onUndergroundView(on),
      },
      {
        id: 'vehicles',
        label: '車両を走らせる',
        initial: true,
        apply: (on) => callbacks.onVehicles(on),
      },
    ];
    const inputs = new Map<string, HTMLInputElement>();
    for (const toggle of toggles) {
      const box = checkbox(toggle.label, toggle.initial, toggle.apply);
      inputs.set(toggle.id, box.input);
      left.append(box.node);
      toggle.apply(toggle.initial);
    }
    this.vehiclesToggle = inputs.get('vehicles')!;
    this.undergroundToggle = inputs.get('underground')!;

    left.append(sectionTitle('視点'));
    const rideRow = el('div', 'row');
    this.rideButton = button('乗車 (F)', callbacks.onRide);
    rideRow.append(this.rideButton, button('次の車両 (N)', callbacks.onRideNext));
    left.append(rideRow);
    left.append(
      hint('乗る車両をクリックで選びます。運転台に乗ったら、ドラッグで見回し、Esc / F で降ります'),
    );

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
    this.stationEditBody = el('div', 'station-editor');
    right.append(this.stationEditBody);
    this.graphBody = el('div', 'graph-body');
    right.append(this.graphBody);
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
      '<b>S</b> 駅配置 / <b>N・M</b> 駅を回転',
      '<b>C</b> 平行線路へシーサスクロッシングを一括敷設',
      '<b>U</b> 地下ビュー (地形を透過)',
      '<b>右ドラッグ</b> 視点移動 / <b>ホイール</b> 拡大縮小',
      '<b>F</b> 乗車 (車両をクリックで選ぶ) / <b>N</b> 次の車両 / 乗車中はドラッグで見回す',
    ]
      .map((line) => `<div>${line}</div>`)
      .join('');

    const undergroundBadge = el('div', 'underground-badge');
    undergroundBadge.textContent = '地下ビュー · U で地上へ戻る';

    root.append(left, right, help, undergroundBadge);
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

  /** 乗車まわりの状態を反映する。 */
  setRideState(state: 'off' | 'aim' | 'ride'): void {
    // 乗車中は敷設のパネルを薄くして、視界を空ける。選択中は俯瞰のままなので
    // 薄くしない (どの車両を光らせているか、パネルと見比べられるように)。
    this.root.classList.toggle('riding', state === 'ride');
    this.rideButton.classList.toggle('active', state !== 'off');
    this.rideButton.textContent =
      state === 'ride' ? '降りる (F)' : state === 'aim' ? '選択中 (Esc)' : '乗車 (F)';
  }

  /** 車両の走行表示のチェックを合わせる (乗車のために自動で入れたとき)。 */
  setVehicles(on: boolean): void {
    this.vehiclesToggle.checked = on;
  }

  /** キーボードで切り替えたときもチェック表示を揃える。 */
  setUndergroundView(on: boolean): void {
    this.undergroundToggle.checked = on;
  }

  setParallelSnap(on: boolean): void {
    for (const [key, button] of this.parallelButtons) {
      button.classList.toggle('active', key === on);
    }
  }

  updateStatus(status: ToolStatus, ride: RideStatus | null = null): void {
    const elevationKind = status.elevation > 0 ? '高架' : status.elevation < 0 ? '地下' : '地表';
    this.elevationLabel.textContent = `${status.elevation >= 0 ? '+' : ''}${status.elevation} m · ${elevationKind}`;

    /** [見出し, 値, 値の色] */
    const rows: [string, string, string?][] = [];
    if (ride) {
      rows.push(...rideRows(ride));
    } else if (status.drawing) {
      rows.push([status.mode === 'station' ? '線路総延長' : '延長', `${status.length.toFixed(1)} m`]);
      if (status.mode === 'station') {
        rows.push(['駅', `${status.station.trackCount}線 / ${status.station.platformCount}ホーム`]);
      } else {
        rows.push([
          '曲線半径',
          Number.isFinite(status.radius) ? `${status.radius.toFixed(0)} m` : '直線',
        ]);
        rows.push(['勾配', `${(status.grade * 100).toFixed(2)} %`]);
      }
      rows.push(['概算', `¥${Math.round(status.cost).toLocaleString('ja-JP')}`]);
    } else if (status.mode === 'inspect') {
      rows.push(...inspectRows(status.inspect));
    } else {
      rows.push([
        '操作',
        status.mode === 'build' ? 'クリックで始点を指定'
          : status.mode === 'station' ? '空き地をクリックして駅を配置'
          : status.mode === 'scissors' ? '平行線路上で位置を指定'
          : '対象をクリック',
      ]);
    }
    if (!ride && status.parallelTo !== null) rows.push(['平行', `線形 #${status.parallelTo} に沿う`]);
    // 撤去・確認モードではスナップしないので、この行は出さない。
    if (!ride && (status.mode === 'build' || status.mode === 'scissors')) {
      rows.push([
        'スナップ',
        status.snap === 'node'
          ? '交差点・端点に接続'
          : status.snap === 'segment'
            ? getClass(status.classId).kind === 'rail'
              ? '分岐接続 (接線)'
              : '既存線形に取り付き'
            : status.snap === 'crossing'
              ? '踏切 (交点で止める)'
            : status.snap === 'parallel'
              ? '平行'
              : status.snap === 'scissors'
                ? 'シーサスクロッシング'
              : 'なし',
      ]);
    }

    let html = rows
      .map(
        ([k, v, color]) =>
          `<div class="line"><span>${k}</span><b${color ? ` style="color:${color}"` : ''}>${v}</b></div>`,
      )
      .join('');

    // 敷設できない理由は、規格の警告より優先して大きく出す。
    if (ride) {
      // 乗車中はツールを止めているので、敷設の警告は出さない。
    } else if (status.blockers.length > 0) {
      html +=
        '<div class="blocked"><b>ここには敷設できません</b>' +
        status.blockers.map((m) => `<div>${escapeHtml(m)}</div>`).join('') +
        '</div>';
    } else {
      const messages = status.diagnostics?.messages ?? [];
      if (messages.length > 0) {
        html += messages.map((m) => `<div class="line bad">${escapeHtml(m)}</div>`).join('');
      }
    }

    // 毎フレーム呼ばれるので、変わっていなければ触らない。
    if (html !== this.statusHtml) {
      this.statusHtml = html;
      this.statusBody.innerHTML = html;
    }
    this.updateGraph(!ride && status.mode === 'inspect' ? status.inspect : null);
    this.syncStationControls(status.station);
    this.updateStationEditor(status);
  }

  private syncStationControls(settings: StationToolSettings): void {
    if (document.activeElement !== this.stationNameInput) this.stationNameInput.value = settings.name;
    this.stationTrackSelect.value = String(settings.trackCount);
    this.refreshPlatformOptions(settings.trackCount, settings.platformCount);
    this.stationLengthSelect.value = String(settings.length);
    const degrees = ((settings.heading * 180) / Math.PI + 360) % 360;
    this.stationHeadingLabel.textContent = `${degrees.toFixed(0)}°`;
  }

  private refreshPlatformOptions(trackCount: number, selected?: number): void {
    const range = stationPlatformRange(trackCount);
    const wanted = selected ?? Number(this.stationPlatformSelect?.value || 2);
    if (this.stationOptionTracks === trackCount) {
      this.stationPlatformSelect.value = String(Math.max(range.min, Math.min(range.max, wanted)));
      return;
    }
    this.stationOptionTracks = trackCount;
    this.stationPlatformSelect.innerHTML = '';
    for (let i = range.min; i <= range.max; i++) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${i}ホーム`;
      this.stationPlatformSelect.append(option);
    }
    this.stationPlatformSelect.value = String(Math.max(range.min, Math.min(range.max, wanted)));
  }

  private updateStationEditor(status: ToolStatus): void {
    const station = status.selectedStation;
    const key = station ? `${station.id}:${station.name}` : '';
    if (this.stationEditBody.dataset.key === key) return;
    this.stationEditBody.dataset.key = key;
    this.stationEditBody.innerHTML = '';
    if (!station) return;
    const title = el('div', 'hint');
    title.textContent = `駅 #${station.id} の名前を変更`;
    const row = el('div', 'row');
    const input = document.createElement('input');
    input.className = 'text-input';
    input.value = station.name;
    input.maxLength = 40;
    const rename = (): void => this.callbacks.onStationRename(station.id, input.value);
    const save = button('変更', rename);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') rename();
    });
    row.append(input, save);
    this.stationEditBody.append(title, row);
  }

  /**
   * 区間全体の曲率・勾配のグラフ。
   *
   * SVG は指している線形が変わったときだけ組み直し、いま見ている位置の
   * 縦線だけを毎フレーム動かす。
   */
  private updateGraph(inspect: PointInspection | null): void {
    if (!inspect) {
      if (this.graphProfile) {
        this.graphBody.innerHTML = '';
        this.graphProfile = null;
        this.graphCursor = null;
      }
      return;
    }
    if (inspect.profile !== this.graphProfile) {
      this.graphBody.innerHTML = renderInspectGraph(inspect);
      this.graphProfile = inspect.profile;
      this.graphCursor = this.graphBody.querySelector('.cursor');
    }
    const x = inspect.length > 1e-6 ? (inspect.s / inspect.length) * GRAPH_W : 0;
    this.graphCursor?.setAttribute('transform', `translate(${x.toFixed(1)} 0)`);
  }

  updateBuild(result: BuildResult): void {
    const s = result.stats;
    const rows: [string, string][] = [
      ['セグメント', `${s.segments}`],
      ['交差点', `${s.intersections}`],
      ['分岐器', `${s.turnouts}`],
      ['踏切', `${s.levelCrossings}`],
      ['駅', `${s.stations}`],
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

function select(
  options: readonly (readonly [string, string])[],
  initial: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = document.createElement('select');
  node.className = 'select-input';
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    node.append(option);
  }
  node.value = initial;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

function checkbox(
  label: string,
  initial: boolean,
  apply: (on: boolean) => void,
): { node: HTMLElement; input: HTMLInputElement } {
  const wrapper = el('label', 'check');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = initial;
  input.addEventListener('change', () => apply(input.checked));
  const span = document.createElement('span');
  span.textContent = label;
  wrapper.append(input, span);
  return { node: wrapper, input };
}

/**
 * 乗車モードの行。
 *
 * 車両が 1 両も走っていないことがある (敷き直した直後・車両表示を切った
 * とき)。そのときは待っていることが分かるようにする。
 */
function rideRows(ride: RideStatus): [string, string, string?][] {
  if (ride.phase === 'aim') {
    const target = ride.vehicle;
    const kind = ride.kind === 'train' ? '列車' : '自動車';
    return [
      ['視点', '乗る車両を選ぶ'],
      [
        '対象',
        target ? `${kind} #${target.id} (${(ride.speed * 3.6).toFixed(0)} km/h)` : '走っている車両がありません',
        target ? undefined : '#d98f6b',
      ],
      ['操作', 'クリックで乗車 / Esc で取消'],
    ];
  }
  if (!ride.vehicle) {
    return [
      ['視点', '一人称 (乗車)'],
      ['車両', '走っている車両を待っています'],
      ['操作', 'F / Esc で降りる'],
    ];
  }
  const kind = ride.kind === 'train' ? '列車' : '自動車';
  const rows: [string, string, string?][] = [
    ['視点', `一人称 (${kind} #${ride.vehicle.id})`],
    ['速度', `${(ride.speed * 3.6).toFixed(0)} km/h`],
    ['高さ', `${ride.pose.eye.y.toFixed(1)} m`],
  ];
  if (ride.cars > 1) rows.push(['編成', `${ride.cars} 両`]);
  if (Math.abs(ride.look.yaw) > 0.02 || Math.abs(ride.look.pitch) > 0.02) {
    rows.push(['見回し', `${((ride.look.yaw * 180) / Math.PI).toFixed(0)}° / ${((ride.look.pitch * 180) / Math.PI).toFixed(0)}°`]);
  }
  rows.push(['操作', 'ドラッグで見回す / N で次の車両 / F で降りる']);
  return rows;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/**
 * 確認モードの行。
 *
 * 曲線半径と勾配だけは規格に対する比で色を付ける (診断色と同じ配色)。
 * 全部に色を付けると、どこを見ればよいのか分からなくなる。
 */
function inspectRows(inspect: PointInspection | null): [string, string, string?][] {
  if (!inspect) return [['操作', '線形の上にカーソルを合わせる']];
  const cls = getClass(inspect.classId);
  const rows: [string, string, string?][] = [
    ['種別', cls.label],
    ['構造', formatStructure(inspect.structure)],
    ['弧長', formatStation(inspect.s, inspect.length)],
    ['高さ', `${inspect.y.toFixed(1)} m`],
    ['曲線半径', formatRadius(inspect.curvature), riskColor(inspect.curveRisk)],
    ['勾配', formatGrade(inspect.grade), riskColor(inspect.gradeRisk)],
    ['縦曲線半径', formatVerticalRadius(inspect.verticalRadius, inspect.verticalSecond)],
  ];
  if (inspect.station) {
    rows.unshift(
      ['駅', inspect.station.name],
      [
        '駅構内',
        `${inspect.station.trackIndex + 1}番線 / ${inspect.station.trackCount}線・${inspect.station.platformCount}ホーム`,
      ],
    );
  }
  // カントは線路だけ。道路では常に 0 なので出さない。
  if (inspect.cant !== null) {
    rows.push(['カント', formatCant(inspect.cant, inspect.cantRoll)]);
  }
  return rows;
}
