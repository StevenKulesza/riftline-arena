#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const sourcePath = process.argv[2] ?? '/tmp/riftline-wca1.bsp';
const outputDirectory = process.argv[3] ?? 'public/assets/maps';
const SCALE = 1 / 56;
const ORIGIN = [-528, 80, 64];
const PATCH_SUBDIVISIONS = 5;
const VERTEX_BYTES = 80;
const FACE_BYTES = 148;
const SHADER_BYTES = 72;
const PLANE_BYTES = 16;
const BRUSH_BYTES = 12;
const BRUSH_SIDE_BYTES = 12;
const MODEL_BYTES = 40;
const CONTENTS_SOLID = 0x1;
const CONTENTS_PLAYERCLIP = 0x10000;
const SURF_NONSOLID = 0x4000;

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Missing source BSP: ${sourcePath}`);
}

const file = fs.readFileSync(sourcePath);
if (file.toString('ascii', 0, 4) !== 'FBSP' || file.readInt32LE(4) !== 1) {
  throw new Error('Expected a Qfusion FBSP v1 map.');
}

const lump = (index) => ({
  offset: file.readInt32LE(8 + index * 8),
  length: file.readInt32LE(12 + index * 8),
});

const shaderLump = lump(1);
const planeLump = lump(2);
const modelLump = lump(7);
const brushLump = lump(8);
const brushSideLump = lump(9);
const vertexLump = lump(10);
const elementLump = lump(11);
const faceLump = lump(13);

const shaders = Array.from({ length: shaderLump.length / SHADER_BYTES }, (_, index) => {
  const offset = shaderLump.offset + index * SHADER_BYTES;
  return {
    name: file.toString('ascii', offset, offset + 64).replace(/\0.*$/, ''),
    flags: file.readUInt32LE(offset + 64),
    contents: file.readUInt32LE(offset + 68),
  };
});

const classifyShader = (name) => {
  const value = name.toLowerCase();
  if (/common\/(caulk|nodraw|trigger|fullclip|playerclip)|textures\/null|sky/.test(value)) return null;
  if (/glass/.test(value)) return 'glass';
  if (/red/.test(value)) return 'red';
  if (/blue|01blue/.test(value)) return 'blue';
  if (/light|glow|halo|bright/.test(value)) return 'light';
  if (/billboard|terebi|screen/.test(value)) return 'screen';
  if (/floor|tile|rplate|stepup|stepside/.test(value)) return 'floor';
  if (/trim|support|baseboard|pillar|border/.test(value)) return 'trim';
  if (/metal|tube|cable|factory/.test(value)) return 'metal';
  if (/wall|plastic|pvc|pantone/.test(value)) return 'wall';
  return 'concrete';
};

const transformPoint = ([x, y, z]) => [
  (x - ORIGIN[0]) * SCALE,
  (z - ORIGIN[2]) * SCALE,
  -(y - ORIGIN[1]) * SCALE,
];

const transformNormal = ([x, y, z]) => [x, z, -y];

const readVertex = (index) => {
  const offset = vertexLump.offset + index * VERTEX_BYTES;
  return {
    point: transformPoint([
      file.readFloatLE(offset),
      file.readFloatLE(offset + 4),
      file.readFloatLE(offset + 8),
    ]),
    uv: [file.readFloatLE(offset + 12), file.readFloatLE(offset + 16)],
    normal: transformNormal([
      file.readFloatLE(offset + 52),
      file.readFloatLE(offset + 56),
      file.readFloatLE(offset + 60),
    ]),
    color: [file[offset + 64], file[offset + 65], file[offset + 66]],
  };
};

const groups = new Map();
const collisionPositions = [];
const groupFor = (category, shader) => {
  const key = `${category}\0${shader}`;
  if (!groups.has(key)) {
    groups.set(key, { category, shader, positions: [], normals: [], uvs: [], colors: [] });
  }
  return groups.get(key);
};

const pushVertex = (group, vertex) => {
  group.positions.push(...vertex.point);
  group.normals.push(...vertex.normal);
  group.uvs.push(...vertex.uv);
  group.colors.push(...vertex.color);
};

const pushTriangle = (group, a, b, c) => {
  pushVertex(group, a);
  pushVertex(group, c);
  pushVertex(group, b);
};

const pushCollisionTriangle = (a, b, c) => {
  collisionPositions.push(...a.point, ...b.point, ...c.point);
};

const interpolate = (a, b, c, t) => {
  const it = 1 - t;
  return it * it * a + 2 * it * t * b + t * t * c;
};

const evaluatePatch = (control, u, v) => {
  const result = { point: [0, 0, 0], normal: [0, 0, 0], uv: [0, 0], color: [0, 0, 0] };
  for (const key of ['point', 'normal', 'uv', 'color']) {
    for (let axis = 0; axis < result[key].length; axis += 1) {
      const rows = [0, 1, 2].map((row) => interpolate(
        control[row * 3][key][axis],
        control[row * 3 + 1][key][axis],
        control[row * 3 + 2][key][axis],
        u,
      ));
      result[key][axis] = interpolate(rows[0], rows[1], rows[2], v);
    }
  }
  const normalLength = Math.hypot(...result.normal) || 1;
  result.normal = result.normal.map((value) => value / normalLength);
  result.color = result.color.map((value) => Math.max(0, Math.min(255, Math.round(value))));
  return result;
};

for (let faceIndex = 0; faceIndex < faceLump.length / FACE_BYTES; faceIndex += 1) {
  const offset = faceLump.offset + faceIndex * FACE_BYTES;
  const shaderIndex = file.readInt32LE(offset);
  const shader = shaders[shaderIndex] ?? { name: '', flags: 0, contents: 0 };
  const category = classifyShader(shader.name);

  const faceType = file.readInt32LE(offset + 8);
  const firstVertex = file.readInt32LE(offset + 12);
  const vertexCount = file.readInt32LE(offset + 16);
  const firstElement = file.readUInt32LE(offset + 20);
  const elementCount = file.readInt32LE(offset + 24);
  const group = category ? groupFor(category, shader.name) : null;

  if (faceType === 1 || faceType === 3) {
    if (!group) continue;
    for (let elementIndex = 0; elementIndex + 2 < elementCount; elementIndex += 3) {
      const a = file.readInt32LE(elementLump.offset + (firstElement + elementIndex) * 4);
      const b = file.readInt32LE(elementLump.offset + (firstElement + elementIndex + 1) * 4);
      const c = file.readInt32LE(elementLump.offset + (firstElement + elementIndex + 2) * 4);
      if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
      pushTriangle(group, readVertex(firstVertex + a), readVertex(firstVertex + b), readVertex(firstVertex + c));
    }
    continue;
  }

  if (faceType !== 2) continue;
  const collidablePatch = (shader.contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP)) !== 0
    && (shader.flags & SURF_NONSOLID) === 0;
  if (!group && !collidablePatch) continue;
  const width = file.readInt32LE(offset + 140);
  const height = file.readInt32LE(offset + 144);
  if (width < 3 || height < 3 || width * height > vertexCount) continue;

  for (let patchY = 0; patchY + 2 < height; patchY += 2) {
    for (let patchX = 0; patchX + 2 < width; patchX += 2) {
      const control = [];
      for (let y = 0; y < 3; y += 1) {
        for (let x = 0; x < 3; x += 1) {
          control.push(readVertex(firstVertex + (patchY + y) * width + patchX + x));
        }
      }
      const grid = [];
      for (let y = 0; y <= PATCH_SUBDIVISIONS; y += 1) {
        for (let x = 0; x <= PATCH_SUBDIVISIONS; x += 1) {
          grid.push(evaluatePatch(control, x / PATCH_SUBDIVISIONS, y / PATCH_SUBDIVISIONS));
        }
      }
      const row = PATCH_SUBDIVISIONS + 1;
      for (let y = 0; y < PATCH_SUBDIVISIONS; y += 1) {
        for (let x = 0; x < PATCH_SUBDIVISIONS; x += 1) {
          const a = grid[y * row + x];
          const b = grid[y * row + x + 1];
          const c = grid[(y + 1) * row + x];
          const d = grid[(y + 1) * row + x + 1];
          if (group) {
            pushTriangle(group, a, c, b);
            pushTriangle(group, b, c, d);
          }
          if (collidablePatch) {
            pushCollisionTriangle(a, c, b);
            pushCollisionTriangle(b, c, d);
          }
        }
      }
    }
  }
}

const readPlane = (index) => {
  const offset = planeLump.offset + index * PLANE_BYTES;
  return {
    normal: [file.readFloatLE(offset), file.readFloatLE(offset + 4), file.readFloatLE(offset + 8)],
    distance: file.readFloatLE(offset + 12),
  };
};

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const multiply = (a, scalar) => [a[0] * scalar, a[1] * scalar, a[2] * scalar];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (value) => {
  const length = Math.hypot(...value) || 1;
  return multiply(value, 1 / length);
};

const clipPolygon = (polygon, plane) => {
  if (polygon.length === 0) return polygon;
  const clipped = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const currentDistance = dot(plane.normal, current) - plane.distance;
    const nextDistance = dot(plane.normal, next) - plane.distance;
    const currentInside = currentDistance <= 0.02;
    const nextInside = nextDistance <= 0.02;
    if (currentInside) clipped.push(current);
    if (currentInside === nextInside) continue;
    const denominator = currentDistance - nextDistance;
    if (Math.abs(denominator) < 1e-8) continue;
    const amount = currentDistance / denominator;
    clipped.push(add(current, multiply(subtract(next, current), amount)));
  }
  return clipped;
};

const brushFacePolygon = (sidePlane, brushPlanes) => {
  const helper = Math.abs(sidePlane.normal[2]) < 0.8 ? [0, 0, 1] : [0, 1, 0];
  const tangent = normalize(cross(helper, sidePlane.normal));
  const bitangent = normalize(cross(sidePlane.normal, tangent));
  const center = multiply(sidePlane.normal, sidePlane.distance);
  const extent = 16384;
  let polygon = [
    add(add(center, multiply(tangent, extent)), multiply(bitangent, extent)),
    add(add(center, multiply(tangent, -extent)), multiply(bitangent, extent)),
    add(add(center, multiply(tangent, -extent)), multiply(bitangent, -extent)),
    add(add(center, multiply(tangent, extent)), multiply(bitangent, -extent)),
  ];
  for (const plane of brushPlanes) {
    if (plane === sidePlane) continue;
    polygon = clipPolygon(polygon, plane);
    if (polygon.length < 3) return [];
  }
  return polygon.filter((point, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    return Math.hypot(point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]) > 0.02;
  });
};

// The first BSP model is the static world. Remaining models are the six push
// trigger volumes, which must remain sensors rather than solid collision.
const worldModelOffset = modelLump.offset;
const worldFirstBrush = file.readInt32LE(worldModelOffset + 32);
const worldBrushCount = file.readInt32LE(worldModelOffset + 36);
const patchCollisionVertexCount = collisionPositions.length / 3;
const collisionBrushRecords = [];
const collisionBrushPlanes = [];
let collisionBrushes = 0;
for (let brushIndex = worldFirstBrush; brushIndex < worldFirstBrush + worldBrushCount; brushIndex += 1) {
  const brushOffset = brushLump.offset + brushIndex * BRUSH_BYTES;
  const firstSide = file.readInt32LE(brushOffset);
  const sideCount = file.readInt32LE(brushOffset + 4);
  const shaderIndex = file.readInt32LE(brushOffset + 8);
  const shader = shaders[shaderIndex];
  if (!shader || (shader.contents & (CONTENTS_SOLID | CONTENTS_PLAYERCLIP)) === 0) continue;
  if (/common\/trigger/.test(shader.name.toLowerCase())) continue;

  const brushPlanes = [];
  for (let sideIndex = 0; sideIndex < sideCount; sideIndex += 1) {
    const sideOffset = brushSideLump.offset + (firstSide + sideIndex) * BRUSH_SIDE_BYTES;
    const planeIndex = file.readInt32LE(sideOffset);
    if (planeIndex < 0 || planeIndex >= planeLump.length / PLANE_BYTES) continue;
    brushPlanes.push(readPlane(planeIndex));
  }
  if (brushPlanes.length < 4) continue;

  let wroteBrush = false;
  const brushVertices = [];
  for (const sidePlane of brushPlanes) {
    const polygon = brushFacePolygon(sidePlane, brushPlanes);
    if (polygon.length < 3) continue;
    const transformed = polygon.map((point) => ({ point: transformPoint(point) }));
    brushVertices.push(...transformed.map((vertex) => vertex.point));
    for (let index = 1; index + 1 < transformed.length; index += 1) {
      const a = transformed[0].point;
      const b = transformed[index].point;
      const c = transformed[index + 1].point;
      const ab = subtract(b, a);
      const ac = subtract(c, a);
      if (Math.hypot(...cross(ab, ac)) < 1e-7) continue;
      pushCollisionTriangle(transformed[0], transformed[index], transformed[index + 1]);
      wroteBrush = true;
    }
  }
  if (wroteBrush) {
    const planeStart = collisionBrushPlanes.length / 4;
    for (const plane of brushPlanes) {
      const transformedNormal = transformNormal(plane.normal);
      const transformedDistance = (plane.distance - dot(plane.normal, ORIGIN)) * SCALE;
      collisionBrushPlanes.push(...transformedNormal, transformedDistance);
    }
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    for (const point of brushVertices) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], point[axis]);
        maximum[axis] = Math.max(maximum[axis], point[axis]);
      }
    }
    collisionBrushRecords.push(planeStart, brushPlanes.length, ...minimum, ...maximum);
    collisionBrushes += 1;
  }
}

fs.mkdirSync(outputDirectory, { recursive: true });
const chunks = [];
const manifestGroups = [];
let byteOffset = 0;
for (const group of groups.values()) {
  const positions = Buffer.from(new Float32Array(group.positions).buffer);
  const normals = Buffer.from(new Float32Array(group.normals).buffer);
  const uvs = Buffer.from(new Float32Array(group.uvs).buffer);
  const colors = Buffer.from(new Uint8Array(group.colors).buffer);
  const positionOffset = byteOffset;
  chunks.push(positions);
  byteOffset += positions.byteLength;
  const normalOffset = byteOffset;
  chunks.push(normals);
  byteOffset += normals.byteLength;
  const uvOffset = byteOffset;
  chunks.push(uvs);
  byteOffset += uvs.byteLength;
  const colorOffset = byteOffset;
  chunks.push(colors);
  byteOffset += colors.byteLength;
  while (byteOffset % 4 !== 0) {
    chunks.push(Buffer.alloc(1));
    byteOffset += 1;
  }
  manifestGroups.push({
    name: group.category,
    shader: group.shader,
    vertexCount: group.positions.length / 3,
    positionOffset,
    normalOffset,
    uvOffset,
    colorOffset,
  });
}

const collisionPositionOffset = byteOffset;
const collisionBuffer = Buffer.from(new Float32Array(collisionPositions).buffer);
chunks.push(collisionBuffer);
byteOffset += collisionBuffer.byteLength;
const brushRecordOffset = byteOffset;
const brushRecordBuffer = Buffer.from(new Float32Array(collisionBrushRecords).buffer);
chunks.push(brushRecordBuffer);
byteOffset += brushRecordBuffer.byteLength;
const brushPlaneOffset = byteOffset;
const brushPlaneBuffer = Buffer.from(new Float32Array(collisionBrushPlanes).buffer);
chunks.push(brushPlaneBuffer);
byteOffset += brushPlaneBuffer.byteLength;

const binaryName = 'wca1-remix.bin';
const manifestName = 'wca1-remix.json';
fs.writeFileSync(path.join(outputDirectory, binaryName), Buffer.concat(chunks));
fs.writeFileSync(path.join(outputDirectory, manifestName), `${JSON.stringify({
  source: 'Warsow wca1 / Funpark',
  sourceUrl: 'https://github.com/Warsow/warsow-assets/blob/master/maps/wca1.bsp',
  license: 'CC-BY-SA-4.0',
  scale: SCALE,
  origin: ORIGIN,
  collision: {
    source: 'Qfusion BSP world brushes plus collidable Bezier patches',
    brushCount: collisionBrushes,
    vertexCount: collisionPositions.length / 3,
    patchVertexCount: patchCollisionVertexCount,
    positionOffset: collisionPositionOffset,
    brushRecordOffset,
    brushRecordStride: 8,
    brushPlaneOffset,
    brushPlaneCount: collisionBrushPlanes.length / 4,
  },
  groups: manifestGroups,
}, null, 2)}\n`);

const triangles = manifestGroups.reduce((sum, group) => sum + group.vertexCount / 3, 0);
console.log(`Converted ${manifestGroups.length} material groups (${triangles.toLocaleString()} render triangles) and ${collisionBrushes.toLocaleString()} world brushes (${(collisionPositions.length / 9).toLocaleString()} collision triangles), ${byteOffset.toLocaleString()} bytes.`);
