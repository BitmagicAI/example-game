import * as THREE from 'three';
import type { WarmLightLook } from './looks.js';

/**
 * Stage batching: merges the opaque meshes of a freshly loaded stage into a few big ones.
 *
 * The Blender export gives one mesh per material per object, and comicifyScene gives every palette entry its own comic material. three.js WebGPU builds
 * one render pipeline (and WGSL) per material INSTANCE and pays per-object uniform uploads per draw, so a stage cost 20-50 pipeline compilations when its
 * world was first entered and 100-250 draw calls (main + shadow pass) every frame. Here every opaque mesh becomes part of ONE shared white material
 * with its colour baked into the vertex colours: colour = material colour x vertex tint x painterly noise, and multiplying the material colour into
 * the tint ahead of time is the same product the shader computed per fragment (float32 all the way; normals and tints decode exactly as the GPU
 * would). Glowing parts merge too: their emissive colour and 'no painterly noise' ride in the `emitK` attribute. Nothing else changes: same vertices,
 * same normals, same shadow casting and receiving.
 *
 * Where a boardwalk rests on an island its planks lie in the island's top plane. Draw order alone cannot settle that tie: two different triangles in
 * one plane interpolate slightly different depths, so the plank and the grass still flickered through each other as the camera moved. The island
 * ground (grass, dirt, moss, rock) is therefore a batch of its own, drawn with `groundMaterial`, the same material with a polygon offset that pushes
 * its depth a hair back: anything lying on an island always wins. Within each batch the authored object order is kept. Meshes with a transform of
 * their own are left alone (they stay separate draws, as before).
 *
 * A look with `warmLight` (looks.ts) also bakes soft warm light pools into the batch: every vertex near a lantern, window or carved face of the
 * look's source materials gets `albedo x colour x strength x falloff` added to its emissive (WebGPU) or to its albedo (the WebGL fallback has no
 * emissive attribute). Light is per vertex, so it costs nothing per frame; it is not shadowed, which suits a glow that spills around a lantern.
 *
 * NOT merged (left exactly as loaded): transparent materials, skinned / instanced meshes, meshes with their own transform, and anything with
 * attributes other than position / normal / colour. Meshes are merged per mover: the A_ group node that poses them, or the static stage as a whole.
 */

/** Materials of the islands themselves (top, side, underside); everything else is laid on them and must win a coplanar tie. */
const GROUND = new Set(['grass', 'grass_dark', 'dirt', 'moss', 'rock', 'rock_dark']);

/**
 * b09's lake: one 480 m plane that covers most of the screen, so its painterly noise (five 3D noise samples per fragment) is shaded on most pixels of the
 * frame. It is kept as a mesh of its own, drawn LAST (fragments behind anything nearer are rejected by the depth test before they are shaded), and
 * StageView may give it the noise-free `stageFlatMaterial` on devices below the top quality tier. Everything else is unchanged: same depth, same shadows.
 */
const LAKE = new Set(['lake']);

/** `?lake=full` keeps the painterly lake on every device, `?lake=flat` forces the noise-free one, `?lake=off` does not split the lake off at all (comparisons). */
export function lakeParam(): 'auto' | 'full' | 'flat' | 'off' {
    try {
        const v = new URLSearchParams(window.location.search).get('lake');
        return v === 'full' || v === 'flat' || v === 'off' ? v : 'auto';
    } catch { return 'auto'; }
}

/** Emissive colours are stored divided by this so they fit an unorm16 (glow intensities are ~1.35; comic.ts multiplies it back). */
export const EMIT_SCALE = 4;
/** `?snorm=0` batches with float32 normals instead of int8x4 (comparisons: the two must render the same pixels). */
const noSnorm = (): boolean => { try { return new URLSearchParams(window.location.search).get('snorm') === '0'; } catch { return false; } };
type NormalAttr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
/** Raw int8 storage of a normalized int8 normal attribute (plain, or the exporter's 4-byte-padded interleaved x3), or null when it is anything else. */
function int8Normals(a: NormalAttr): { arr: Int8Array; stride: number; off: number } | null {
    if (!a.normalized) return null;
    const ia = a as THREE.InterleavedBufferAttribute;
    if (ia.isInterleavedBufferAttribute) return ia.data.array instanceof Int8Array ? { arr: ia.data.array, stride: ia.data.stride, off: ia.offset } : null;
    return a.array instanceof Int8Array ? { arr: a.array, stride: a.itemSize, off: 0 } : null;
}
const u16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v * 65535)));

export interface BatchStats { meshesBefore: number; meshesAfter: number; merged: number; kept: number; lake: THREE.Mesh[] }

interface Source { mesh: THREE.Mesh; pose: THREE.Object3D }

interface BatchInfo { glow: boolean; emissive: [number, number, number] }

const _m = new THREE.Matrix4();
const _inv = new THREE.Matrix4();

function isIdentity(m: THREE.Matrix4): boolean {
    const e = m.elements;
    for (let i = 0; i < 16; i++) if (Math.abs(e[i]! - ((i % 5 === 0) ? 1 : 0)) > 1e-6) return false;
    return true;
}

function batchable(mesh: THREE.Mesh, allowGlow: boolean): boolean {
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return false;
    const mat = mesh.material;
    const info = !Array.isArray(mat) && mat ? (mat as { userData?: { batch?: BatchInfo | null } }).userData?.batch : null;
    if (!info || (info.glow && !allowGlow)) return false;
    const g = mesh.geometry;
    if (!g.getAttribute('position') || !g.getAttribute('normal') || !g.index) return false;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'color') return false;
    return true;
}

/**
 * @param content   the stage's GLB scene (root of the static geometry)
 * @param poseNodes the animated group nodes (children of `content` that the sim poses every frame)
 * @param material  the shared material the merged meshes are drawn with (white, vertexColors on)
 * @param allowGlow merge emissive parts too (needs the `emitK`-aware material: WebGPU only; the WebGL fallback material has no emissive attribute)
 */
export function batchStage(
    content: THREE.Object3D, poseNodes: ReadonlySet<THREE.Object3D>, material: THREE.Material, allowGlow = true, warm: WarmLightLook | null = null,
    groundMaterial: THREE.Material = material,
): BatchStats {
    content.updateWorldMatrix(true, true);
    const lights = warm ? collectWarmLights(content, poseNodes, warm) : null;
    if (lights && new URLSearchParams(window.location.search).has('debug')) console.log(`[tor] warm lights: ${[...lights.values()].map((l) => l.count).join(' + ')} sources`);
    let meshesBefore = 0;
    const sources: Source[] = [];
    const keptGeometries = new Set<THREE.BufferGeometry>();
    content.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        meshesBefore++;
        let pose: THREE.Object3D = content;
        for (let p = mesh.parent; p; p = p.parent) if (poseNodes.has(p)) { pose = p; break; }
        if (batchable(mesh, allowGlow)) {
            _inv.copy(pose.matrixWorld).invert();
            _m.multiplyMatrices(_inv, mesh.matrixWorld);
            if (isIdentity(_m)) { sources.push({ mesh, pose }); return; }
        }
        keptGeometries.add(mesh.geometry);
    });

    // group by mover
    const byPose = new Map<THREE.Object3D, Source[]>();
    for (const s of sources) { let l = byPose.get(s.pose); if (!l) byPose.set(s.pose, l = []); l.push(s); }
    const isGround = (m: THREE.Mesh): boolean => GROUND.has((m.material as THREE.Material).name);
    for (const l of byPose.values()) l.sort((a, b) => a.mesh.id - b.mesh.id);

    let merged = 0;
    const lake: THREE.Mesh[] = [];
    const split = allowGlow && lakeParam() !== 'off';      // the lake mesh is drawn with the WebGPU material's variants
    const isLake = (m: THREE.Mesh): boolean => split && LAKE.has((m.material as THREE.Material).name);
    for (const [pose, all] of byPose) {
        // one batch per mover / for the static stage (the lake plane is split off, see LAKE): vertices and indices are concatenated in draw order
        const rest = all.filter((s) => !isLake(s.mesh) && !isGround(s.mesh));
        const ground = all.filter((s) => !isLake(s.mesh) && isGround(s.mesh));
        const water = all.filter((s) => isLake(s.mesh));
        if (ground.length) { build(pose, ground, 0, groundMaterial, ':ground'); merged++; }
        if (rest.length) { build(pose, rest, 0); merged++; }
        if (water.length) { lake.push(build(pose, water, 100)); merged++; }
    }

    function build(pose: THREE.Object3D, list: Source[], renderOrder: number, mat: THREE.Material = material, suffix = ''): THREE.Mesh {
        let nv = 0, ni = 0;
        for (const { mesh } of list) { nv += mesh.geometry.getAttribute('position').count; ni += mesh.geometry.index!.count; }
        // vertex layout, 32 B: position f32x3, normal snorm8x4 when every source stores int8 normals (as exported: exact; also the exporter's 4-byte-padded interleaved
        // int8x3) else f32x3, colour and emitK unorm16x4 (WebGPU here cannot take half floats)
        const snorm = !noSnorm() && list.every(({ mesh }) => int8Normals(mesh.geometry.getAttribute('normal') as NormalAttr) !== null);
        const pos = new Float32Array(nv * 3), col = new Uint16Array(nv * 4), emitK = new Uint16Array(nv * 4);
        const nor = snorm ? new Int8Array(nv * 4) : new Float32Array(nv * 3);
        const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
        let vo = 0, io = 0;
        for (const { mesh } of list) {
            const g = mesh.geometry;
            const P = g.getAttribute('position') as THREE.BufferAttribute;
            const N = g.getAttribute('normal') as NormalAttr;
            const i8n = snorm ? int8Normals(N) : null;
            const C = g.getAttribute('color') as THREE.BufferAttribute | undefined;
            const I = g.index!;
            const mat = mesh.material as THREE.MeshToonMaterial;
            const mr = mat.color.r, mg = mat.color.g, mb = mat.color.b;
            const info = (mat.userData as { batch: BatchInfo }).batch;
            const ek = info.glow ? 0 : 1, er = info.glow ? info.emissive[0] : 0, eg = info.glow ? info.emissive[1] : 0, eb = info.glow ? info.emissive[2] : 0;   // no painterly noise on glowing parts, as authored
            const hr = u16(mr), hg = u16(mg), hb = u16(mb), her = u16(er / EMIT_SCALE), heg = u16(eg / EMIT_SCALE), heb = u16(eb / EMIT_SCALE), hek = ek ? 65535 : 0;
            const n = P.count;
            const lit = lights && !info.glow ? lights.get(pose) ?? null : null;
            for (let v = 0; v < n; v++) {
                const o3 = (vo + v) * 3, o4 = (vo + v) * 4;
                pos[o3] = P.getX(v); pos[o3 + 1] = P.getY(v); pos[o3 + 2] = P.getZ(v);
                if (snorm) { const s8 = i8n!, o = v * s8.stride + s8.off; nor[o4] = s8.arr[o]!; nor[o4 + 1] = s8.arr[o + 1]!; nor[o4 + 2] = s8.arr[o + 2]!; nor[o4 + 3] = 0; }
                else { nor[o3] = N.getX(v); nor[o3 + 1] = N.getY(v); nor[o3 + 2] = N.getZ(v); }
                if (C) { col[o4] = u16(C.getX(v) * mr); col[o4 + 1] = u16(C.getY(v) * mg); col[o4 + 2] = u16(C.getZ(v) * mb); col[o4 + 3] = u16(C.itemSize >= 4 ? C.getW(v) : 1); }
                else { col[o4] = hr; col[o4 + 1] = hg; col[o4 + 2] = hb; col[o4 + 3] = 65535; }
                emitK[o4] = her; emitK[o4 + 1] = heg; emitK[o4 + 2] = heb; emitK[o4 + 3] = hek;
                if (lit) {
                    const k = lit.at(pos[o3]!, pos[o3 + 1]!, pos[o3 + 2]!);
                    if (k > 0) {
                        const ar = col[o4]! / 65535, ag = col[o4 + 1]! / 65535, ab = col[o4 + 2]! / 65535;
                        const w = warm!, c = lit.color;
                        if (allowGlow) {
                            emitK[o4] = u16((ar * c.r * w.strength * k) / EMIT_SCALE);
                            emitK[o4 + 1] = u16((ag * c.g * w.strength * k) / EMIT_SCALE);
                            emitK[o4 + 2] = u16((ab * c.b * w.strength * k) / EMIT_SCALE);
                        } else {
                            col[o4] = u16(ar * (1 + c.r * w.strength * k)); col[o4 + 1] = u16(ag * (1 + c.g * w.strength * k)); col[o4 + 2] = u16(ab * (1 + c.b * w.strength * k));
                        }
                    }
                }
            }
            for (let t = 0; t < I.count; t++) idx[io + t] = I.getX(t) + vo;
            vo += n; io += I.count;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('normal', snorm ? new THREE.BufferAttribute(nor as Int8Array, 4, true) : new THREE.BufferAttribute(nor as Float32Array, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 4, true));
        geo.setAttribute('emitK', new THREE.BufferAttribute(emitK, 4, true));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = `batch:${pose === content ? 'stage' : pose.name}${renderOrder ? ':lake' : ''}${suffix}`;
        mesh.renderOrder = renderOrder;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        pose.add(mesh);
        return mesh;
    }

    // drop the sources (never drawn yet, so nothing on the GPU to free; geometries still used by a kept mesh stay)
    for (const { mesh } of sources) {
        mesh.removeFromParent();
        if (!keptGeometries.has(mesh.geometry)) mesh.geometry.dispose();
    }
    if (new URLSearchParams(window.location.search).has('batchlog')) {
        const kept: string[] = [];
        content.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.name.startsWith('batch:')) kept.push(`${(m.material as THREE.Material).name || (m.material as THREE.Material).type}:${m.geometry.index ? m.geometry.index.count / 3 : 0}`); });
        console.log('[tor] batch kept meshes:', kept.join(' '));
    }
    return { meshesBefore, meshesAfter: meshesBefore - sources.length + merged, merged, kept: meshesBefore - sources.length, lake };
}

/** Warm light sources of one mover (or the static stage), in its own frame, behind a coarse spatial hash. */
class WarmLights {
    private cells = new Map<string, number[]>();
    readonly color: THREE.Color;
    get count(): number { return this.pts.length / 3; }
    constructor(private readonly pts: number[], private readonly radius: number, color: string) {
        this.color = new THREE.Color(color);
        for (let i = 0; i < pts.length; i += 3) {
            const key = this.key(pts[i]!, pts[i + 1]!, pts[i + 2]!);
            let l = this.cells.get(key);
            if (!l) this.cells.set(key, l = []);
            l.push(i);
        }
    }
    private key(x: number, y: number, z: number): string { const r = this.radius; return `${Math.floor(x / r)},${Math.floor(y / r)},${Math.floor(z / r)}`; }
    /** Summed falloff of every source within the radius, (1 - d/r)^2 each, capped at 1 (a carved face is many sources on its own pumpkin). */
    at(x: number, y: number, z: number): number {
        const r = this.radius;
        const cx = Math.floor(x / r), cy = Math.floor(y / r), cz = Math.floor(z / r);
        let k = 0;
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let m = -1; m <= 1; m++) {
            const l = this.cells.get(`${cx + i},${cy + j},${cz + m}`);
            if (!l) continue;
            for (const o of l) {
                const d = Math.hypot(x - this.pts[o]!, y - this.pts[o + 1]!, z - this.pts[o + 2]!) / r;
                if (d < 1) k += (1 - d) * (1 - d);
            }
        }
        return Math.min(1, k);
    }
}

/**
 * Centres of the look's glowing sources per mover. The level exporter joins every object of one material into one mesh, so a mesh is not a lantern:
 * its vertices are clustered (greedy, 1 m) and each cluster is a source (a lantern, a window, a carved face).
 */
function collectWarmLights(content: THREE.Object3D, poseNodes: ReadonlySet<THREE.Object3D>, warm: WarmLightLook): Map<THREE.Object3D, WarmLights> {
    const names = new Set(warm.sources);
    const byPose = new Map<THREE.Object3D, { sum: number[]; n: number[] }>();
    const v = new THREE.Vector3(), m = new THREE.Matrix4(), inv = new THREE.Matrix4();
    content.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || Array.isArray(mesh.material) || !names.has((mesh.material as THREE.Material).name)) return;
        let pose: THREE.Object3D = content;
        for (let p = mesh.parent; p; p = p.parent) if (poseNodes.has(p)) { pose = p; break; }
        m.multiplyMatrices(inv.copy(pose.matrixWorld).invert(), mesh.matrixWorld);
        let c = byPose.get(pose);
        if (!c) byPose.set(pose, c = { sum: [], n: [] });
        const P = mesh.geometry.getAttribute('position');
        for (let i = 0; i < P.count; i++) {
            v.fromBufferAttribute(P, i).applyMatrix4(m);
            let hit = -1;
            for (let k = 0; k < c.n.length; k++) {
                const nk = c.n[k]!;
                if (Math.hypot(c.sum[k * 3]! / nk - v.x, c.sum[k * 3 + 1]! / nk - v.y, c.sum[k * 3 + 2]! / nk - v.z) < 1) { hit = k; break; }
            }
            if (hit < 0) { c.sum.push(v.x, v.y, v.z); c.n.push(1); }
            else { c.sum[hit * 3] = c.sum[hit * 3]! + v.x; c.sum[hit * 3 + 1] = c.sum[hit * 3 + 1]! + v.y; c.sum[hit * 3 + 2] = c.sum[hit * 3 + 2]! + v.z; c.n[hit] = c.n[hit]! + 1; }
        }
    });
    const out = new Map<THREE.Object3D, WarmLights>();
    for (const [pose, c] of byPose) {
        const pts: number[] = [];
        for (let k = 0; k < c.n.length; k++) pts.push(c.sum[k * 3]! / c.n[k]!, c.sum[k * 3 + 1]! / c.n[k]!, c.sum[k * 3 + 2]! / c.n[k]!);
        out.set(pose, new WarmLights(pts, warm.radius, warm.color));
    }
    return out;
}
