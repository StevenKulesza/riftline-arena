import * as THREE from 'three';

function needsDefaultFramebufferAntialiasing(): boolean {
  // Normal gameplay is resolved by EffectComposer. MSAA on the default
  // framebuffer cannot smooth the scene inside those off-screen targets; it
  // only adds bandwidth to the final full-screen copy. Direct-render QA paths
  // keep it enabled so existing visual captures retain their edge quality.
  const automatedCapture = typeof navigator !== 'undefined' && navigator.webdriver;
  const qaCapture = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('qa');
  return automatedCapture || qaCapture;
}

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: needsDefaultFramebufferAntialiasing(),
    alpha: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.96;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;
  return renderer;
}

export function resizeRenderer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  maxDpr = 2,
): boolean {
  const canvas = renderer.domElement;
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = getRenderDpr(maxDpr);
  const bufferWidth = Math.floor(width * dpr);
  const bufferHeight = Math.floor(height * dpr);
  const dprChanged = Math.abs(renderer.getPixelRatio() - dpr) > 0.001;
  const aspectChanged = Math.abs(camera.aspect - width / height) > 0.0001;
  const needsResize = dprChanged
    || aspectChanged
    || canvas.width !== bufferWidth
    || canvas.height !== bufferHeight;

  if (needsResize) {
    if (dprChanged) renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return needsResize;
}

export function getRenderDpr(
  maxDpr: number,
  devicePixelRatio = typeof window === 'undefined' ? 1 : window.devicePixelRatio,
): number {
  const safeCap = Number.isFinite(maxDpr) && maxDpr > 0 ? maxDpr : 1;
  const safeDeviceDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(safeDeviceDpr, safeCap);
}
