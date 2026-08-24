import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type MapGroup = {
  vertexCount: number;
  positionOffset: number;
  normalOffset: number;
};

type MapManifest = {
  groups: MapGroup[];
};

test('WCA1 render faces use Three.js winding and retain floors and ceilings', async () => {
  const manifest = JSON.parse(
    await readFile(resolve('public/assets/maps/wca1-remix.json'), 'utf8'),
  ) as MapManifest;
  const binary = await readFile(resolve('public/assets/maps/wca1-remix.bin'));
  let alignedNormalDot = 0;
  let validTriangles = 0;
  let upwardFaces = 0;
  let downwardFaces = 0;

  for (const group of manifest.groups) {
    const positions = new Float32Array(
      binary.buffer,
      binary.byteOffset + group.positionOffset,
      group.vertexCount * 3,
    );
    const normals = new Float32Array(
      binary.buffer,
      binary.byteOffset + group.normalOffset,
      group.vertexCount * 3,
    );

    for (let vertex = 0; vertex < group.vertexCount; vertex += 3) {
      const a = vertex * 3;
      const b = (vertex + 1) * 3;
      const c = (vertex + 2) * 3;
      const abx = positions[b] - positions[a];
      const aby = positions[b + 1] - positions[a + 1];
      const abz = positions[b + 2] - positions[a + 2];
      const acx = positions[c] - positions[a];
      const acy = positions[c + 1] - positions[a + 1];
      const acz = positions[c + 2] - positions[a + 2];
      let faceX = aby * acz - abz * acy;
      let faceY = abz * acx - abx * acz;
      let faceZ = abx * acy - aby * acx;
      const faceLength = Math.hypot(faceX, faceY, faceZ);
      if (faceLength < 1e-6) continue;
      faceX /= faceLength;
      faceY /= faceLength;
      faceZ /= faceLength;

      const normalX = normals[a] + normals[b] + normals[c];
      const normalY = normals[a + 1] + normals[b + 1] + normals[c + 1];
      const normalZ = normals[a + 2] + normals[b + 2] + normals[c + 2];
      const normalLength = Math.hypot(normalX, normalY, normalZ) || 1;
      alignedNormalDot += (faceX * normalX + faceY * normalY + faceZ * normalZ) / normalLength;
      validTriangles += 1;
      if (faceY > 0.75) upwardFaces += 1;
      if (faceY < -0.75) downwardFaces += 1;
    }
  }

  expect(manifest.groups).toHaveLength(55);
  expect(validTriangles).toBeGreaterThan(50_000);
  expect(alignedNormalDot / validTriangles, 'render winding must agree with authored BSP normals').toBeGreaterThan(0.98);
  expect(upwardFaces, 'map must retain player-facing floor surfaces').toBeGreaterThan(5_000);
  expect(downwardFaces, 'map must retain player-facing ceiling surfaces').toBeGreaterThan(8_000);
});
