import * as THREE from 'three';

/**
 * Re-shapes the engine's skybox sphere so an AI-painted panorama whose "horizon" sits low in the
 * image (the ground silhouette at v ~ 0.78) reads correctly for a stage that floats in the sky:
 * the painted horizon is moved to `horizonDeg` below eye level and the whole upper part of the image
 * (moon, clouds, stars) fills the upper hemisphere. Works on both renderers (UVs only).
 */
export interface SkyShape {
    /** Row of the image (0 top .. 1 bottom) where the painted horizon sits. */
    paintedHorizon: number;
    /** Where that horizon should appear, degrees below eye level. */
    horizonDeg: number;
    /** Yaw (rad) turning the panorama about +Y. */
    yaw: number;
}

const originalUv = new WeakMap<THREE.BufferGeometry, Float32Array>();

export function shapeSky(scene: THREE.Scene, shape: SkyShape): THREE.Object3D | null {
    const sky = scene.getObjectByName('Skybox') as THREE.Mesh | undefined;
    if (!sky || !sky.geometry) return null;
    const geo = sky.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    if (!originalUv.has(geo)) originalUv.set(geo, new Float32Array(uv.array as Float32Array));
    const e0 = -shape.horizonDeg * (Math.PI / 180);
    const half = Math.PI / 2;
    for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
        const e = Math.asin(Math.max(-1, Math.min(1, y)));
        let row: number;
        if (e >= e0) row = shape.paintedHorizon * ((half - e) / (half - e0));
        else row = shape.paintedHorizon + (1 - shape.paintedHorizon) * ((e0 - e) / (e0 + half));
        uv.setY(i, 1 - Math.max(0, Math.min(1, row)));
    }
    uv.needsUpdate = true;
    sky.rotation.y = shape.yaw;
    return sky;
}
