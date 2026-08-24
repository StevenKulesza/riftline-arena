#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const assetRoot = path.resolve(process.argv[2] ?? process.env.WARSOW_ASSET_ROOT ?? '/tmp/riftline-warsow-assets');
const mapManifestPath = path.resolve(process.argv[3] ?? 'public/assets/maps/wca1-remix.json');
const outputDirectory = path.resolve(process.argv[4] ?? 'public/assets/maps/wca1-materials');
const outputManifestPath = path.resolve(path.dirname(mapManifestPath), 'wca1-materials.json');

if (!fs.existsSync(assetRoot)) throw new Error(`Missing Warsow asset checkout: ${assetRoot}`);
if (!fs.existsSync(mapManifestPath)) throw new Error(`Missing converted map manifest: ${mapManifestPath}`);

const walk = (directory, files = []) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else files.push(absolute);
  }
  return files;
};

const allFiles = walk(assetRoot);
const fileIndex = new Map(allFiles.map((absolute) => [
  path.relative(assetRoot, absolute).replaceAll(path.sep, '/').toLowerCase(),
  absolute,
]));

const resolveAsset = (reference) => {
  if (!reference || reference.startsWith('$') || reference === '-') return null;
  const normalized = reference.replaceAll('\\', '/').replace(/^\/+/, '').replace(/["']/g, '');
  const extension = path.posix.extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  const candidates = extension
    ? [normalized, ...['.tga', '.png', '.jpg', '.jpeg', '.ktx'].map((suffix) => `${stem}${suffix}`)]
    : [normalized, ...['.tga', '.png', '.jpg', '.jpeg', '.ktx'].map((suffix) => `${normalized}${suffix}`)];
  for (const candidate of candidates) {
    const match = fileIndex.get(candidate.toLowerCase());
    if (match) return match;
  }
  return null;
};

const shaderDefinitions = new Map();
for (const shaderFile of allFiles.filter((file) => file.endsWith('.shader'))) {
  const lines = fs.readFileSync(shaderFile, 'utf8').split(/\r?\n/);
  let pendingName = null;
  let currentName = null;
  let depth = 0;
  let body = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (depth === 0) {
      if (line === '{' && pendingName) {
        currentName = pendingName;
        pendingName = null;
        depth = 1;
        body = [];
      } else if (line.endsWith('{')) {
        currentName = line.slice(0, -1).trim() || pendingName;
        pendingName = null;
        depth = 1;
        body = [];
      } else {
        pendingName = line;
      }
      continue;
    }

    body.push(line);
    depth += [...line].filter((character) => character === '{').length;
    depth -= [...line].filter((character) => character === '}').length;
    if (depth !== 0 || !currentName) continue;

    const materialLines = body
      .map((entry) => entry.match(/^material\s+(.+)$/i)?.[1]?.split(/\s+/).filter(Boolean))
      .filter(Boolean);
    const editorImages = body
      .map((entry) => entry.match(/^qer_editorimage\s+([^\s]+)/i)?.[1])
      .filter(Boolean);
    const maps = body
      .map((entry) => entry.match(/^(?:map|clampmap)\s+([^\s]+)/i)?.[1])
      .filter(Boolean);
    const celshade = body
      .map((entry) => entry.match(/^celshade\s+([^\s]+)/i)?.[1])
      .filter(Boolean);
    const primaryMaterial = materialLines[0] ?? [];
    shaderDefinitions.set(currentName.toLowerCase(), {
      albedo: [primaryMaterial[0], ...editorImages, ...maps, ...celshade],
      normal: [primaryMaterial[1]],
      gloss: [primaryMaterial[2]],
    });
    currentName = null;
    body = [];
  }
}

const convertTexture = (source, destination, invert = false) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (path.extname(source).toLowerCase() === '.ktx') {
    if (invert) return null;
    const ktxDestination = destination.replace(/\.webp$/, '.ktx');
    fs.copyFileSync(source, ktxDestination);
    return ktxDestination;
  }
  const argumentsList = [source];
  if (invert) argumentsList.push('-negate');
  argumentsList.push('-quality', '92', destination);
  const result = spawnSync('magick', argumentsList, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ImageMagick failed for ${source}: ${result.stderr || result.stdout}`);
  }
  return destination;
};

// Several WCA1 shader variants deliberately reuse the same source image with
// different shader parameters (for example 200/1000-strength light fixtures).
// Share one runtime texture for those variants instead of uploading identical
// GPU copies under shader-specific filenames.
const convertedTextureCache = new Map();
const convertSharedTexture = (source, destination, invert = false) => {
  if (!source) return null;
  const key = `${path.resolve(source)}\0${invert ? 'roughness' : 'color'}`;
  const cached = convertedTextureCache.get(key);
  if (cached) return cached;
  const output = convertTexture(source, destination, invert);
  if (output) convertedTextureCache.set(key, output);
  return output;
};

const mapManifest = JSON.parse(fs.readFileSync(mapManifestPath, 'utf8'));
const materialManifest = {
  source: 'Warsow official warsow-assets repository',
  sourceUrl: 'https://github.com/Warsow/warsow-assets',
  license: 'CC-BY-SA-4.0 / CC-BY-ND-4.0; see upstream README and exceptions ledger',
  generatedBy: path.relative(projectRoot, import.meta.filename),
  materials: {},
};
fs.mkdirSync(outputDirectory, { recursive: true });

const toPublicUrl = (absolute) => `/${path.relative(path.join(projectRoot, 'public'), absolute).replaceAll(path.sep, '/')}`;
const uniqueShaders = [...new Set(mapManifest.groups.map((group) => group.shader).filter(Boolean))];
let converted = 0;
let unresolved = 0;
for (const shader of uniqueShaders) {
  const definition = shaderDefinitions.get(shader.toLowerCase()) ?? { albedo: [], normal: [], gloss: [] };
  const albedoSource = [...definition.albedo, shader].map(resolveAsset).find(Boolean) ?? null;
  const normalSource = definition.normal.map(resolveAsset).find(Boolean) ?? null;
  const glossSource = definition.gloss.map(resolveAsset).find(Boolean) ?? null;
  if (!albedoSource) {
    unresolved += 1;
    materialManifest.materials[shader] = { source: null, map: null, normalMap: null, roughnessMap: null };
    continue;
  }

  const slug = shader.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const albedoOutput = convertSharedTexture(albedoSource, path.join(outputDirectory, `${slug}-albedo.webp`));
  const normalOutput = normalSource
    ? convertSharedTexture(normalSource, path.join(outputDirectory, `${slug}-normal.webp`))
    : null;
  const roughnessOutput = glossSource
    ? convertSharedTexture(glossSource, path.join(outputDirectory, `${slug}-roughness.webp`), true)
    : null;
  materialManifest.materials[shader] = {
    source: path.relative(assetRoot, albedoSource).replaceAll(path.sep, '/'),
    map: toPublicUrl(albedoOutput),
    normalMap: normalOutput ? toPublicUrl(normalOutput) : null,
    roughnessMap: roughnessOutput ? toPublicUrl(roughnessOutput) : null,
  };
  converted += 1;
}

fs.writeFileSync(outputManifestPath, `${JSON.stringify(materialManifest, null, 2)}\n`);
console.log(`Imported ${converted}/${uniqueShaders.length} WCA1 shader materials (${unresolved} unresolved).`);
console.log(`Material manifest: ${path.relative(projectRoot, outputManifestPath)}`);
