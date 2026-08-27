import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  PCFShadowMap,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { VIEW_DISTANCE } from '../core/units';

/**
 * 一人称視点のときの近クリップ面 [m]。
 *
 * 俯瞰の 1 m のままだと、目の前の路面や車体が切り取られる。近づけすぎると
 * 遠くで奥行きの精度が落ちるので、目の高さ (1.1〜2.4 m) に対して十分近い所で
 * 止める。
 */
const RIDE_NEAR = 0.4;

/**
 * 3D 表示まわり。レンダラ・カメラ・光源・空と、地形へのレイキャストを持つ。
 */
export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: MapControls;
  private readonly sun: DirectionalLight;
  /** 空のドーム。視点を包んだままにするので、いつも同じ空が見える。 */
  private readonly sky: Mesh;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  /** 一人称視点に入る前の視点。降りたときに戻す。 */
  private savedView: { position: Vector3; target: Vector3; near: number } | null = null;
  /** 進行中の注視点移動 (`panTo`)。 */
  private flight: { from: Vector3; to: Vector3; start: number; duration: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene.background = new Color(0x9fc4e0);
    // 遠景は霞ませない。地形の色と地図としての見通しをそのまま出す。
    this.camera = new PerspectiveCamera(52, 1, 1, VIEW_DISTANCE * 1.6);
    this.camera.position.set(150, 180, 220);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 20;
    // 引ける上限は見通す距離まで。マップに比例させると、広いマップでは
    // 何も見えない高さまで引けてしまう。
    this.controls.maxDistance = VIEW_DISTANCE * 0.75;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new AmbientLight(0xbcd0e6, 0.5));

    this.sun = new DirectionalLight(0xfff2df, 1.55);
    this.sun.position.set(-160, 240, 120);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const shadowExtent = 260;
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 900;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.sky = createSky();
    this.scene.add(this.sky);

    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize(): void {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 影のカメラを注視点に追従させ、広いマップでも影の解像度を保つ。 */
  private updateShadowCamera(): void {
    const t = this.controls.target;
    this.sun.position.set(t.x - 160, t.y + 240, t.z + 120);
    this.sun.target.position.copy(t);
    this.sun.target.updateMatrixWorld();
  }

  /**
   * 一人称視点に入る。いまの視点を控え、地図操作を止める。
   *
   * `MapControls` は `update()` のたびに注視点と球面座標からカメラを置き直す
   * ので、止めずに位置を書き込んでも次のフレームで戻されてしまう。
   */
  beginRide(): void {
    if (this.savedView) return;
    this.savedView = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
    };
    this.controls.enabled = false;
    this.camera.near = RIDE_NEAR;
    this.camera.updateProjectionMatrix();
  }

  /** 一人称視点をやめ、入る前の視点に戻す。 */
  endRide(): void {
    const saved = this.savedView;
    if (!saved) return;
    this.savedView = null;
    this.camera.position.copy(saved.position);
    this.controls.target.copy(saved.target);
    this.camera.near = saved.near;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.controls.enabled = true;
    this.controls.update();
  }

  /**
   * 一人称視点のカメラを、目の位置・向き・頭の上の向きから置く。
   *
   * `up` を渡すのはカントのため。鉛直に固定すると、車体だけが傾いて
   * 窓の外は水平のまま、という見え方になる。
   */
  placeEye(eye: Vector3, forward: Vector3, up: Vector3): void {
    this.camera.position.copy(eye);
    this.camera.up.copy(up);
    this.camera.lookAt(eye.x + forward.x, eye.y + forward.y, eye.z + forward.z);
    // 影のカメラは注視点に追従するので、見ている先を渡しておく。
    this.controls.target.copy(eye).addScaledVector(forward, 40);
  }

  /** 注視点から視点までの距離 [m]。 */
  get viewDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /**
   * 画面に対して平行移動する (注視点と視点を同じだけ動かす)。
   *
   * `forward` は画面の奥へ、`right` は画面の右へ進む距離 [m]。向きは
   * カメラの視線を水平面に落として決めるので、俯角や方位を変えても
   * 「W で画面の奥、D で画面の右」が変わらない。
   *
   * `MapControls.update()` は注視点からの相対位置でカメラを置き直すので、
   * 両方を同じだけ動かせば向きも距離もそのまま残る。
   */
  panScreen(forward: number, right: number): void {
    if (forward === 0 && right === 0) return;
    // 視線を水平面へ落とす。真下を向いていると長さが 0 になるので、
    // そのときは画面の上向き (カメラの向き) を代わりに使う。
    const ahead = new Vector3().subVectors(this.controls.target, this.camera.position);
    ahead.y = 0;
    if (ahead.lengthSq() < 1e-6) {
      ahead.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      ahead.y = 0;
    }
    const delta = screenPanDelta(ahead, forward, right);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  /**
   * 注視点を `to` へ滑らかに移す (向きも距離もそのまま)。
   *
   * 警告の一覧から飛ぶときに使う。瞬間移動させると、どこから来て
   * どこへ行ったのかが分からなくなるので、短い時間で滑らせる。
   */
  panTo(to: Vector3, seconds = 0.5): void {
    this.flight = {
      from: this.controls.target.clone(),
      to: to.clone(),
      start: performance.now(),
      duration: Math.max(1, seconds * 1000),
    };
  }

  /** 進行中の注視点移動をやめる (利用者が視点を触ったとき)。 */
  cancelPan(): void {
    this.flight = null;
  }

  private updateFlight(): void {
    const flight = this.flight;
    if (!flight) return;
    const t = Math.min(1, (performance.now() - flight.start) / flight.duration);
    // 出入りを滑らかにする (smoothstep)。
    const eased = t * t * (3 - 2 * t);
    const next = flight.from.clone().lerp(flight.to, eased);
    const delta = next.sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    if (t >= 1) this.flight = null;
  }

  render(): void {
    // 一人称視点の間は、カメラを外から置いている。
    if (this.controls.enabled) {
      this.updateFlight();
      this.controls.update();
    }
    // 空は視点に付いて回る。置いたままにすると、引いたときにドームの縁が
    // 空の中に見えてしまう。
    this.sky.position.copy(this.camera.position);
    this.updateShadowCamera();
    this.renderer.render(this.scene, this.camera);
  }

  /** 画面座標 (CSS ピクセル) を正規化デバイス座標に変換して保持する。 */
  setPointer(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  /**
   * 現在のポインタ位置から伸びるレイ (ワールド座標)。
   *
   * 地形や路面ではなく**車両**を指すのに使う。車両は毎フレーム動くので
   * シーングラフに問い合わせず、姿勢から直に当たり判定する (`hitBody`)。
   */
  ray(): { origin: Vector3; direction: Vector3 } {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return {
      origin: this.raycaster.ray.origin.clone(),
      direction: this.raycaster.ray.direction.clone(),
    };
  }

  /** 現在のポインタ位置から対象メッシュへレイキャストする。 */
  pick(targets: Mesh[]): Vector3 | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    return hits.length > 0 ? hits[0].point.clone() : null;
  }
}

/**
 * 画面に対する平行移動量。
 *
 * `ahead` は視線の水平成分 (長さは問わない)、`forward` は画面の奥へ、
 * `right` は画面の右へ進む距離 [m]。
 *
 * Y 上・右手系では、水平な視線 `(x, 0, z)` の右手は `(視線 × 上)` =
 * `(-z, 0, x)`。真上から見下ろす画面では、視線が -Z のとき右が +X に
 * なる (地図を北向きに見ているときの東)。
 */
export function screenPanDelta(ahead: Vector3, forward: number, right: number): Vector3 {
  const dir = ahead.clone();
  dir.y = 0;
  if (dir.lengthSq() < 1e-12) dir.set(0, 0, -1);
  dir.normalize();
  const side = new Vector3(-dir.z, 0, dir.x);
  return dir.multiplyScalar(forward).addScaledVector(side, right);
}

/** 天頂から地平にかけて色が変わる簡単な空。視点を中心に置いて使う。 */
function createSky(): Mesh {
  const geometry = new SphereGeometry(VIEW_DISTANCE * 1.5, 24, 16);
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new Color(0x4f86c6) },
      middleColor: { value: new Color(0xa9cbe6) },
      bottomColor: { value: new Color(0xd8e2e6) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 middleColor;
      uniform vec3 bottomColor;
      varying vec3 vPos;
      void main() {
        float h = normalize(vPos).y;
        vec3 c = h > 0.0
          ? mix(middleColor, topColor, smoothstep(0.0, 0.6, h))
          : mix(middleColor, bottomColor, smoothstep(0.0, -0.25, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  return mesh;
}
