import { expect, test } from '@playwright/test';
import * as THREE from 'three';
import {
  buildBankedTurn,
  buildLaunchRamp,
  sampleBankedTurnHeight,
  sampleBankedTurnNormal,
  sampleLaunchRampHeight,
  sampleLaunchRampProfile,
  sampleLaunchRampNormal,
  type BankedTurnSpec,
  type LaunchRampSpec,
} from '../src/game/maps/FlowGeometry';

test('flow ramp render normals stay congruent with the analytic riding surface', () => {
  const spec: LaunchRampSpec = {
    origin: { x: 4, y: 2, z: -8 },
    heading: 0,
    length: 32,
    width: 12,
    rise: 15,
    curveExponent: 1.8,
    profile: 'smootherstep',
    longitudinalSegments: 16,
    lateralSegments: 4,
    solid: true,
    skirtDepth: 0.5,
    followSurfaceUnderside: true,
    edgeChamfer: 0.4,
    troughDepth: 0.6,
  };
  const flow = buildLaunchRamp(spec);
  const positions = flow.geometry.getAttribute('position');
  const normals = flow.geometry.getAttribute('normal');
  const uvs = flow.geometry.getAttribute('uv');
  const topVertexCount = spec.longitudinalSegments! * spec.lateralSegments! * 6;
  const expectedNormal = new THREE.Vector3();
  const renderedNormal = new THREE.Vector3();

  for (let index = 0; index < topVertexCount; index += 1) {
    const sampled = sampleLaunchRampNormal(
      spec,
      positions.getX(index),
      positions.getZ(index),
      expectedNormal,
    );
    expect(sampled).not.toBeNull();
    renderedNormal.fromBufferAttribute(normals, index);
    expect(renderedNormal.dot(expectedNormal)).toBeGreaterThan(0.999_999);
    if (uvs.getX(index) < 1e-7 || uvs.getX(index) > 1 - 1e-7) {
      expect(renderedNormal.y).toBeCloseTo(1, 6);
    }
  }

  const longitudinal = spec.longitudinalSegments!;
  const lateral = spec.lateralSegments!;
  expect(flow.triangleCount).toBe(4 * longitudinal * lateral + 4 * (longitudinal + lateral));

  const undersideStart = topVertexCount;
  const undersideEnd = undersideStart + topVertexCount;
  let undersideHalfWidth = 0;
  for (let index = undersideStart; index < undersideEnd; index += 1) {
    undersideHalfWidth = Math.max(undersideHalfWidth, Math.abs(positions.getX(index) - spec.origin.x));
  }
  expect(undersideHalfWidth).toBeLessThan(spec.width * 0.5 - 0.2);
  expect(undersideHalfWidth).toBeGreaterThan(spec.width * 0.5 - spec.edgeChamfer! - 0.1);

  const centerHeight = sampleLaunchRampHeight(spec, spec.origin.x, spec.origin.z + spec.length * 0.5)!;
  const edgeHeight = sampleLaunchRampHeight(
    spec,
    spec.origin.x + spec.width * 0.5,
    spec.origin.z + spec.length * 0.5,
  )!;
  expect(edgeHeight - centerHeight).toBeCloseTo(spec.troughDepth!, 6);
  const entryEdgeHeight = sampleLaunchRampHeight(spec, spec.origin.x + spec.width * 0.5, spec.origin.z)!;
  const exitEdgeHeight = sampleLaunchRampHeight(
    spec,
    spec.origin.x + spec.width * 0.5,
    spec.origin.z + spec.length,
  )!;
  expect(entryEdgeHeight).toBeCloseTo(spec.origin.y, 7);
  expect(exitEdgeHeight).toBeCloseTo(spec.origin.y + spec.rise, 7);

  const chordError = (samples: number[]) => Math.max(...samples.slice(1).map((u1, index) => {
    const u0 = samples[index];
    const midpoint = (u0 + u1) * 0.5;
    const chordHeight = (
      sampleLaunchRampProfile(spec, u0)
      + sampleLaunchRampProfile(spec, u1)
    ) * 0.5;
    return Math.abs(sampleLaunchRampProfile(spec, midpoint) - chordHeight);
  }));
  const authoredSamples = [...new Set(
    Array.from({ length: topVertexCount }, (_entry, index) => uvs.getX(index).toFixed(7)),
  )].map(Number).sort((a, b) => a - b);
  const uniformSamples = Array.from(
    { length: longitudinal + 1 },
    (_entry, index) => index / longitudinal,
  );
  expect(authoredSamples).toHaveLength(longitudinal + 1);
  expect(chordError(authoredSamples)).toBeLessThan(chordError(uniformSamples));
  flow.geometry.dispose();
});

test('banked turns ease both elevation and banking into flat endpoint normals', () => {
  const spec: BankedTurnSpec = {
    center: { x: 0, y: 5, z: 0 },
    startAngle: 0,
    sweepAngle: Math.PI * 0.5,
    centerRadius: 24,
    width: 10,
    bankAngle: THREE.MathUtils.degToRad(28),
    rise: 12,
    bankBlendExponent: 1.5,
    longitudinalSegments: 20,
    lateralSegments: 5,
    solid: false,
  };
  const pointAt = (u: number, lateral: number) => {
    const angle = spec.startAngle + spec.sweepAngle * u;
    const radius = spec.centerRadius + lateral;
    return {
      x: spec.center.x + Math.sin(angle) * radius,
      z: spec.center.z + Math.cos(angle) * radius,
    };
  };

  const entry = pointAt(0, spec.width * 0.4);
  const exit = pointAt(1, spec.width * 0.4);
  const entryNormal = sampleBankedTurnNormal(spec, entry.x, entry.z)!;
  const exitNormal = sampleBankedTurnNormal(spec, exit.x, exit.z)!;
  expect(entryNormal.dot(THREE.Object3D.DEFAULT_UP)).toBeCloseTo(1, 7);
  expect(exitNormal.dot(THREE.Object3D.DEFAULT_UP)).toBeCloseTo(1, 7);
  expect(sampleBankedTurnHeight(spec, entry.x, entry.z)).toBeCloseTo(spec.center.y, 7);
  expect(sampleBankedTurnHeight(spec, exit.x, exit.z)).toBeCloseTo(spec.center.y + spec.rise!, 7);

  for (const u of [0.0001, 0.9999]) {
    const nearEndpoint = pointAt(u, spec.width * 0.4);
    const normal = sampleBankedTurnNormal(spec, nearEndpoint.x, nearEndpoint.z)!;
    expect(normal.dot(THREE.Object3D.DEFAULT_UP)).toBeGreaterThan(0.999_999);
  }

  const midpoint = pointAt(0.5, spec.width * 0.4);
  const midpointNormal = sampleBankedTurnNormal(spec, midpoint.x, midpoint.z)!;
  expect(midpointNormal.dot(THREE.Object3D.DEFAULT_UP)).toBeLessThan(0.95);

  const flow = buildBankedTurn(spec);
  const normals = flow.geometry.getAttribute('normal');
  const uvs = flow.geometry.getAttribute('uv');
  const topVertexCount = spec.longitudinalSegments! * spec.lateralSegments! * 6;
  const renderedNormal = new THREE.Vector3();
  for (let index = 0; index < topVertexCount; index += 1) {
    if (uvs.getX(index) > 1e-7 && uvs.getX(index) < 1 - 1e-7) continue;
    renderedNormal.fromBufferAttribute(normals, index);
    expect(renderedNormal.dot(THREE.Object3D.DEFAULT_UP)).toBeCloseTo(1, 6);
  }
  flow.geometry.dispose();
});
