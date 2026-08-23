import {
  ACESFilmicToneMapping,
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  Fog,
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
import { FOG_FAR, FOG_NEAR } from '../core/units';

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
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  /** 一人称視点に入る前の視点。降りたときに戻す。 */
  private savedView: { position: Vector3; target: Vector3; near: number } | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene.background = new Color(0x9fc4e0);
    // 霞む距離はマップの広さではなく見通しで決める (`FOG_NEAR`)。遠景は
    // 霞に沈むので、遠クリップ面は霞み切る距離の少し先までで足りる。
    this.scene.fog = new Fog(0xa8c8e0, FOG_NEAR, FOG_FAR);

    this.camera = new PerspectiveCamera(52, 1, 1, FOG_FAR * 1.6);
    this.camera.position.set(150, 180, 220);

    this.controls = new MapControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 20;
    // 引ける上限は「霞み切る手前」まで。マップに比例させると、広いマップでは
    // 何も見えない高さまで引けてしまう。
    this.controls.maxDistance = FOG_FAR * 0.75;
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

    this.scene.add(createSky());

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

  render(): void {
    // 一人称視点の間は、カメラを外から置いている。
    if (this.controls.enabled) this.controls.update();
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

/** 天頂から地平にかけて色が変わる簡単な空。 */
function createSky(): Mesh {
  const geometry = new SphereGeometry(FOG_FAR * 1.5, 24, 16);
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
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
