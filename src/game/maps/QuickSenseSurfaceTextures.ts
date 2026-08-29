import * as THREE from 'three';

const TEXTURE_SIZE = 512;
const TAU = Math.PI * 2;

export type QuickSenseSurfaceTextures = {
  panelAlbedo: THREE.CanvasTexture;
  panelNormal: THREE.CanvasTexture;
  panelRoughness: THREE.CanvasTexture;
  terrainAlbedo: THREE.CanvasTexture;
  terrainNormal: THREE.CanvasTexture;
  terrainRoughness: THREE.CanvasTexture;
  rockAlbedo: THREE.CanvasTexture;
  rockNormal: THREE.CanvasTexture;
  rockRoughness: THREE.CanvasTexture;
  all: THREE.CanvasTexture[];
};

function hash(x: number, y: number, seed: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return value - Math.floor(value);
}

function fractalNoise(x: number, y: number, seed: number): number {
  return (
    Math.sin(x * TAU / 91 + seed) * 0.24
    + Math.cos(y * TAU / 67 - seed * 0.7) * 0.2
    + Math.sin((x + y) * TAU / 37 + seed * 1.9) * 0.11
    + (hash(Math.floor(x / 3), Math.floor(y / 3), seed) - 0.5) * 0.24
  );
}

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  return canvas;
}

function context2d(canvas: HTMLCanvasElement, label: string): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`QuickSense could not create ${label}.`);
  return context;
}

function canvasTexture(
  canvas: HTMLCanvasElement,
  name: string,
  colorSpace: THREE.ColorSpace,
  repeat: number,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = name;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function normalTexture(
  name: string,
  repeat: number,
  heightAt: (x: number, y: number) => number,
  strength: number,
): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, name);
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  const heights = new Float32Array(TEXTURE_SIZE * TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      heights[y * TEXTURE_SIZE + x] = heightAt(x, y);
    }
  }
  const sample = (x: number, y: number): number => heights[
    ((y + TEXTURE_SIZE) % TEXTURE_SIZE) * TEXTURE_SIZE
      + ((x + TEXTURE_SIZE) % TEXTURE_SIZE)
  ];
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
      const inverseLength = 1 / Math.hypot(dx, dy, 1);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = Math.round((-dx * inverseLength * 0.5 + 0.5) * 255);
      image.data[offset + 1] = Math.round((-dy * inverseLength * 0.5 + 0.5) * 255);
      image.data[offset + 2] = Math.round(inverseLength * 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvasTexture(canvas, name, THREE.NoColorSpace, repeat);
}

function panelHeight(x: number, y: number): number {
  const localX = x % 256;
  const localY = y % 128;
  const edgeDistance = Math.min(localX, 255 - localX, localY, 127 - localY);
  const seam = edgeDistance < 3 ? -1.25 : edgeDistance < 7 ? 0.32 : 0;
  const fastenerDistance = Math.min(
    Math.hypot(localX - 15, localY - 15),
    Math.hypot(localX - 241, localY - 113),
  );
  const fastener = fastenerDistance < 4 ? -0.72 : fastenerDistance < 7 ? 0.18 : 0;
  const machining = Math.sin((x * 0.91 + y * 0.27) * TAU / 31) * 0.035;
  const scratchA = Math.abs((y - (x * 0.29 + 31)) % 193) < 0.72 ? -0.25 : 0;
  const scratchB = Math.abs((y + x * 0.16 + 76) % 239) < 0.55 ? -0.18 : 0;
  return seam + fastener + machining + scratchA + scratchB + fractalNoise(x, y, 11) * 0.18;
}

function createPanelAlbedo(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense panel albedo');
  context.fillStyle = '#4b5357';
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const panelWidth = 256;
  const panelHeight = 128;
  const panelColors = ['#9ba2a5', '#858e92', '#a4aaac', '#8f979a', '#7f898d', '#969da0', '#899296', '#a0a5a7'];
  for (let row = 0; row < TEXTURE_SIZE / panelHeight; row += 1) {
    for (let column = 0; column < TEXTURE_SIZE / panelWidth; column += 1) {
      const x = column * panelWidth;
      const y = row * panelHeight;
      const variation = column + row * 2;
      context.fillStyle = panelColors[variation % panelColors.length];
      context.fillRect(x + 5, y + 5, panelWidth - 10, panelHeight - 10);

      const ageWash = context.createLinearGradient(x, y, x + panelWidth, y + panelHeight);
      ageWash.addColorStop(0, 'rgba(235,241,242,0.10)');
      ageWash.addColorStop(0.46, 'rgba(255,255,255,0)');
      ageWash.addColorStop(1, 'rgba(17,24,28,0.16)');
      context.fillStyle = ageWash;
      context.fillRect(x + 5, y + 5, panelWidth - 10, panelHeight - 10);

      context.strokeStyle = 'rgba(14,20,24,0.7)';
      context.lineWidth = 3;
      context.strokeRect(x + 3.5, y + 3.5, panelWidth - 7, panelHeight - 7);
      context.strokeStyle = 'rgba(235,242,244,0.18)';
      context.lineWidth = 1;
      context.strokeRect(x + 7.5, y + 7.5, panelWidth - 15, panelHeight - 15);

      if (variation % 3 === 0) {
        context.strokeStyle = 'rgba(29,38,42,0.22)';
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x + 70, y + 13);
        context.lineTo(x + 70, y + panelHeight - 13);
        context.stroke();
      } else if (variation % 3 === 1) {
        context.fillStyle = 'rgba(25,33,37,0.16)';
        context.fillRect(x + panelWidth - 53, y + 15, 33, 13);
        context.strokeStyle = 'rgba(225,231,232,0.12)';
        context.strokeRect(x + panelWidth - 51.5, y + 16.5, 30, 10);
      }

      context.fillStyle = 'rgba(18,23,26,0.72)';
      for (const [fastenerX, fastenerY] of [[15, 15], [panelWidth - 15, panelHeight - 15]] as const) {
        context.beginPath();
        context.arc(x + fastenerX, y + fastenerY, 3.2, 0, TAU);
        context.fill();
        context.fillStyle = 'rgba(201,209,211,0.24)';
        context.fillRect(x + fastenerX - 1.5, y + fastenerY - 2, 3, 1);
        context.fillStyle = 'rgba(18,23,26,0.72)';
      }

      for (let fleck = 0; fleck < 42; fleck += 1) {
        const px = x + 9 + hash(fleck, variation, 19) * (panelWidth - 18);
        const py = y + 9 + hash(variation, fleck, 31) * (panelHeight - 18);
        const alpha = 0.018 + hash(fleck, variation, 47) * 0.04;
        context.fillStyle = hash(fleck, variation, 53) > 0.46
          ? `rgba(238,243,243,${alpha})`
          : `rgba(16,23,27,${alpha * 1.35})`;
        const radius = 0.35 + hash(fleck, variation, 61) * 1.1;
        context.fillRect(px, py, radius, radius);
      }
    }
  }
  context.strokeStyle = 'rgba(28,35,39,0.26)';
  context.lineWidth = 1;
  for (let scratch = 0; scratch < 15; scratch += 1) {
    const x = hash(scratch, 1, 71) * TEXTURE_SIZE;
    const y = hash(scratch, 2, 73) * TEXTURE_SIZE;
    const length = 18 + hash(scratch, 3, 79) * 52;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + length, y - length * (0.18 + hash(scratch, 4, 83) * 0.2));
    context.stroke();
  }
  return canvasTexture(canvas, 'QuickSensePanelAlbedo', THREE.SRGBColorSpace, 1.35);
}

function createPanelRoughness(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense panel roughness');
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const localX = x % 256;
      const localY = y % 128;
      const edgeDistance = Math.min(localX, 255 - localX, localY, 127 - localY);
      const panelVariation = ((Math.floor(x / 256) * 19 + Math.floor(y / 128) * 13) % 31) - 15;
      const abrasion = Math.sin((x * 0.73 + y * 0.19) * TAU / 43) * 8;
      const grime = edgeDistance < 7 ? 32 : 0;
      const value = THREE.MathUtils.clamp(183 + panelVariation + abrasion + fractalNoise(x, y, 97) * 34 + grime, 108, 242);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  context.strokeStyle = '#6c6c6c';
  context.lineWidth = 1;
  for (let scratch = 0; scratch < 18; scratch += 1) {
    const x = hash(scratch, 2, 101) * TEXTURE_SIZE;
    const y = hash(scratch, 3, 103) * TEXTURE_SIZE;
    context.beginPath();
    context.moveTo(x, y);
    context.lineTo(x + 24 + hash(scratch, 4, 107) * 55, y - 8 - hash(scratch, 5, 109) * 13);
    context.stroke();
  }
  return canvasTexture(canvas, 'QuickSensePanelRoughness', THREE.NoColorSpace, 1.35);
}

function createTerrainAlbedo(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense terrain albedo');
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const grain = fractalNoise(x, y, 131);
      const sediment = Math.sin((x * 0.23 + y) * TAU / 113) * 4;
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = THREE.MathUtils.clamp(218 + grain * 23 + sediment, 185, 238);
      image.data[offset + 1] = THREE.MathUtils.clamp(221 + grain * 20 + sediment, 190, 240);
      image.data[offset + 2] = THREE.MathUtils.clamp(211 + grain * 18 + sediment * 0.7, 184, 231);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  for (let stone = 0; stone < 170; stone += 1) {
    const x = hash(stone, 2, 137) * TEXTURE_SIZE;
    const y = hash(stone, 3, 139) * TEXTURE_SIZE;
    const radius = 0.35 + hash(stone, 5, 149) * 1.7;
    const alpha = 0.045 + hash(stone, 7, 151) * 0.07;
    context.fillStyle = hash(stone, 11, 157) > 0.55
      ? `rgba(235,238,226,${alpha})`
      : `rgba(59,70,64,${alpha})`;
    context.beginPath();
    context.ellipse(x, y, radius * 1.5, radius, hash(stone, 13, 163) * Math.PI, 0, TAU);
    context.fill();
  }
  return canvasTexture(canvas, 'QuickSenseTerrainAlbedo', THREE.SRGBColorSpace, 2.4);
}

function terrainHeight(x: number, y: number): number {
  const compactedGrain = fractalNoise(x, y, 173) * 0.38;
  const aggregate = (hash(Math.floor(x / 5), Math.floor(y / 5), 179) - 0.5) * 0.36;
  const shallowRunoff = Math.sin((x * 0.19 + y) * TAU / 127) * 0.06;
  return compactedGrain + aggregate + shallowRunoff;
}

function createTerrainRoughness(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense terrain roughness');
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const compressedBand = Math.sin((x * 0.17 + y) * TAU / 121) * 6;
      const value = THREE.MathUtils.clamp(222 + fractalNoise(x, y, 181) * 31 + compressedBand, 176, 249);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvasTexture(canvas, 'QuickSenseTerrainRoughness', THREE.NoColorSpace, 2.4);
}

function rockHeight(x: number, y: number): number {
  const layers = Math.sin(y * TAU / 41 + Math.sin(x * TAU / 181) * 1.8) * 0.31;
  const secondaryLayers = Math.sin(y * TAU / 13 + x * 0.017) * 0.09;
  const fractureA = Math.abs((x + y * 0.21 + 38) % 173) < 1.2 ? -0.9 : 0;
  const fractureB = Math.abs((x - y * 0.38 + 92) % 229) < 0.9 ? -0.65 : 0;
  return layers + secondaryLayers + fractureA + fractureB + fractalNoise(x, y, 191) * 0.32;
}

function createRockAlbedo(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense rock albedo');
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const grain = fractalNoise(x, y, 193);
      const strata = Math.sin(y * TAU / 47 + Math.sin(x * TAU / 179) * 1.45);
      const secondaryStrata = Math.sin(y * TAU / 15 + x * 0.019) * 0.35;
      const fracture = (
        Math.abs((x + y * 0.21 + 38) % 173) < 1.35
        || Math.abs((x - y * 0.38 + 92) % 229) < 1.05
      ) ? 1 : 0;
      const mineralWash = Math.sin((x * 0.31 - y * 0.08) * TAU / 137) * 4;
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = THREE.MathUtils.clamp(
        224 + grain * 25 + strata * 11 + secondaryStrata * 7 + mineralWash - fracture * 44,
        146,
        248,
      );
      image.data[offset + 1] = THREE.MathUtils.clamp(
        214 + grain * 21 + strata * 8 + secondaryStrata * 5 + mineralWash * 0.58 - fracture * 48,
        132,
        239,
      );
      image.data[offset + 2] = THREE.MathUtils.clamp(
        198 + grain * 18 + strata * 5 + secondaryStrata * 4 - fracture * 51,
        116,
        225,
      );
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvasTexture(canvas, 'QuickSenseRockAlbedo', THREE.SRGBColorSpace, 1);
}

function createRockRoughness(): THREE.CanvasTexture {
  const canvas = createCanvas();
  const context = context2d(canvas, 'QuickSense rock roughness');
  const image = context.createImageData(TEXTURE_SIZE, TEXTURE_SIZE);
  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const strata = Math.sin(y * TAU / 43 + Math.sin(x * TAU / 181)) * 7;
      const value = THREE.MathUtils.clamp(232 + fractalNoise(x, y, 197) * 27 + strata, 188, 253);
      const offset = (y * TEXTURE_SIZE + x) * 4;
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvasTexture(canvas, 'QuickSenseRockRoughness', THREE.NoColorSpace, 1);
}

export function createQuickSenseSurfaceTextures(): QuickSenseSurfaceTextures {
  const panelAlbedo = createPanelAlbedo();
  const panelNormal = normalTexture('QuickSensePanelNormal', 1.35, panelHeight, 1.35);
  const panelRoughness = createPanelRoughness();
  const terrainAlbedo = createTerrainAlbedo();
  const terrainNormal = normalTexture('QuickSenseTerrainNormal', 2.4, terrainHeight, 1.15);
  const terrainRoughness = createTerrainRoughness();
  const rockAlbedo = createRockAlbedo();
  const rockNormal = normalTexture('QuickSenseRockNormal', 1, rockHeight, 1.55);
  const rockRoughness = createRockRoughness();
  return {
    panelAlbedo,
    panelNormal,
    panelRoughness,
    terrainAlbedo,
    terrainNormal,
    terrainRoughness,
    rockAlbedo,
    rockNormal,
    rockRoughness,
    all: [
      panelAlbedo,
      panelNormal,
      panelRoughness,
      terrainAlbedo,
      terrainNormal,
      terrainRoughness,
      rockAlbedo,
      rockNormal,
      rockRoughness,
    ],
  };
}

export function applyGroundedCelDepth(
  material: THREE.MeshStandardMaterial,
  strength: number,
  bands = 7,
): void {
  const safeStrength = THREE.MathUtils.clamp(strength, 0, 0.24);
  const safeBands = THREE.MathUtils.clamp(Math.round(bands), 5, 10);
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
        float riftlineLuma = max(dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722)), 0.001);
        float riftlineBand = (floor(riftlineLuma * ${safeBands.toFixed(1)}) + 0.5) / ${safeBands.toFixed(1)};
        float riftlineHighlightGuard = 1.0 - smoothstep(0.72, 1.42, riftlineLuma);
        float riftlineDepthRatio = clamp(riftlineBand / riftlineLuma, 0.84, 1.12);
        outgoingLight *= mix(1.0, riftlineDepthRatio, ${safeStrength.toFixed(3)} * riftlineHighlightGuard);
        #include <opaque_fragment>
      `,
    );
  };
  material.customProgramCacheKey = () => `quicksense-grounded-depth-${safeStrength.toFixed(3)}-${safeBands}`;
  material.needsUpdate = true;
}
