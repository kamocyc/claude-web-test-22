# src/railsim — 運転シミュレータの移植

`kamocyc/claude-web-test-19` (鉄道運転シミュレータ) から持ってきた区画。
**ここは飛び地である**。このディレクトリの中は移植元の書き方のままにしてあり、
こちら (TrackBuilder) の流儀には合わせていない。

| ここ | 移植元 | 中身 |
| --- | --- | --- |
| `core/` | `packages/core/src` | 物理・装置・信号・保安 (three.js も DOM も Node も使わない純粋な TypeScript) |
| `audio/` | `packages/audio/src` | 走行音の合成 (PWM から電磁音を作る DSP) |
| `vehicle/` | `packages/data/src` の車両側 | 車両データと、現場の単位を SI へ直すコンパイラ |

## 境界の約束

こちらのコードから `railsim/core` を直に触らない。**アダプタ 1 枚だけを通す**。

- 移植元は 24,000 行ある。こちらの `src` と同じ規模のものが増えたことになるので、
  境界がぼやけると、どちらの都合でどちらが動いているのか分からなくなる。
- 境界を守っておけば、向こうの更新をもう一度取り込み直せる。

## 移植で変えたところ

`core/` と `audio/` は**ほぼ無改造**である。変えたのは次の 2 点だけ:

1. `audio/dsp/curveSquealVoice.ts` — 使っていない `private readonly sampleRate`
   フィールドを素の引数にした (こちらの tsconfig は未使用フィールドを禁じている)。
2. `vehicle/` — 移植元は zod でスキーマ・既定値・実行時検証を作っていたが、
   **zod は依存に足さない**方針なので、型は `interface`、既定値は
   `applyVehicleDefaults` に書き直した。検証は落としてある
   (車両データはこのリポジトリ内の定数だけで、外から JSON を読む口が無い)。
   `compile.ts` は `vehicleSchema.parse` の 1 行を差し替えただけ。

拡張子つきの相対 import (`from '../brake/types.ts'`) は移植元のままで、
`tsconfig.json` の `allowImportingTsExtensions` で通している。

## 持ってこなかったもの

`packages/data` の**路線側** (`schema/route.ts` / `compile/route.ts` /
`assets/testLine.ts` / シナリオ)。あちらは「距離程に沿って曲線と勾配を書き下す」
データ形式で、こちらの網目状の線形とは別物である。こちらの線路から
`CompiledRoute` を作るのはアダプタの仕事になる。

## 検定

移植元のテストも一緒に持ってきてある (`test/railsim/`、461 ケース)。
import の宛先を変えた以外は無改造なので、**これが通ることが「物理が壊れずに
移った」ことの証明**になる。
