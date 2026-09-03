import { Vector3 } from 'three';
import { NETWORK_CLASSES, getClass, type NetworkKind } from '../network/classes';
import { riskColor, viewUniforms } from '../render/materials';
import type { BuildResult, WorldWarning } from '../render/worldBuilder';
import type { ToolStatus } from './buildTool';
import type { StationToolSettings } from './buildTool';
import { stationPlatformRange, STATION_LENGTHS, type StationId } from '../network/station';
import { ZONE_LABELS, ZONE_TYPES, type ZoneType } from '../network/zoning';
import type { LineId } from '../network/line';
import type { LinePlan } from '../sim/lineRoute';
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

/**
 * 画面に出るツールの葉。
 *
 * `ToolMode` と種別 (道路 / 線路) の組を 1 つの名前にしたもの。敷設モードは
 * 道路と線路の両方を兼ねていて、違うのは選んでいる種別だけなので、
 * 並びの上ではそこを分けて見せる。
 */
export type ToolView = 'road' | 'track' | 'station' | 'line' | 'zone' | 'bulldoze' | 'inspect';

/** 上の並びに出るまとまり。鉄道は 3 つの葉を持つ。 */
type ToolCategory = 'road' | 'rail' | 'zone' | 'bulldoze' | 'inspect';

/** その葉はどのまとまりに属するか。 */
function categoryOf(view: ToolView): ToolCategory {
  return view === 'track' || view === 'station' || view === 'line' ? 'rail' : view;
}

export interface UiCallbacks {
  /** ツールを選ぶ。モードと種別の対応は呼び側が持つ。 */
  onTool: (view: ToolView) => void;
  onStationSettings: (patch: Partial<Omit<StationToolSettings, 'heading'>>) => void;
  onStationRotate: (steps: number) => void;
  onStationRename: (id: StationId, name: string) => void;
  /** 区画ツールで塗る用途を選ぶ (null なら消しゴム)。 */
  onZone: (zone: ZoneType | null) => void;
  /** 新しい路線を引き始める。 */
  onLineNew: () => void;
  /** 一覧から選んだ路線に、続けて駅を足せるようにする。 */
  onLineSelect: (id: LineId) => void;
  onLineRemove: (id: LineId) => void;
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
  /** 警告の行から、その場所へ視点を飛ばす。 */
  onFocus: (position: Vector3) => void;
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
  private readonly categoryButtons = new Map<ToolCategory, HTMLButtonElement>();
  private readonly subToolButtons = new Map<ToolView, HTMLButtonElement>();
  /** 鉄道のサブツールの行。鉄道を選んでいる間だけ出す。 */
  private readonly subToolRow: HTMLElement;
  /** 鉄道で直前に使った葉。鉄道に戻ってきたときここへ入る。 */
  private lastRailView: ToolView = 'track';
  /** ツールごとの設定のまとまり。選んだツールのものだけを出す。 */
  private readonly groups: { node: HTMLElement; views: ToolView[] }[] = [];
  private readonly classButtons = new Map<string, HTMLButtonElement>();
  private readonly parallelButtons = new Map<boolean, HTMLButtonElement>();
  private readonly zoneButtons = new Map<ZoneType | null, HTMLButtonElement>();
  private readonly lineBody: HTMLElement;
  /** 直前に描いた路線一覧の内容。毎フレーム組み直さないための控え。 */
  private lineHtml = '';
  /** いま駅を足している路線 (一覧で強調する)。 */
  private editingLine: LineId | null = null;
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

    // ツールの並び。ここだけが常に出ていて、下の設定は選んだツールのものに
    // 入れ替わる。全部を一度に並べると、いま効く設定がどれか分からない。
    left.append(sectionTitle('ツール'));
    const categories = el('div', 'row row-tools');
    for (const [category, label, hint] of [
      ['road', '道路', 'B'],
      ['rail', '鉄道', 'R'],
      ['zone', '区画', 'Z'],
      ['bulldoze', '撤去', 'X'],
      ['inspect', '確認', 'V'],
    ] as [ToolCategory, string, string][]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.innerHTML = `<span>${label}</span><small>${hint}</small>`;
      // 鉄道は 3 つの葉を持つので、直前に使った葉へ入る。
      button.addEventListener('click', () =>
        callbacks.onTool(category === 'rail' ? this.lastRailView : category),
      );
      this.categoryButtons.set(category, button);
      categories.append(button);
    }
    left.append(categories);

    // 鉄道の中身。線路・駅・路線はどれも鉄道の仕事なので、1 段下げて並べる。
    this.subToolRow = el('div', 'row row-subtools');
    for (const [view, label, hint] of [
      ['track', '線路', 'R'],
      ['station', '駅', 'T'],
      ['line', '路線', 'L'],
    ] as [ToolView, string, string][]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.innerHTML = `<span>${label}</span><small>${hint}</small>`;
      button.addEventListener('click', () => callbacks.onTool(view));
      this.subToolButtons.set(view, button);
      this.subToolRow.append(button);
    }
    left.append(this.subToolRow);

    /** ツールごとの設定のまとまり。`setTool` で出し入れする。 */
    const group = (title: string, views: ToolView[]): HTMLElement => {
      const node = el('div', 'group');
      node.append(sectionTitle(title));
      this.groups.push({ node, views });
      left.append(node);
      return node;
    };

    /** 種別の一覧。道路と線路で別のまとまりにする (同時には片方しか出ない)。 */
    const classGroup = (view: ToolView, kind: NetworkKind): void => {
      const node = group('種別', [view]);
      for (const cls of NETWORK_CLASSES) {
        if (cls.kind !== kind) continue;
        const button = el('button', 'chip wide') as HTMLButtonElement;
        button.innerHTML = `<span>${cls.label}</span><small>R≧${cls.minRadius} / ≦${(
          cls.maxGrade * 100
        ).toFixed(1)}%</small>`;
        button.addEventListener('click', () => callbacks.onClass(cls.id));
        this.classButtons.set(cls.id, button);
        node.append(button);
      }
    };
    classGroup('road', 'road');
    classGroup('track', 'rail');

    // 高さは駅にも効く (高架駅・地下駅)。
    const elevationGroup = group('高さ', ['road', 'track', 'station']);
    const elevationRow = el('div', 'row');
    elevationRow.append(
      button('−', () => callbacks.onElevation(-1)),
      (this.elevationLabel = el('span', 'elevation')),
      button('＋', () => callbacks.onElevation(1)),
    );
    elevationGroup.append(elevationRow, hint('PageUp / PageDown でも変更できます'));

    const parallelGroup = group('平行スナップ', ['road', 'track']);
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
    parallelGroup.append(
      parallelRow,
      hint('既存の線路・道路の隣から引くと、その線形に平行してスナップします (Ctrl で一時解除)'),
    );

    // ---- 駅
    const stationGroup = group('駅の設定', ['station']);
    this.stationNameInput = document.createElement('input');
    this.stationNameInput.className = 'text-input';
    this.stationNameInput.value = '駅 1';
    this.stationNameInput.maxLength = 40;
    this.stationNameInput.placeholder = '駅名';
    this.stationNameInput.addEventListener('input', () =>
      callbacks.onStationSettings({ name: this.stationNameInput.value }),
    );
    stationGroup.append(this.stationNameInput);

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

    const stationLengthRow = el('div', 'row');
    this.stationLengthSelect = select(
      STATION_LENGTHS.map((length) => [String(length), `${length} m`] as const),
      '120',
      (value) => callbacks.onStationSettings({ length: Number(value) as (typeof STATION_LENGTHS)[number] }),
    );
    this.stationHeadingLabel = el('span', 'elevation');
    stationLengthRow.append(
      this.stationLengthSelect,
      button('↺ (N)', () => callbacks.onStationRotate(-1)),
      button('↻ (M)', () => callbacks.onStationRotate(1)),
      this.stationHeadingLabel,
    );
    stationGroup.append(
      stationCounts,
      stationLengthRow,
      hint('駅長を選び、N / M で回転して空き地をクリックします'),
    );

    // ---- 区画
    const zoneGroup = group('区画の用途', ['zone']);
    const zoneRow = el('div', 'row');
    for (const [zone, label] of [
      ...ZONE_TYPES.map((zone) => [zone, ZONE_LABELS[zone]] as [ZoneType | null, string]),
      [null, '解除'] as [ZoneType | null, string],
    ]) {
      const button = el('button', 'chip') as HTMLButtonElement;
      button.textContent = label;
      if (zone) button.classList.add(`zone-${zone}`);
      button.addEventListener('click', () => {
        callbacks.onZone(zone);
        this.setZone(zone);
      });
      this.zoneButtons.set(zone, button);
      zoneRow.append(button);
    }
    zoneGroup.append(
      zoneRow,
      hint('道路沿いのマス目を塗ると建物が建ちます。広く塗るほどマスがまとまって大きな建物になります'),
    );

    // ---- 路線
    const lineGroup = group('路線', ['line']);
    const lineRow = el('div', 'row');
    lineRow.append(button('＋ 新しい路線', callbacks.onLineNew));
    this.lineBody = el('div', 'line-list');
    this.lineBody.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const item = target.closest('[data-line]') as HTMLElement | null;
      if (!item) return;
      const id = Number(item.dataset.line);
      if (target.closest('[data-remove]')) callbacks.onLineRemove(id);
      else callbacks.onLineSelect(id);
    });
    lineGroup.append(
      lineRow,
      this.lineBody,
      hint('駅のホームを順にクリックすると路線になり、列車がその経路を走ります (Esc で区切り)'),
    );

    // ---- 撤去・確認 (設定は無い。何が起きるかだけ言う)
    group('撤去', ['bulldoze']).append(
      hint('線形・駅・区画をクリックで撤去します。区画は塗りだけが消え、道路は残ります'),
    );
    group('確認', ['inspect']).append(
      hint('線形をクリックすると、その区間の曲率と勾配を右のグラフに出します'),
    );

    // ---- ここから下はツールに依らない設定。折りたたんでおく。
    const drawer = (title: string, open = false): HTMLElement => {
      const node = document.createElement('details');
      node.className = 'drawer';
      node.open = open;
      const summary = document.createElement('summary');
      summary.textContent = title;
      node.append(summary);
      left.append(node);
      return node;
    };

    const viewDrawer = drawer('表示');
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
      viewDrawer.append(box.node);
      toggle.apply(toggle.initial);
    }
    this.vehiclesToggle = inputs.get('vehicles')!;
    this.undergroundToggle = inputs.get('underground')!;

    const rideDrawer = drawer('視点');
    const rideRow = el('div', 'row');
    this.rideButton = button('乗車 (F)', callbacks.onRide);
    rideRow.append(this.rideButton, button('次の車両 (N)', callbacks.onRideNext));
    rideDrawer.append(
      rideRow,
      hint('乗る車両をクリックで選びます。運転台に乗ったら、ドラッグで見回し、Esc / F で降ります'),
    );

    const mapDrawer = drawer('マップ');
    const mapRow = el('div', 'row');
    mapRow.append(
      button('地形を再生成', callbacks.onRegenerate),
      button('サンプル', callbacks.onDemo),
      button('ダイヤ型 IC', () => callbacks.onInterchange('diamond')),
      button('トランペット IC', () => callbacks.onInterchange('trumpet')),
      button('全消去', callbacks.onClear),
    );
    mapDrawer.append(mapRow);

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

    const help = document.createElement('details');
    help.className = 'help';
    const helpSummary = document.createElement('summary');
    helpSummary.textContent = '操作';
    help.append(helpSummary);
    const helpBody = el('div', 'help-body');
    help.append(helpBody);
    helpBody.innerHTML = [
      '<b>左クリック</b> 始点 → もう一度で確定 (続けて連結)',
      '<b>右クリック / Esc</b> 中断',
      '<b>Shift</b> 直線・15° スナップ / <b>Ctrl</b> スナップ解除',
      '<b>B</b> 道路 / <b>R</b> 線路 / <b>X</b> 撤去 / <b>V</b> 確認',
      '<b>T</b> 駅配置 / <b>N・M</b> 駅を回転',
      '<b>Z</b> 区画 (道路沿いを塗ると建物が建つ)',
      '<b>L</b> 路線 (駅のホームを順にクリックすると列車が走る)',
      '<b>U</b> 地下ビュー (地形を透過)',
      '<b>W・A・S・D</b> 視点を平行移動 / <b>右ドラッグ</b> 視点移動 / <b>ホイール</b> 拡大縮小',
      '<b>F</b> 乗車 (車両をクリックで選ぶ) / <b>N</b> 次の車両 / 乗車中はドラッグで見回す',
    ]
      .map((line) => `<div>${line}</div>`)
      .join('');

    const undergroundBadge = el('div', 'underground-badge');
    undergroundBadge.textContent = '地下ビュー · U で地上へ戻る';

    root.append(left, right, help, undergroundBadge);
  }

  /** 選んでいるツールを反映する。 */
  setTool(view: ToolView): void {
    const category = categoryOf(view);
    if (category === 'rail') this.lastRailView = view;
    for (const [key, button] of this.categoryButtons) {
      button.classList.toggle('active', key === category);
    }
    // 鉄道の中身は、鉄道を選んでいる間だけ出す。
    this.subToolRow.hidden = category !== 'rail';
    for (const [key, button] of this.subToolButtons) {
      button.classList.toggle('active', key === view);
    }
    // 選んだツールの設定だけを出す。
    for (const group of this.groups) group.node.hidden = !group.views.includes(view);
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

  /** 選んでいる区画の用途を反映する。 */
  setZone(zone: ZoneType | null): void {
    for (const [key, button] of this.zoneButtons) {
      button.classList.toggle('active', key === zone);
    }
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
          : status.mode === 'zone'
            ? `道路沿いをクリックして${status.zone ? ZONE_LABELS[status.zone] : '用途を解除'}`
          : status.mode === 'line'
            ? status.hoverStation
              ? `${status.hoverStation.name} を路線に追加`
              : '停める駅のホームをクリック'
          : '対象をクリック',
      ]);
    }
    if (!ride && status.mode === 'line' && status.line) {
      rows.push([
        status.line.name,
        status.line.stops.length > 0 ? status.line.stops.join(' → ') : '駅を選んでください',
      ]);
    }
    if (!ride && status.parallelTo !== null) rows.push(['平行', `線形 #${status.parallelTo} に沿う`]);
    // 撤去・確認モードではスナップしないので、この行は出さない。
    if (!ride && status.mode === 'build') {
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
    if (this.editingLine !== (status.line?.id ?? null)) {
      this.editingLine = status.line?.id ?? null;
      this.markEditingLine();
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
   * 路線の一覧。
   *
   * 経路は敷設のたびに引き直されるので、ここには**その時点で走れるか**を
   * 出す。繋がっていない区間があれば、どこが繋がっていないかを書く。
   */
  private updateLines(plans: LinePlan[]): void {
    const html =
      plans.length === 0
        ? '<div class="hint">路線はまだありません</div>'
        : plans
            .map((plan) => {
              const swatch = plan.color.map(toSrgb).join(',');
              const stops = plan.stops.map((stop) => escapeHtml(stop.name)).join(' → ');
              const state = !plan.runnable
                ? plan.stops.length < 2
                  ? '駅をもう 1 つ選んでください'
                  : '線路が繋がっていません'
                : plan.seamless
                  ? plan.singleTrack
                    ? // 同じ線路を往復する。行き違いができないので 1 編成。
                      `折り返し ${plan.length.toFixed(0)} m · 1 編成`
                    : `環状 ${plan.length.toFixed(0)} m`
                  : `${plan.length.toFixed(0)} m · ${plan.runs.length} 区間`;
              const gaps = plan.gaps
                .map(
                  (gap) =>
                    `<div class="line-gap">${escapeHtml(gap.from)} → ${escapeHtml(gap.to)} は線路が繋がっていません</div>`,
                )
                .join('');
              return [
                `<div class="line-item" data-line="${plan.id}">`,
                `<span class="line-swatch" style="background:rgb(${swatch})"></span>`,
                `<span class="line-text"><b>${escapeHtml(plan.name)}</b>`,
                `<small>${stops || '停車駅なし'}</small>`,
                `<small>${state}</small>${gaps}</span>`,
                '<button class="chip line-remove" data-remove="1">✕</button>',
                '</div>',
              ].join('');
            })
            .join('');
    if (html === this.lineHtml) return;
    this.lineHtml = html;
    this.lineBody.innerHTML = html;
    this.markEditingLine();
  }

  /** 一覧の中で、いま駅を足している路線に印を付ける。 */
  private markEditingLine(): void {
    for (const item of this.lineBody.querySelectorAll<HTMLElement>('[data-line]')) {
      item.classList.toggle('active', Number(item.dataset.line) === this.editingLine);
    }
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
    this.updateLines(result.lines);
    const s = result.stats;
    const rows: [string, string][] = [
      ['セグメント', `${s.segments}`],
      ['交差点', `${s.intersections}`],
      ['分岐器', `${s.turnouts}`],
      ['踏切', `${s.levelCrossings}`],
      ['駅', `${s.stations}`],
      ['路線', `${s.lines}`],
      ['建物', `${s.buildings} 棟 / ${s.zoneCells} マス`],
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

    this.renderWarnings(result.warnings);
  }

  /** 警告の一覧を描き直す。 */
  private renderWarnings(warnings: readonly WorldWarning[]): void {
    const groups = groupWarnings(warnings);
    this.warningBody.replaceChildren();
    if (groups.length === 0) {
      const ok = el('div', 'line ok');
      ok.textContent = '問題はありません';
      this.warningBody.append(ok);
      return;
    }
    for (const group of groups.slice(0, MAX_WARNING_LINES)) {
      this.warningBody.append(this.warningLine(group));
    }
  }

  private warningLine(group: WarningGroup): HTMLElement {
    const total = group.places.length;
    const severity = group.severity === 'error' ? 'bad' : 'warn';
    // 場所が分かっているものだけ押せる (飛ぶ先が無いと空振りになる)。
    const line = el(total > 0 ? 'button' : 'div', `line ${severity}`);
    // 文言は素の文字として入れる (`.readout .line span` は見出し用の
    // 薄い色なので、包むと警告の色が消えてしまう)。
    line.append(document.createTextNode(group.message));
    if (total > 1) {
      const count = el('b');
      count.textContent = `×${total}`;
      line.append(count);
    }
    if (total > 0) {
      line.title = total > 1 ? `クリックで ${total} か所を順に表示` : 'クリックでその場所へ';
      line.addEventListener('click', () => {
        const place = nextPlace(group);
        if (place) this.callbacks.onFocus(place);
      });
    }
    return line;
  }
}

/** 警告の一覧に出す行数の上限。 */
const MAX_WARNING_LINES = 8;

/** 一覧に出す 1 行ぶんの警告 (同じ内容をまとめたもの)。 */
export interface WarningGroup {
  message: string;
  severity: WorldWarning['severity'];
  /** その警告が出ている場所。行を押すたびに次へ進む。 */
  places: Vector3[];
  /** 次に見る場所の番号。 */
  next: number;
}

/**
 * 同じ内容の警告を 1 行にまとめる。
 *
 * 場所は捨てずに全部持っておく。同じ文言が何十か所にも出ることがあり、
 * 「どこの話なのか」は行を押して 1 か所ずつ見て回れるようにするため。
 * 出た順を保つので、一覧の並びは作り直しても変わらない。
 */
export function groupWarnings(warnings: readonly WorldWarning[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup>();
  for (const warning of warnings) {
    let group = groups.get(warning.message);
    if (!group) {
      group = { message: warning.message, severity: warning.severity, places: [], next: 0 };
      groups.set(warning.message, group);
    }
    if (warning.position) group.places.push(warning.position.clone());
    // 同じ文言で重さが混ざったら、重い方の色で出す。
    if (warning.severity === 'error') group.severity = 'error';
  }
  return [...groups.values()];
}

/** その警告の次の場所 (押すたびに 1 か所ずつ進み、最後まで行くと戻る)。 */
export function nextPlace(group: WarningGroup): Vector3 | null {
  if (group.places.length === 0) return null;
  const place = group.places[group.next % group.places.length];
  group.next = (group.next + 1) % group.places.length;
  return place;
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

/** リニア色 (描画で使う値) を、CSS に書く sRGB の 0〜255 に直す。 */
function toSrgb(value: number): number {
  return Math.round(255 * Math.min(1, Math.max(0, value)) ** (1 / 2.2));
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
