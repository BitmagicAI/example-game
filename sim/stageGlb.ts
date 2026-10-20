import { Quat, Vec3 } from './math3.js';
import { TriGrid } from './collision.js';
import type {
    AnimSpec, CollisionGroup, CollisionMesh, IntroKey, ItemKind, StageData, StageItem, SurfaceProps,
} from './stageData.js';

/**
 * Parses a stage GLB exported by the Blender level scripts (tools/level/smblib.py) into `StageData`.
 *
 * No three.js: this runs in the browser AND in Node (automated stage tests), on the very same
 * bytes the renderer loads, so what the ball hits is what the player sees.
 *
 * Node naming contract (Blender object names survive the glTF export):
 *   STAGE            root empty; custom props (glTF extras): title, world, time, par, fallY, pivot, intro
 *   C_<name>         collision-only mesh (never drawn). extras: friction, restitution, conveyor
 *   V_<name>         visual mesh (ignored here, drawn by the renderer)
 *   A_<id>           animated group (empty). extras.anim = AnimSpec (JSON). Holds C_/V_/I_ children
 *   I_<kind>_<n>     item empty: start, goal, candy, bucket, bumper, wormhole, light, cam, prop
 */

interface GltfNode {
    name?: string; children?: number[]; mesh?: number;
    translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[];
    extras?: Record<string, unknown>;
}
interface GltfJson {
    scene?: number; scenes?: { nodes?: number[] }[]; nodes?: GltfNode[];
    meshes?: { name?: string; primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
    accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
    bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { EXT_meshopt_compression?: MeshoptView } }[];
}
/** EXT_meshopt_compression on a buffer view: the compressed bytes live in `buffer` (the GLB's BIN chunk) at `byteOffset`; the view's own byteLength is the decoded size. */
interface MeshoptView { buffer: number; byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string }
/** The decoder EXT_meshopt_compression buffer views need (three's MeshoptDecoder fits). Optional: files without the extension never touch it. */
export interface MeshoptDecoderLike { decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void }
interface BinSource { bin: DataView; meshopt?: MeshoptDecoderLike; decoded: Map<number, DataView> }

const COMP_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

type Mat = Float64Array; // column-major 4x4

function matIdentity(): Mat { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
function matMul(a: Mat, b: Mat): Mat {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
        o[c * 4 + r] = s;
    }
    return o;
}
function matFromTRS(t: number[] | undefined, q: number[] | undefined, s: number[] | undefined): Mat {
    const tx = t?.[0] ?? 0, ty = t?.[1] ?? 0, tz = t?.[2] ?? 0;
    const x = q?.[0] ?? 0, y = q?.[1] ?? 0, z = q?.[2] ?? 0, w = q?.[3] ?? 1;
    const sx = s?.[0] ?? 1, sy = s?.[1] ?? 1, sz = s?.[2] ?? 1;
    const m = new Float64Array(16);
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
    m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx;
    m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy;
    m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz;
    m[12] = tx; m[13] = ty; m[14] = tz; m[15] = 1;
    return m;
}
function nodeMatrix(n: GltfNode): Mat {
    if (n.matrix) return Float64Array.from(n.matrix);
    return matFromTRS(n.translation, n.rotation, n.scale);
}
function quatFromMat(m: Mat): Quat {
    // strip scale
    const sx = Math.hypot(m[0]!, m[1]!, m[2]!) || 1, sy = Math.hypot(m[4]!, m[5]!, m[6]!) || 1, sz = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
    const m11 = m[0]! / sx, m21 = m[1]! / sx, m31 = m[2]! / sx;
    const m12 = m[4]! / sy, m22 = m[5]! / sy, m32 = m[6]! / sy;
    const m13 = m[8]! / sz, m23 = m[9]! / sz, m33 = m[10]! / sz;
    const tr = m11 + m22 + m33;
    const q = new Quat();
    if (tr > 0) {
        const s = 0.5 / Math.sqrt(tr + 1);
        q.set((m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s);
    } else if (m11 > m22 && m11 > m33) {
        const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
        q.set(0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s);
    } else if (m22 > m33) {
        const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
        q.set((m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s);
    } else {
        const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
        q.set((m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s);
    }
    return q.normalize();
}

function parseMaybeJson(v: unknown): unknown {
    if (typeof v === 'string') {
        const s = v.trim();
        if (s.startsWith('{') || s.startsWith('[')) {
            try { return JSON.parse(s); } catch { return v; }
        }
    }
    return v;
}
function num(v: unknown, d: number): number { return typeof v === 'number' && Number.isFinite(v) ? v : d; }
function vec3Of(v: unknown, d: [number, number, number]): [number, number, number] {
    const a = parseMaybeJson(v);
    return Array.isArray(a) && a.length >= 3 ? [Number(a[0]), Number(a[1]), Number(a[2])] : d;
}

/** Bytes of one buffer view: the BIN chunk itself, or (EXT_meshopt_compression) the view decoded once into its own array. */
function viewBytes(json: GltfJson, src: BinSource, viewIndex: number): { dv: DataView; base: number } {
    const view = json.bufferViews![viewIndex]!;
    const ext = view.extensions?.EXT_meshopt_compression;
    if (!ext) return { dv: src.bin, base: view.byteOffset ?? 0 };
    let dv = src.decoded.get(viewIndex);
    if (!dv) {
        if (!src.meshopt) throw new Error('stage: the GLB is meshopt-compressed but parseStageGlb was given no decoder');
        const out = new Uint8Array(ext.count * ext.byteStride);
        src.meshopt.decodeGltfBuffer(out, ext.count, ext.byteStride, new Uint8Array(src.bin.buffer, src.bin.byteOffset + (ext.byteOffset ?? 0), ext.byteLength), ext.mode, ext.filter ?? 'NONE');
        dv = new DataView(out.buffer);
        src.decoded.set(viewIndex, dv);
    }
    return { dv, base: 0 };
}

function readAccessor(json: GltfJson, src: BinSource, index: number): { data: Float64Array; count: number; comps: number } {
    const acc = json.accessors![index]!;
    const comps = TYPE_COUNT[acc.type]!;
    const out = new Float64Array(acc.count * comps);
    if (acc.bufferView === undefined) return { data: out, count: acc.count, comps };
    const view = json.bufferViews![acc.bufferView]!;
    const { dv: bin, base: viewBase } = viewBytes(json, src, acc.bufferView);
    const csize = COMP_SIZE[acc.componentType]!;
    const stride = view.byteStride ?? csize * comps;
    const base = viewBase + (acc.byteOffset ?? 0);
    for (let i = 0; i < acc.count; i++) {
        for (let c = 0; c < comps; c++) {
            const off = base + i * stride + c * csize;
            let v: number;
            switch (acc.componentType) {
                case 5126: v = bin.getFloat32(off, true); break;
                case 5123: v = bin.getUint16(off, true); if (acc.normalized) v /= 65535; break;
                case 5125: v = bin.getUint32(off, true); break;
                case 5121: v = bin.getUint8(off); if (acc.normalized) v /= 255; break;
                case 5122: v = bin.getInt16(off, true); if (acc.normalized) v = Math.max(v / 32767, -1); break;
                case 5120: v = bin.getInt8(off); if (acc.normalized) v = Math.max(v / 127, -1); break;
                default: throw new Error('unsupported accessor component type ' + acc.componentType);
            }
            out[i * comps + c] = v;
        }
    }
    return { data: out, count: acc.count, comps };
}

export interface ParseOptions {
    /** Grid cell size for collision queries (m). */
    cell?: number;
    defaultFriction?: number;
    defaultRestitution?: number;
    /** Needed only when the GLB is stored with EXT_meshopt_compression (the published stages are): three's MeshoptDecoder, once its `ready` has resolved. */
    meshopt?: MeshoptDecoderLike;
}

export function parseStageGlb(buffer: ArrayBuffer, opts: ParseOptions = {}): StageData {
    const dv = new DataView(buffer);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('stage: not a GLB file');
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen))) as GltfJson;
    let binStart = 20 + jsonLen;
    let bin = new DataView(buffer, 0, 0);
    if (binStart + 8 <= buffer.byteLength) {
        const binLen = dv.getUint32(binStart, true);
        bin = new DataView(buffer, binStart + 8, binLen);
    }
    const src: BinSource = { bin, meshopt: opts.meshopt, decoded: new Map() };
    const nodes = json.nodes ?? [];
    const parent = new Int32Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => n.children?.forEach((c) => { parent[c] = i; }));

    let stageIdx = nodes.findIndex((n) => n.name === 'STAGE');
    if (stageIdx < 0) throw new Error('stage: GLB has no STAGE root node');
    const stageNode = nodes[stageIdx]!;
    const se = stageNode.extras ?? {};

    const defFriction = opts.defaultFriction ?? 0.045;
    const defRestitution = opts.defaultRestitution ?? 0.5;
    const cell = opts.cell ?? 2;

    const groups: CollisionGroup[] = [];
    const items: StageItem[] = [];
    const staticGroup: CollisionGroup = {
        id: 'static', nodeName: 'static', meshes: [], basePos: new Vec3(), baseQuat: new Quat(), anim: null,
        min: new Vec3(Infinity, Infinity, Infinity), max: new Vec3(-Infinity, -Infinity, -Infinity),
    };
    groups.push(staticGroup);

    // Triangles are gathered per group and per surface signature, then turned into grids.
    interface Pending { name: string; tris: number[]; surface: SurfaceProps }
    const pending = new Map<CollisionGroup, Pending[]>();
    pending.set(staticGroup, []);

    const walk = (idx: number, groupMat: Mat, group: CollisionGroup, groupIdx: number): void => {
        const n = nodes[idx]!;
        const name = n.name ?? '';
        const local = nodeMatrix(n);
        const m = matMul(groupMat, local);

        if (name.startsWith('A_')) {
            if (group !== staticGroup) throw new Error(`stage: nested animated group ${name} in ${group.nodeName}`);
            const g: CollisionGroup = {
                id: name, nodeName: name, meshes: [], basePos: new Vec3(m[12]!, m[13]!, m[14]!), baseQuat: quatFromMat(m),
                anim: (parseMaybeJson(n.extras?.anim) as AnimSpec | undefined) ?? null,
                min: new Vec3(Infinity, Infinity, Infinity), max: new Vec3(-Infinity, -Infinity, -Infinity),
            };
            const gi = groups.length;
            groups.push(g);
            pending.set(g, []);
            for (const c of n.children ?? []) walk(c, matIdentity(), g, gi);
            return;
        }
        if (name.startsWith('C_') && n.mesh !== undefined) {
            const mesh = json.meshes![n.mesh]!;
            const e = n.extras ?? {};
            const surface: SurfaceProps = {
                friction: num(e.friction, defFriction),
                restitution: num(e.restitution, defRestitution),
                conveyor: e.conveyor === undefined ? null : vec3Of(e.conveyor, [0, 0, 0]),
            };
            const tris: number[] = [];
            for (const prim of mesh.primitives) {
                if ((prim.mode ?? 4) !== 4) continue;
                const pos = readAccessor(json, src, prim.attributes.POSITION!);
                const wp = new Float64Array(pos.count * 3);
                for (let i = 0; i < pos.count; i++) {
                    const x = pos.data[i * 3]!, y = pos.data[i * 3 + 1]!, z = pos.data[i * 3 + 2]!;
                    wp[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
                    wp[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
                    wp[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
                }
                const idxs = prim.indices !== undefined ? readAccessor(json, src, prim.indices).data : null;
                const triN = idxs ? idxs.length / 3 : pos.count / 3;
                for (let t = 0; t < triN; t++) {
                    for (let k = 0; k < 3; k++) {
                        const vi = idxs ? idxs[t * 3 + k]! : t * 3 + k;
                        tris.push(wp[vi * 3]!, wp[vi * 3 + 1]!, wp[vi * 3 + 2]!);
                    }
                }
            }
            if (tris.length) pending.get(group)!.push({ name, tris, surface });
        } else if (name.startsWith('I_')) {
            const parts = name.split('_');
            const kind = (parts[1] ?? 'prop') as ItemKind;
            const e: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(n.extras ?? {})) e[k] = parseMaybeJson(v);
            items.push({
                id: items.length, name, kind, group: groupIdx,
                pos: new Vec3(m[12]!, m[13]!, m[14]!), quat: quatFromMat(m), extras: e,
            });
        }
        for (const c of n.children ?? []) walk(c, m, group, groupIdx);
    };
    for (const c of stageNode.children ?? []) walk(c, matIdentity(), staticGroup, 0);

    for (const g of groups) {
        for (const p of pending.get(g)!) {
            const tris = Float32Array.from(p.tris);
            const triCount = tris.length / 9;
            for (let i = 0; i < tris.length; i += 3) {
                const x = tris[i]!, y = tris[i + 1]!, z = tris[i + 2]!;
                if (x < g.min.x) g.min.x = x; if (x > g.max.x) g.max.x = x;
                if (y < g.min.y) g.min.y = y; if (y > g.max.y) g.max.y = y;
                if (z < g.min.z) g.min.z = z; if (z > g.max.z) g.max.z = z;
            }
            const mesh: CollisionMesh = { name: p.name, tris, triCount, surface: p.surface, grid: new TriGrid(tris, triCount, cell) };
            g.meshes.push(mesh);
        }
    }

    const intro = (parseMaybeJson(se.intro) as IntroKey[] | undefined) ?? [];
    let candyTotal = 0;
    for (const it of items) {
        if (it.kind === 'candy') candyTotal += 1;
        else if (it.kind === 'bucket') candyTotal += 10;
    }
    const sd: StageData = {
        name: String(se.name ?? 'stage'),
        title: String(se.title ?? se.name ?? 'Stage'),
        world: String(se.world ?? 'patch'),
        time: num(se.time, 60),
        par: num(se.par, 30),
        fallY: num(se.fallY, -30),
        pivot: new Vec3(...vec3Of(se.pivot, [0, 0, 0])),
        groups,
        items,
        intro,
        extras: Object.fromEntries(Object.entries(se).map(([k, v]) => [k, parseMaybeJson(v)])),
        candyTotal,
    };
    if (!items.some((i) => i.kind === 'start')) throw new Error('stage: no I_start item');
    if (!items.some((i) => i.kind === 'goal')) throw new Error('stage: no I_goal item');
    if (!groups.some((g) => g.meshes.length)) throw new Error('stage: no C_ collision meshes');
    return sd;
}
