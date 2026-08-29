import { assetUrl } from './assets/assetUrl';

type LogoCell = Readonly<{
  alpha: number;
  blue: number;
  column: number;
  edgeMask: number;
  glyph: string;
  luminance: number;
  row: number;
}>;

type ProjectedGlyph = Readonly<{
  alpha: number;
  depth: number;
  fill: string;
  glow: string;
  glyph: string;
  scale: number;
  x: number;
  y: number;
}>;

const SOURCE_COLUMNS = 120;
const SOURCE_ROWS = 32;
const EMBLEM_COLUMNS = 40;
const ASCII_RAMP = '.:-=+*#%@';
const FRAME_INTERVAL_MS = 1000 / 18;
const EMBLEM_REVOLUTION_SECONDS = 20;
const GLOW_STRENGTH = 0.85;
const SOURCE_URL = assetUrl('assets/ui/rift-logo.png');
const FONT_STACK = '"Courier New", "Liberation Mono", monospace';
const EDGE_LEFT = 1;
const EDGE_RIGHT = 2;
const EDGE_TOP = 4;
const EDGE_BOTTOM = 8;

const clamp = (value: number, minimum = 0, maximum = 1): number => Math.min(maximum, Math.max(minimum, value));

const mix = (from: number, to: number, amount: number): number => Math.round(from + (to - from) * clamp(amount));

const color = (from: readonly [number, number, number], to: readonly [number, number, number], amount: number): string =>
  `rgb(${mix(from[0], to[0], amount)} ${mix(from[1], to[1], amount)} ${mix(from[2], to[2], amount)})`;

const createBuffer = (): HTMLCanvasElement => document.createElement('canvas');

const context2d = (canvas: HTMLCanvasElement): CanvasRenderingContext2D => {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Rift ASCII logo requires Canvas 2D support.');
  return context;
};

const loadLogo = async (): Promise<HTMLImageElement> => {
  const image = new Image();
  image.decoding = 'async';
  image.src = SOURCE_URL;
  await image.decode();
  return image;
};

const sampleLogo = (image: HTMLImageElement): readonly LogoCell[] => {
  const source = createBuffer();
  source.width = SOURCE_COLUMNS;
  source.height = SOURCE_ROWS;
  const context = context2d(source);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, SOURCE_COLUMNS, SOURCE_ROWS);
  context.drawImage(image, 0, 0, SOURCE_COLUMNS, SOURCE_ROWS);

  const pixels = context.getImageData(0, 0, SOURCE_COLUMNS, SOURCE_ROWS).data;
  const cells: LogoCell[] = [];

  for (let row = 0; row < SOURCE_ROWS; row += 1) {
    for (let column = 0; column < SOURCE_COLUMNS; column += 1) {
      const offset = (row * SOURCE_COLUMNS + column) * 4;
      const red = pixels[offset] ?? 0;
      const green = pixels[offset + 1] ?? 0;
      const blueChannel = pixels[offset + 2] ?? 0;
      const alpha = (pixels[offset + 3] ?? 0) / 255;
      if (alpha < 0.09) continue;

      const luminance = (red * 0.2126 + green * 0.7152 + blueChannel * 0.0722) / 255;
      const blue = clamp((blueChannel - Math.max(red, green) * 0.86) / 150);
      const density = clamp(alpha * (0.34 + luminance * 0.66));
      const rampIndex = Math.min(ASCII_RAMP.length - 1, Math.floor(density * ASCII_RAMP.length));

      cells.push({
        alpha,
        blue,
        column,
        edgeMask: 0,
        glyph: ASCII_RAMP[rampIndex] ?? ASCII_RAMP[0],
        luminance,
        row,
      });
    }
  }

  const occupied = new Set(
    cells
      .filter((cell) => cell.column < EMBLEM_COLUMNS)
      .map((cell) => `${cell.column}:${cell.row}`),
  );

  return cells.map((cell) => {
    if (cell.column >= EMBLEM_COLUMNS) return cell;
    let edgeMask = 0;
    if (!occupied.has(`${cell.column - 1}:${cell.row}`)) edgeMask |= EDGE_LEFT;
    if (!occupied.has(`${cell.column + 1}:${cell.row}`)) edgeMask |= EDGE_RIGHT;
    if (!occupied.has(`${cell.column}:${cell.row - 1}`)) edgeMask |= EDGE_TOP;
    if (!occupied.has(`${cell.column}:${cell.row + 1}`)) edgeMask |= EDGE_BOTTOM;
    return { ...cell, edgeMask };
  });
};

class RiftAsciiLogo {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly frontBuffer = createBuffer();
  private readonly depthBuffer = createBuffer();
  private readonly energyBuffer = createBuffer();
  private readonly resizeObserver: ResizeObserver;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private cells: readonly LogoCell[] = [];
  private emblemCells: readonly LogoCell[] = [];
  private frameRequest = 0;
  private lastRenderedAt = -Infinity;
  private logicalWidth = 0;
  private logicalHeight = 0;
  private deviceScale = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.context = context2d(canvas);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.reducedMotion.addEventListener('change', this.handleMotionChange);
    document.addEventListener('rift:settings', this.handleMotionChange);
  }

  async start(): Promise<void> {
    this.cells = sampleLogo(await loadLogo());
    this.emblemCells = this.cells.filter((cell) => cell.column < EMBLEM_COLUMNS);
    this.resize();
    // ResizeObserver can establish the canvas dimensions before the image has
    // decoded. Rebuild once the sampled cells exist even when size is unchanged.
    this.buildAsciiBuffers();
    this.render(0);
    this.canvas.dataset.ready = 'true';
    this.frameRequest = window.requestAnimationFrame(this.animate);
  }

  dispose(): void {
    window.cancelAnimationFrame(this.frameRequest);
    this.resizeObserver.disconnect();
    this.reducedMotion.removeEventListener('change', this.handleMotionChange);
    document.removeEventListener('rift:settings', this.handleMotionChange);
  }

  private readonly handleMotionChange = (): void => {
    this.lastRenderedAt = -Infinity;
    this.render(performance.now());
  };

  private readonly animate = (timestamp: number): void => {
    const hidden = this.canvas.getClientRects().length === 0 || document.visibilityState !== 'visible';
    const reduced = this.reducedMotion.matches || localStorage.getItem('rift:reduced-motion') === 'true';

    if (!hidden && (!reduced || this.lastRenderedAt === -Infinity) && timestamp - this.lastRenderedAt >= FRAME_INTERVAL_MS) {
      this.lastRenderedAt = timestamp;
      this.render(reduced ? 0 : timestamp);
    }

    this.frameRequest = window.requestAnimationFrame(this.animate);
  };

  private resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const deviceScale = Math.min(2, window.devicePixelRatio || 1);
    if (width === this.logicalWidth && height === this.logicalHeight && deviceScale === this.deviceScale) return;

    this.logicalWidth = width;
    this.logicalHeight = height;
    this.deviceScale = deviceScale;

    for (const buffer of [this.canvas, this.frontBuffer, this.depthBuffer, this.energyBuffer]) {
      buffer.width = Math.max(1, Math.round(width * deviceScale));
      buffer.height = Math.max(1, Math.round(height * deviceScale));
    }

    this.context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
    this.buildAsciiBuffers();
    this.lastRenderedAt = -Infinity;
    this.render(0);
  }

  private buildAsciiBuffers(): void {
    if (!this.cells.length || !this.logicalWidth || !this.logicalHeight) return;

    const front = context2d(this.frontBuffer);
    const depth = context2d(this.depthBuffer);
    const energy = context2d(this.energyBuffer);
    const contexts = [front, depth, energy];
    const cellWidth = this.logicalWidth / SOURCE_COLUMNS;
    const cellHeight = this.logicalHeight / SOURCE_ROWS;
    const fontSize = Math.max(5.5, cellHeight * 1.08);

    for (const context of contexts) {
      context.setTransform(this.deviceScale, 0, 0, this.deviceScale, 0, 0);
      context.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
      context.font = `700 ${fontSize}px ${FONT_STACK}`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
    }

    for (const cell of this.cells) {
      const x = (cell.column + 0.5) * cellWidth;
      const y = (cell.row + 0.54) * cellHeight;
      const alpha = clamp(cell.alpha * 1.12);
      const surfaceShade = clamp(cell.luminance * 0.94 + cell.blue * 0.28);

      depth.globalAlpha = alpha * 0.92;
      depth.fillStyle = color([2, 19, 48], [14, 78, 124], surfaceShade);
      depth.fillText(cell.glyph, x, y);

      front.globalAlpha = alpha;
      front.fillStyle = cell.blue > 0.12
        ? color([0, 91, 184], [139, 246, 255], clamp(cell.luminance + cell.blue * 0.42))
        : color([17, 55, 85], [220, 250, 255], surfaceShade);
      front.fillText(cell.glyph, x, y);

      if (cell.blue > 0.12) {
        energy.globalAlpha = clamp(alpha * (0.42 + cell.blue * 0.72));
        energy.fillStyle = color([0, 112, 226], [198, 255, 255], clamp(cell.luminance + cell.blue * 0.5));
        energy.fillText(cell.glyph, x, y);
      }
    }

    for (const context of contexts) context.globalAlpha = 1;
  }

  private render(timestamp: number): void {
    if (!this.cells.length || !this.logicalWidth || !this.logicalHeight) return;

    const context = this.context;
    const seconds = timestamp / 1000;
    const frame = Math.floor(timestamp / FRAME_INTERVAL_MS);
    const lightDrift = Math.sin(seconds * 0.72);
    const scanY = ((seconds * 0.22 + 0.18) % 1) * this.logicalHeight;
    const emblemEnd = this.logicalWidth * (EMBLEM_COLUMNS / SOURCE_COLUMNS);
    const emblemCenterX = emblemEnd * 0.5;
    const emblemCenterY = this.logicalHeight * 0.5;
    const spinAngle = seconds * ((Math.PI * 2) / EMBLEM_REVOLUTION_SECONDS);
    const spinCosine = Math.cos(spinAngle);
    const spinSine = Math.sin(spinAngle);
    const cellWidth = this.logicalWidth / SOURCE_COLUMNS;
    const cellHeight = this.logicalHeight / SOURCE_ROWS;
    const glyphSize = Math.max(5.5, cellHeight * 1.08);
    const halfDepth = Math.max(12, emblemEnd * 0.105);
    const perspective = Math.max(340, this.logicalWidth * 1.08);
    const pitch = -0.105;
    const pitchCosine = Math.cos(pitch);
    const pitchSine = Math.sin(pitch);

    const drawRegion = (
      buffer: HTMLCanvasElement,
      startX: number,
      endX: number,
      offsetX = 0,
      offsetY = 0,
    ): void => {
      const sourceX = Math.round(startX * this.deviceScale);
      const sourceWidth = Math.max(1, Math.round((endX - startX) * this.deviceScale));
      context.drawImage(
        buffer,
        sourceX,
        0,
        sourceWidth,
        buffer.height,
        startX + offsetX,
        offsetY,
        endX - startX,
        this.logicalHeight,
      );
    };
    const drawWordmark = (buffer: HTMLCanvasElement, offsetX = 0, offsetY = 0): void =>
      drawRegion(buffer, emblemEnd, this.logicalWidth, offsetX, offsetY);

    const project = (x: number, y: number, z: number): Readonly<{ depth: number; scale: number; x: number; y: number }> => {
      const rotatedX = x * spinCosine + z * spinSine;
      const rotatedDepth = -x * spinSine + z * spinCosine;
      const rotatedY = y * pitchCosine - rotatedDepth * pitchSine;
      const depth = y * pitchSine + rotatedDepth * pitchCosine;
      const scale = clamp(perspective / (perspective - depth), 0.72, 1.34);
      return {
        depth,
        scale,
        x: emblemCenterX + rotatedX * scale,
        y: emblemCenterY + rotatedY * scale,
      };
    };

    const projectedGlyphs: ProjectedGlyph[] = [];
    const addGlyph = (
      cell: LogoCell,
      x: number,
      y: number,
      z: number,
      alpha: number,
      shade: number,
      glyph = cell.glyph,
    ): void => {
      const point = project(x, y, z);
      const cool = clamp(cell.luminance * 0.72 + cell.blue * 0.42 + shade * 0.35);
      projectedGlyphs.push({
        ...point,
        alpha: clamp(cell.alpha * alpha),
        fill: cell.blue > 0.12
          ? color([0, 48, 112], [166, 251, 255], cool)
          : color([5, 23, 48], [204, 242, 255], cool),
        glow: color([0, 78, 170], [125, 244, 255], clamp(cool + 0.16)),
        glyph,
      });
    };

    const frontVisibility = clamp((spinCosine + 0.14) / 1.14);
    const backVisibility = clamp((-spinCosine + 0.14) / 1.14);
    const wallSlices = 7;

    for (const cell of this.emblemCells) {
      const centerX = (cell.column + 0.5) * cellWidth - emblemCenterX;
      const centerY = (cell.row + 0.54) * cellHeight - emblemCenterY;

      if (frontVisibility > 0.015) {
        addGlyph(cell, centerX, centerY, halfDepth, 0.34 + frontVisibility * 0.72, 0.44 + frontVisibility * 0.56);
      }
      if (backVisibility > 0.015) {
        addGlyph(cell, centerX, centerY, -halfDepth, 0.24 + backVisibility * 0.58, 0.16 + backVisibility * 0.38);
      }

      const edges = [
        { flag: EDGE_LEFT, nx: -1, ny: 0, x: centerX - cellWidth * 0.5, y: centerY },
        { flag: EDGE_RIGHT, nx: 1, ny: 0, x: centerX + cellWidth * 0.5, y: centerY },
        { flag: EDGE_TOP, nx: 0, ny: -1, x: centerX, y: centerY - cellHeight * 0.5 },
        { flag: EDGE_BOTTOM, nx: 0, ny: 1, x: centerX, y: centerY + cellHeight * 0.5 },
      ] as const;

      for (const edge of edges) {
        if ((cell.edgeMask & edge.flag) === 0) continue;
        const normalDepth = edge.ny * pitchSine + (-edge.nx * spinSine) * pitchCosine;
        const visibility = clamp((normalDepth + 0.06) / 0.92);
        if (visibility < 0.035) continue;
        const shade = 0.12 + visibility * 0.62 + Math.max(0, edge.nx * -0.24 + edge.ny * -0.12);
        const sideGlyph = ASCII_RAMP[Math.min(
          ASCII_RAMP.length - 1,
          Math.floor(clamp(shade) * ASCII_RAMP.length),
        )] ?? '+';
        for (let slice = 1; slice < wallSlices; slice += 1) {
          const z = -halfDepth + (slice / wallSlices) * halfDepth * 2;
          addGlyph(cell, edge.x, edge.y, z, 0.18 + visibility * 0.58, shade, sideGlyph);
        }
      }
    }

    projectedGlyphs.sort((a, b) => a.depth - b.depth);

    const drawEmblem = (mode: 'shadow' | 'glow' | 'surface', offsetX = 0, offsetY = 0): void => {
      let lastFontSize = -1;
      for (const item of projectedGlyphs) {
        const fontSize = Math.round(glyphSize * item.scale * 5) / 5;
        if (fontSize !== lastFontSize) {
          context.font = `700 ${fontSize}px ${FONT_STACK}`;
          lastFontSize = fontSize;
        }
        context.globalAlpha = item.alpha * (mode === 'glow' ? 0.52 * GLOW_STRENGTH : mode === 'shadow' ? 0.42 : 1);
        context.fillStyle = mode === 'shadow' ? '#000817' : mode === 'glow' ? item.glow : item.fill;
        context.fillText(item.glyph, item.x + offsetX, item.y + offsetY);
      }
      context.globalAlpha = 1;
    };

    context.setTransform(this.deviceScale, 0, 0, this.deviceScale, 0, 0);
    context.clearRect(0, 0, this.logicalWidth, this.logicalHeight);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.save();
    context.translate(this.logicalWidth / 2, this.logicalHeight / 2);
    context.transform(0.994, -0.008, 0.018, 1, 0, 0);
    context.translate(-this.logicalWidth / 2, -this.logicalHeight / 2);

    context.save();
    context.globalCompositeOperation = 'screen';
    context.globalAlpha = (0.24 + Math.sin(seconds * 2.3) * 0.035) * GLOW_STRENGTH;
    context.filter = 'blur(7px) brightness(1.65)';
    drawWordmark(this.energyBuffer);
    drawEmblem('glow');
    context.restore();

    for (let layer = 14; layer >= 1; layer -= 1) {
      context.globalAlpha = 0.105 + (14 - layer) * 0.012;
      drawWordmark(this.depthBuffer, layer * 1.02, layer * 0.66);
    }

    drawEmblem('shadow', 7, 10);
    context.globalAlpha = 1;
    drawWordmark(this.frontBuffer);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    drawEmblem('surface');
    context.globalAlpha = 1;

    context.save();
    context.beginPath();
    context.moveTo(0, scanY - this.logicalHeight * 0.08);
    context.lineTo(this.logicalWidth, scanY - this.logicalHeight * 0.17);
    context.lineTo(this.logicalWidth, scanY + this.logicalHeight * 0.01);
    context.lineTo(0, scanY + this.logicalHeight * 0.1);
    context.closePath();
    context.clip();
    context.globalCompositeOperation = 'screen';
    context.globalAlpha = 0.5;
    context.filter = 'brightness(2) saturate(1.45)';
    drawWordmark(this.frontBuffer, lightDrift * 1.1);
    context.restore();

    context.save();
    context.globalCompositeOperation = 'screen';
    const energyAlpha = (0.34 + Math.sin(seconds * 3.1) * 0.08) * GLOW_STRENGTH;
    context.globalAlpha = energyAlpha;
    context.filter = 'brightness(1.35)';
    drawWordmark(this.energyBuffer, lightDrift * 0.45);
    context.restore();

    if (frame % 151 < 2 && timestamp > 0) {
      const sliceHeight = Math.max(2, this.logicalHeight * 0.025);
      const sourceX = emblemEnd * this.deviceScale;
      for (let slice = 0; slice < 3; slice += 1) {
        const y = this.logicalHeight * (0.26 + slice * 0.2);
        const sourceY = y * this.deviceScale;
        context.globalAlpha = 0.48;
        context.drawImage(
          this.frontBuffer,
          sourceX,
          sourceY,
          this.frontBuffer.width - sourceX,
          sliceHeight * this.deviceScale,
          emblemEnd + (slice - 1) * 3.5,
          y,
          this.logicalWidth - emblemEnd,
          sliceHeight,
        );
      }
    }

    context.save();
    context.globalCompositeOperation = 'source-atop';
    context.globalAlpha = 0.075;
    context.fillStyle = '#4bdfff';
    for (let y = 1; y < this.logicalHeight; y += 5) context.fillRect(0, y, this.logicalWidth, 1);
    context.restore();
    context.restore();
    context.globalAlpha = 1;
    context.filter = 'none';

    this.canvas.style.transform = 'perspective(760px) rotateX(-2.8deg) rotateY(-5.6deg)';
    this.canvas.dataset.frame = String(frame);
    this.canvas.dataset.emblemSpin = spinAngle.toFixed(3);
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#rift-ascii-logo');
let logo: RiftAsciiLogo | undefined;

if (canvas) {
  logo = new RiftAsciiLogo(canvas);
  void logo.start().catch((error: unknown) => {
    canvas.dataset.error = error instanceof Error ? error.message : 'Unable to render the Rift ASCII logo.';
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => logo?.dispose());
}
