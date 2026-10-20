import * as THREE from 'three';
import type { StageData, CollisionMesh } from '../sim/stageData.js';
import type { RouteLightLook } from './looks.js';

/**
 * Route lights: thin, softly glowing dashes just inside the open edges of the walkable floor (where the ball can roll off), for looks that ask for
 * them (looks.ts `routeLights`). Built once per stage from the collision data, so they follow exactly the edges the physics uses:
 *
 *   1. up-facing collision triangles of each mover (or the static stage), welded at 2 cm;
 *   2. edges used by a single triangle are candidates; one with floor just beyond it (a T-junction, or the next mesh of the same deck) is not an edge,
 *      and neither is one whose floor does not continue `DEPTH` inward (the up-facing cap of a rail);
 *   3. the open edges are chained into polylines and dashed along their length (`dash` on, `gap` off), each dash fading in and out;
 *   4. one ribbon per dash, three vertices across (dark, bright, dark), drawn additively: a soft line with no texture, the same on WebGPU and WebGL.
 *
 * One mesh per mover, under the node that poses it (the dashes ride moving decks). The floor's surface detail stays as it is: only the rim glows.
 */

const UP_MIN = 0.6;          // normal.y of a floor triangle
const WELD = 50;             // 1 / 2 cm
const LIFT = 0.02;           // above the collision surface (the deck's top is the collision top)
const DEPTH = 0.3;           // floor must continue this far inward: rail caps (up-facing, ~10 cm wide) are not floor

let material: THREE.Material | null = null;
function routeMaterial(): THREE.Material {
    material ??= new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    material.name = 'routeLights';
    return material;
}

interface Floor { meshes: CollisionMesh[] }

function isFloor(t: Float32Array, o: number): boolean {
    const ax = t[o + 3]! - t[o]!, ay = t[o + 4]! - t[o + 1]!, az = t[o + 5]! - t[o + 2]!;
    const bx = t[o + 6]! - t[o]!, by = t[o + 7]! - t[o + 1]!, bz = t[o + 8]! - t[o + 2]!;
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz);
    return l > 1e-9 && Math.abs(ny / l) >= UP_MIN;
}

/** Is there a floor triangle under/over (x, z) within `dy` of y? (point-in-triangle in XZ) */
function floorAt(f: Floor, x: number, y: number, z: number, dy: number, scratch: number[]): boolean {
    for (const m of f.meshes) {
        const n = m.grid.query(x, y, z, Math.max(0.15, dy), scratch);
        for (let k = 0; k < n; k++) {
            const o = scratch[k]! * 9, t = m.tris;
            if (!isFloor(t, o)) continue;
            const x0 = t[o]!, z0 = t[o + 2]!, x1 = t[o + 3]!, z1 = t[o + 5]!, x2 = t[o + 6]!, z2 = t[o + 8]!;
            const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
            if (Math.abs(d) < 1e-9) continue;
            const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / d;
            const b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / d;
            const c = 1 - a - b;
            if (a < -1e-4 || b < -1e-4 || c < -1e-4) continue;
            const yy = a * t[o + 1]! + b * t[o + 4]! + c * t[o + 7]!;
            if (Math.abs(yy - y) <= dy) return true;
        }
    }
    return false;
}

interface Edge { a: number; b: number; inX: number; inY: number; inZ: number; nX: number; nY: number; nZ: number }

/** Open floor edges of one mover, chained into polylines of welded vertex positions with an inward direction per vertex. */
function openChains(f: Floor): { pts: number[]; inward: number[]; up: number[] }[] {
    const verts: number[] = [];
    const index = new Map<string, number>();
    const vid = (x: number, y: number, z: number): number => {
        const key = `${Math.round(x * WELD)},${Math.round(y * WELD)},${Math.round(z * WELD)}`;
        let i = index.get(key);
        if (i === undefined) { i = verts.length / 3; verts.push(x, y, z); index.set(key, i); }
        return i;
    };
    const edges = new Map<string, Edge & { count: number }>();
    for (const m of f.meshes) {
        const t = m.tris;
        for (let tri = 0; tri < m.triCount; tri++) {
            const o = tri * 9;
            if (!isFloor(t, o)) continue;
            const ids = [vid(t[o]!, t[o + 1]!, t[o + 2]!), vid(t[o + 3]!, t[o + 4]!, t[o + 5]!), vid(t[o + 6]!, t[o + 7]!, t[o + 8]!)];
            const ax = t[o + 3]! - t[o]!, ay = t[o + 4]! - t[o + 1]!, az = t[o + 5]! - t[o + 2]!;
            const bx = t[o + 6]! - t[o]!, by = t[o + 7]! - t[o + 1]!, bz = t[o + 8]! - t[o + 2]!;
            let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
            if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
            for (let e = 0; e < 3; e++) {
                const a = ids[e]!, b = ids[(e + 1) % 3]!, c = ids[(e + 2) % 3]!;
                if (a === b) continue;
                const key = a < b ? `${a}_${b}` : `${b}_${a}`;
                const prev = edges.get(key);
                if (prev) { prev.count++; continue; }
                // inward: from the edge toward the third vertex, perpendicular to the edge, in the triangle's plane
                const ex = verts[b * 3]! - verts[a * 3]!, ey = verts[b * 3 + 1]! - verts[a * 3 + 1]!, ez = verts[b * 3 + 2]! - verts[a * 3 + 2]!;
                const el = Math.hypot(ex, ey, ez) || 1;
                const cx = verts[c * 3]! - verts[a * 3]!, cy = verts[c * 3 + 1]! - verts[a * 3 + 1]!, cz = verts[c * 3 + 2]! - verts[a * 3 + 2]!;
                const along = (cx * ex + cy * ey + cz * ez) / (el * el);
                let ix = cx - ex * along, iy = cy - ey * along, iz = cz - ez * along;
                const il = Math.hypot(ix, iy, iz) || 1; ix /= il; iy /= il; iz /= il;
                edges.set(key, { a, b, inX: ix, inY: iy, inZ: iz, nX: nx, nY: ny, nZ: nz, count: 1 });
            }
        }
    }
    // open = used once, and no floor just outside it
    const scratch: number[] = [];
    const open: Edge[] = [];
    for (const e of edges.values()) {
        if (e.count !== 1) continue;
        const mx = (verts[e.a * 3]! + verts[e.b * 3]!) / 2, my = (verts[e.a * 3 + 1]! + verts[e.b * 3 + 1]!) / 2, mz = (verts[e.a * 3 + 2]! + verts[e.b * 3 + 2]!) / 2;
        if (floorAt(f, mx - e.inX * 0.06, my - e.inY * 0.06, mz - e.inZ * 0.06, 0.06, scratch)) continue;
        if (!floorAt(f, mx + e.inX * DEPTH, my + e.inY * DEPTH, mz + e.inZ * DEPTH, 0.12, scratch)) continue;
        if (Math.hypot(verts[e.a * 3]! - verts[e.b * 3]!, verts[e.a * 3 + 2]! - verts[e.b * 3 + 2]!) < 0.02) continue;
        open.push(e);
    }
    // chain them: vertex -> open edges touching it
    const touch = new Map<number, number[]>();
    open.forEach((e, i) => { for (const v of [e.a, e.b]) { let l = touch.get(v); if (!l) touch.set(v, l = []); l.push(i); } });
    const used = new Uint8Array(open.length);
    const chains: { pts: number[]; inward: number[]; up: number[] }[] = [];
    const walk = (start: number): void => {
        // extend backwards to a chain end (a vertex with one open edge) when there is one, then forward
        let e0 = start, v0 = open[start]!.a;
        for (let guard = 0; guard < open.length; guard++) {
            const l = (touch.get(v0) ?? []).filter((i) => i !== e0 && !used[i]);
            if (l.length !== 1) break;
            const ne = open[l[0]!]!;
            if (l[0] === start) break;
            e0 = l[0]!; v0 = ne.a === v0 ? ne.b : ne.a;
        }
        const pts: number[] = [], inward: number[] = [], up: number[] = [];
        let e = e0, v = v0;
        const push = (vi: number, ed: Edge): void => { pts.push(verts[vi * 3]!, verts[vi * 3 + 1]!, verts[vi * 3 + 2]!); inward.push(ed.inX, ed.inY, ed.inZ); up.push(ed.nX, ed.nY, ed.nZ); };
        push(v, open[e]!);
        while (e >= 0 && !used[e]) {
            used[e] = 1;
            const ed = open[e]!;
            const nv = ed.a === v ? ed.b : ed.a;
            push(nv, ed);
            // average the inward direction at the shared vertex with the next edge (smooth corners)
            const next = (touch.get(nv) ?? []).filter((i) => !used[i]);
            if (next.length === 1) {
                const n2 = open[next[0]!]!;
                const k = inward.length - 3;
                let ix = inward[k]! + n2.inX, iy = inward[k + 1]! + n2.inY, iz = inward[k + 2]! + n2.inZ;
                const il = Math.hypot(ix, iy, iz);
                if (il > 0.5) { ix /= il; iy /= il; iz /= il; inward[k] = ix; inward[k + 1] = iy; inward[k + 2] = iz; }
                e = next[0]!; v = nv;
            } else e = -1;
        }
        if (pts.length >= 6) chains.push({ pts, inward, up });
    };
    for (let i = 0; i < open.length; i++) if (!used[i]) walk(i);
    return chains;
}

/** Build the route lights of a stage and parent each mover's mesh under `nodeFor(groupIndex)`. Returns the meshes (StageView disposes them with the stage). */
export function buildRouteLights(data: StageData, look: RouteLightLook, nodeFor: (gi: number) => THREE.Object3D): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const col = new THREE.Color(look.color).multiplyScalar(look.intensity);
    data.groups.forEach((g, gi) => {
        const chains = openChains({ meshes: g.meshes });
        const P: number[] = [], C: number[] = [], I: number[] = [];
        const hw = look.width / 2, period = look.dash + look.gap, fadeLen = Math.min(0.35, look.dash * 0.3);
        const a = new THREE.Vector3(), b = new THREE.Vector3(), ia = new THREE.Vector3(), ib = new THREE.Vector3(), ua = new THREE.Vector3(), ub = new THREE.Vector3();
        const side = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
        const emit = (pt: THREE.Vector3, inw: THREE.Vector3, upv: THREE.Vector3, k: number): void => {
            // three vertices across the strip: outer (dark), centre (lit), inner (dark)
            side.copy(inw);
            for (const [off, lum] of [[-hw, 0], [0, 1], [hw, 0]] as const) {
                q.copy(pt).addScaledVector(side, look.inset + off).addScaledVector(upv, LIFT);
                P.push(q.x, q.y, q.z);
                C.push(col.r * k * lum, col.g * k * lum, col.b * k * lum);
            }
        };
        for (const ch of chains) {
            // arc length along the chain
            const n = ch.pts.length / 3;
            const s: number[] = [0];
            for (let i = 1; i < n; i++) s.push(s[i - 1]! + Math.hypot(ch.pts[i * 3]! - ch.pts[i * 3 - 3]!, ch.pts[i * 3 + 1]! - ch.pts[i * 3 - 2]!, ch.pts[i * 3 + 2]! - ch.pts[i * 3 - 1]!));
            const total = s[n - 1]!;
            if (total < look.dash * 0.5) continue;
            const start = ((total % period) - look.gap) / 2;   // centre the pattern on the chain
            const at = (d: number, out: THREE.Vector3, inw: THREE.Vector3, upv: THREE.Vector3): void => {
                let i = 1;
                while (i < n - 1 && s[i]! < d) i++;
                const t = Math.min(1, Math.max(0, (d - s[i - 1]!) / Math.max(1e-6, s[i]! - s[i - 1]!)));
                a.fromArray(ch.pts, (i - 1) * 3); b.fromArray(ch.pts, i * 3);
                ia.fromArray(ch.inward, (i - 1) * 3); ib.fromArray(ch.inward, i * 3);
                ua.fromArray(ch.up, (i - 1) * 3); ub.fromArray(ch.up, i * 3);
                out.lerpVectors(a, b, t); inw.lerpVectors(ia, ib, t).normalize(); upv.lerpVectors(ua, ub, t).normalize();
            };
            const inw = new THREE.Vector3(), upv = new THREE.Vector3();
            for (let d0 = start; d0 < total; d0 += period) {
                const lo = Math.max(0, d0), hi = Math.min(total, d0 + look.dash);
                if (hi - lo < look.dash * 0.35) continue;
                // sample the dash at its chain vertices and every 0.3 m
                const cuts = new Set<number>([lo, hi]);
                for (let i = 0; i < n; i++) if (s[i]! > lo && s[i]! < hi) cuts.add(s[i]!);
                for (let d = lo + 0.3; d < hi; d += 0.3) cuts.add(d);
                const list = [...cuts].sort((x, y) => x - y);
                let prevBase = -1;
                for (const d of list) {
                    at(d, p, inw, upv);
                    const k = Math.min(1, (d - lo) / fadeLen, (hi - d) / fadeLen);
                    const base = P.length / 3;
                    emit(p, inw, upv, Math.max(0, k));
                    if (prevBase >= 0) {
                        for (const c of [0, 1]) {
                            const a0 = prevBase + c, a1 = prevBase + c + 1, b0 = base + c, b1 = base + c + 1;
                            I.push(a0, b0, a1, a1, b0, b1);
                        }
                    }
                    prevBase = base;
                }
            }
        }
        if (!I.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
        geo.setIndex(I);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, routeMaterial());
        mesh.name = `routeLights:${g.nodeName}`;
        mesh.renderOrder = 5;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        nodeFor(gi).add(mesh);
        out.push(mesh);
    });
    return out;
}
