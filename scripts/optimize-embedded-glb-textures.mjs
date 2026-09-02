import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const [, , inputPath, outputPath, maxSizeText = '512'] = process.argv;
if (!inputPath || !outputPath) {
  throw new Error('Usage: node scripts/optimize-embedded-glb-textures.mjs input.glb output.glb [max-size]');
}
const maxSize = Number.parseInt(maxSizeText, 10);
if (!Number.isFinite(maxSize) || maxSize < 64) throw new Error(`Invalid max size: ${maxSizeText}`);

const source = readFileSync(inputPath);
if (source.readUInt32LE(0) !== 0x46546c67 || source.readUInt32LE(4) !== 2) {
  throw new Error(`${inputPath} is not a GLB 2.0 file.`);
}

let json;
let binary;
for (let offset = 12; offset < source.length;) {
  const length = source.readUInt32LE(offset);
  const type = source.readUInt32LE(offset + 4);
  const data = source.subarray(offset + 8, offset + 8 + length);
  if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
  if (type === 0x004e4942) binary = data;
  offset += 8 + length;
}
if (!json || !binary) throw new Error('GLB is missing a JSON or BIN chunk.');
if ((json.buffers?.length ?? 0) !== 1) throw new Error('Only single-buffer GLBs are supported.');

const imageByView = new Map(json.images.map((image, index) => [image.bufferView, { image, index }]));
const tempDirectory = mkdtempSync(join(tmpdir(), 'riftline-glb-textures-'));
const viewPayloads = [];
let sourceImageBytes = 0;
let optimizedImageBytes = 0;

try {
  for (let index = 0; index < json.bufferViews.length; index += 1) {
    const view = json.bufferViews[index];
    const sourcePayload = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const imageEntry = imageByView.get(index);
    if (!imageEntry) {
      viewPayloads.push(Buffer.from(sourcePayload));
      continue;
    }

    const extension = imageEntry.image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const inputImage = join(tempDirectory, `image-${imageEntry.index}.${extension}`);
    const outputImage = join(tempDirectory, `image-${imageEntry.index}-optimized.${extension}`);
    writeFileSync(inputImage, sourcePayload);
    const conversion = spawnSync('magick', [
      inputImage,
      '-filter', 'Lanczos',
      '-resize', `${maxSize}x${maxSize}>`,
      '-strip',
      '-define', 'png:compression-level=9',
      outputImage,
    ], { encoding: 'utf8' });
    if (conversion.status !== 0) {
      throw new Error(`ImageMagick failed for image ${imageEntry.index}: ${conversion.stderr}`);
    }
    const optimized = readFileSync(outputImage);
    sourceImageBytes += sourcePayload.length;
    optimizedImageBytes += optimized.length;
    viewPayloads.push(optimized);
  }

  let binaryLength = 0;
  for (const payload of viewPayloads) binaryLength = (binaryLength + payload.length + 3) & ~3;
  const rebuiltBinary = Buffer.alloc(binaryLength);
  let binaryOffset = 0;
  for (let index = 0; index < viewPayloads.length; index += 1) {
    const payload = viewPayloads[index];
    payload.copy(rebuiltBinary, binaryOffset);
    json.bufferViews[index].byteOffset = binaryOffset;
    json.bufferViews[index].byteLength = payload.length;
    binaryOffset = (binaryOffset + payload.length + 3) & ~3;
  }
  json.buffers[0].byteLength = rebuiltBinary.length;

  const jsonRaw = Buffer.from(JSON.stringify(json));
  const jsonLength = (jsonRaw.length + 3) & ~3;
  const jsonChunk = Buffer.alloc(jsonLength, 0x20);
  jsonRaw.copy(jsonChunk);
  const totalLength = 12 + 8 + jsonChunk.length + 8 + rebuiltBinary.length;
  const output = Buffer.alloc(totalLength);
  output.writeUInt32LE(0x46546c67, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(totalLength, 8);
  output.writeUInt32LE(jsonChunk.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(output, 20);
  const binaryHeader = 20 + jsonChunk.length;
  output.writeUInt32LE(rebuiltBinary.length, binaryHeader);
  output.writeUInt32LE(0x004e4942, binaryHeader + 4);
  rebuiltBinary.copy(output, binaryHeader + 8);
  writeFileSync(outputPath, output);

  console.log(JSON.stringify({
    input: basename(inputPath),
    output: basename(outputPath),
    images: imageByView.size,
    maxSize,
    sourceImageBytes,
    optimizedImageBytes,
    sourceBytes: source.length,
    optimizedBytes: output.length,
  }));
} finally {
  rmSync(tempDirectory, { force: true, recursive: true });
}
