import type { VehicleDefinition } from '../schema.ts';

/**
 * 音階インバータ（通称「ドレミファインバータ」）の変調諸元。
 *
 * **コアには 1 行も足していない。** インバータの音は
 * 「出力周波数 → キャリア周波数」の折れ線（`asyncCarrier`）と、非同期から同期へ
 * 移るパルスモードの梯子だけで決まる。音階インバータはその折れ線を
 * **平らな段の階段**にしただけのものである。
 *
 * 磁気音の音程を決めているのはキャリア周波数そのものなので、段の高さを平均律の
 * 音名に合わせれば、そのまま音階として聞こえる。ふつうの GTO 車（`inverterSchema` の
 * 既定値）は段が 3 つしかなく、しかも音名とは無関係な 250/350/480Hz なので、
 * 「なんとなく段階的に上がる」だけで音階には聞こえない。違いはそれだけである。
 *
 * 減速時は出力周波数が下がるので、同じ折れ線を逆にたどって**音階が下りていく**。
 * これも作り込んでいるわけではなく、キャリアが出力周波数の関数であることの帰結。
 *
 * 段は 12 段（ソラシド レミファソ ラシドレ）。**音階が鳴っているのは発車から
 * 10km/h までのごく短いあいだ**で、実車と同じくすぐ通り過ぎる。
 *
 * 幅の決め方には 2 つ制約がある。
 *
 * 1 つは**下端**。停止していても、力行していればすべり周波数のぶんだけ出力周波数が
 * ある（定格すべり 2Hz なのでノッチ 4 で 2Hz、ノッチ 1 で 0.5Hz）。最初の段を
 * ほかと同じ幅にすると、発車した瞬間にはもう 2 段目に居ることになって最低音が
 * 鳴らない。そこで最初の段だけ 3Hz と広く取り、どのノッチでも必ずソ (G3) から
 * 始まるようにしてある。
 *
 * もう 1 つは**上端**。2 段目から先は 1 段 1.2Hz で、12 段目 (D5) へ届くのが
 * 出力周波数 15.2Hz — ノッチ 4 なら車速 9km/h、時間にして 3 秒ほどである。
 * 12 音を 3 秒で駆け上がるので、聞こえるのは一瞬になる。
 *
 * 音階が終わったあとも非同期のままで、最終段の 587Hz が基底周波数 41Hz
 * （車速 27km/h）まで平らに続く。ここで同期へ移るのは音階の都合ではなく、
 * キャリアと出力周波数の比が 14 まで下がって非同期では脈が出るためである。
 * だから聞こえ方は「短い音階 → 伸びた 1 音 → 同期へ移って音の性格が変わる」となり、
 * これが実車の順序そのものになる。
 *
 * 音名は平均律（A4 = 440Hz）。段の変わり目に 0.15〜0.2Hz の傾斜を入れてあるので、
 * 音は瞬間的に飛ばずわずかに滑る — 実車もこう聞こえる。
 */
const scaleInverter = {
  polePairs: 2,
  ratedSlipFrequency: 2.0,
  /** 41Hz で変調率が飽和し、同期 → 一パルスへ入る */
  baseFrequency: 41,
  asyncCarrier: [
    // 最初の段だけ広い（停止中のすべり 0.5〜2Hz を飲み込むため）
    [0.0, 196.0], // ソ (G3)
    [3.0, 196.0],
    [3.2, 220.0], // ラ (A3)
    [4.25, 220.0],
    [4.4, 246.94], // シ (B3)
    [5.45, 246.94],
    [5.6, 261.63], // ド (C4)
    [6.65, 261.63],
    [6.8, 293.66], // レ (D4)
    [7.85, 293.66],
    [8.0, 329.63], // ミ (E4)
    [9.05, 329.63],
    [9.2, 349.23], // ファ (F4)
    [10.25, 349.23],
    [10.4, 392.0], // ソ (G4)
    [11.45, 392.0],
    [11.6, 440.0], // ラ (A4)
    [12.65, 440.0],
    [12.8, 493.88], // シ (B4)
    [13.85, 493.88],
    [14.0, 523.25], // ド (C5)
    [15.05, 523.25],
    // 最終段。ここから基底周波数まで平らに伸ばす（音階のあとの「1 音」）
    [15.2, 587.33], // レ (D5)
    [41.0, 587.33],
  ] as [number, number][],
  /**
   * 音階を鳴らし切ったあとも非同期で引っ張り、41Hz で一気に同期 → 一パルスへ落とす。
   * 音階が終わったところではなく、そのさらに上で音の性格ががらりと変わる。
   */
  pulseModes: [
    { minFrequency: 0, pulses: 0 },
    { minFrequency: 41, pulses: 5 },
    { minFrequency: 48, pulses: 3 },
    { minFrequency: 55, pulses: 1 },
  ],
  modeHysteresis: 1.5,
  rotorSlots: 44,
  pinionTeeth: 17,
};

/** VVVF 主回路の共通仕様（M 車 2 両とも同じ） */
const motorSpec = {
  kind: 'vvvf' as const,
  motorCount: 4,
  gearRatio: 7.07,
  driveEfficiency: 0.97,
  /**
   * 走りは既定の通勤形（`commuter4.ts`）と同じにしてある。
   * 変調だけを入れ替えたときに音がどう変わるかを、そのまま聴き比べられる。
   */
  maxMotorTorque: 1010,
  constantTorqueSpeed: 35,
  constantPowerSpeed: 70,
  maxBrakingMotorTorque: 1100,
  regenFadeStartSpeed: 10,
  regenFadeEndSpeed: 3,
  lineVoltage: 1500,
  converterEfficiency: 0.97,
  inverter: scaleInverter,
};

/** 先頭車の走行抵抗係数 [kgf/t] */
const leadResistance = { a: 1.65, b: 0.0247, c: 0.00078 };
/** 中間車の走行抵抗係数 [kgf/t] */
const middleResistance = { a: 1.65, b: 0.0247, c: 0.00028 };

/**
 * 音階インバータ 通勤形電車 4 両編成（Tc - M - M - Tc）。
 *
 * 走行性能は既定の通勤形（`commuter4Vehicle`）とまったく同じで、**変調の諸元だけが
 * 違う**。引張力は 3 領域のトルク特性で決まっており、変調方式はその同じ出力を
 * どういうスイッチングで作るかという話にすぎないので、走りは 1 ミリも変わらない。
 * 変わるのは音と、HUD の「変調」行の表示だけである。
 *
 * 数値は日本の在来線通勤形電車の代表値であり、実在形式の諸元ではない。
 */
export const commuter4ScaleVehicle: VehicleDefinition = {
  id: 'commuter-4-scale',
  name: '通勤形 4 両編成 音階インバータ (2M2T)',
  maxSpeed: 120,

  cars: [
    {
      id: 'Tc1',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
    {
      id: 'M1',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'M2',
      type: 'M',
      tareMass: 32,
      fullLoadMass: 9,
      drivenAxleCount: 4,
      rotatingMassFactor: 0.09,
      resistance: middleResistance,
      traction: motorSpec,
    },
    {
      id: 'Tc2',
      type: 'Tc',
      tareMass: 25,
      fullLoadMass: 9,
      drivenAxleCount: 0,
      rotatingMassFactor: 0.05,
      resistance: leadResistance,
      traction: null,
    },
  ],

  coupler: {
    slack: 0.01,
    stiffness1: 2.0e6,
    travel1: 0.02,
    stiffness2: 2.0e7,
    damping: 2.0e5,
  },

  adhesion: {
    mu0: 0.33,
    speedCoefficient: 0.008,
    peakCreep: 0.012,
    kineticRatio: 0.6,
    sandingFactor: 1.25,
    creepReferenceSpeed: 1.8,
  },

  traction: {
    notchCount: 4,
    notchTorqueRatio: [0.25, 0.5, 0.75, 1.0],
    torqueRiseRate: 2.5,
    torqueFallRate: 4.0,
    loadCompensation: true,
    referenceLoadFactor: 0.5,
    targetAcceleration: 0,
  },

  brake: {
    notchCount: 8,
    maxServiceDeceleration: 3.5,
    emergencyDeceleration: 4.5,
    blending: true,
    loadCompensation: true,
    antiSkid: true,
    antiSkidOnEmergency: true,
    emergencyIsAirOnly: true,
    hasHoldingBrake: true,
  },

  curveResistanceCoefficient: 600,
  tunnelResistanceFactor: 1.6,
};
