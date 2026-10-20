import * as THREE from 'three';

/**
 * Flat-shaded stage meshes are stored without normals (tools/assets/optimize_stage.mjs): flat shading repeats every corner once per face, so the file keeps
 * one vertex per position and colour, and this rebuilds what the exporter had. Each triangle gets its own normal, rounded to int8 exactly like the exporter
 * (tools/level/quantize_glb.py: round(n * 127), stored as snorm8x4 for the WebGPU vertex formats); corners that share position, colour AND normal share a
 * vertex again, so the mesh comes back with the vertex count it was exported with. Runs on the freshly parsed scene, before comicifyScene / batchStage.
 */

type Attr = THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
/** Raw storage of an attribute: meshopt buffer views are padded to a 4-byte stride, so three hands a u8x3 colour over as an InterleavedBufferAttribute (stride 4). */
function raw(a: Attr): { arr: ArrayLike<number> & { constructor: unknown }; stride: number; off: number } {
    const ia = a as THREE.InterleavedBufferAttribute;
    return ia.isInterleavedBufferAttribute
        ? { arr: ia.data.array as never, stride: ia.data.stride, off: ia.offset }
        : { arr: a.array as never, stride: a.itemSize, off: 0 };
}

/** `pack` = the three rounded normal components in one integer. */
const packNormal = (x: number, y: number, z: number): number => (x + 127) | ((y + 127) << 8) | ((z + 127) << 16);
const round8 = (v: number): number => Math.max(-127, Math.min(127, Math.round(v * 127)));

export function expandFlatGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
    const P = g.getAttribute('position') as Attr;
    const C = g.getAttribute('color') as Attr | undefined;
    const I = g.index!;
    const ia = I.array as ArrayLike<number>;
    const T = I.count / 3;
    const { arr: pa, stride: ps, off: po } = raw(P);
    // per source vertex: a chain of the output vertices made from it (one per distinct face normal)
    const head = new Int32Array(P.count).fill(-1);
    const next = new Int32Array(T * 3), outNormal = new Int32Array(T * 3), outSrc = new Int32Array(T * 3);
    const idx = new Uint32Array(T * 3);
    let nv = 0;
    for (let t = 0; t < T; t++) {
        const a = ia[t * 3]!, b = ia[t * 3 + 1]!, c = ia[t * 3 + 2]!;
        const ax = pa[a * ps + po]!, ay = pa[a * ps + po + 1]!, az = pa[a * ps + po + 2]!;
        const ux = pa[b * ps + po]! - ax, uy = pa[b * ps + po + 1]! - ay, uz = pa[b * ps + po + 2]! - az;
        const vx = pa[c * ps + po]! - ax, vy = pa[c * ps + po + 1]! - ay, vz = pa[c * ps + po + 2]! - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        const pk = l < 1e-12 ? packNormal(0, 127, 0)   // degenerate: never visible
            : packNormal(round8(nx / l), round8(ny / l), round8(nz / l));
        for (let k = 0; k < 3; k++) {
            const v = ia[t * 3 + k]!;
            let j = head[v]!;
            while (j >= 0 && outNormal[j] !== pk) j = next[j]!;
            if (j < 0) { j = nv++; outNormal[j] = pk; outSrc[j] = v; next[j] = head[v]!; head[v] = j; }
            idx[t * 3 + k] = j;
        }
    }
    const pos = new Float32Array(nv * 3), nor = new Int8Array(nv * 4);
    const cs = C ? C.itemSize : 0;
    const cr = C ? raw(C) : null;
    const col = C && cr ? new (cr.arr.constructor as new (n: number) => Uint8Array | Uint16Array | Float32Array)(nv * cs) : null;
    for (let j = 0; j < nv; j++) {
        const v = outSrc[j]!, pk = outNormal[j]!;
        pos[j * 3] = pa[v * ps + po]!; pos[j * 3 + 1] = pa[v * ps + po + 1]!; pos[j * 3 + 2] = pa[v * ps + po + 2]!;
        nor[j * 4] = (pk & 255) - 127; nor[j * 4 + 1] = ((pk >> 8) & 255) - 127; nor[j * 4 + 2] = ((pk >> 16) & 255) - 127;
        if (col && cr) for (let k = 0; k < cs; k++) col[j * cs + k] = cr.arr[v * cr.stride + cr.off + k]!;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 4, true));
    if (C && col) out.setAttribute('color', new THREE.BufferAttribute(col, cs, C.normalized));
    out.setIndex(new THREE.BufferAttribute(nv > 65535 ? idx : Uint16Array.from(idx), 1));
    return out;
}

/** Give every mesh that came without normals its flat ones. Returns how many geometries were rebuilt. */
export function expandFlatMeshes(root: THREE.Object3D): number {
    const done = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();   // deduplicated meshes share one geometry
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry;
        if (g.getAttribute('normal') || !g.index || !g.getAttribute('position')) return;
        let e = done.get(g);
        if (!e) { e = expandFlatGeometry(g); done.set(g, e); }
        mesh.geometry = e;
    });
    for (const g of done.keys()) g.dispose();
    return done.size;
}
