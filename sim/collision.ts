import { Vec3 } from './math3.js';

/**
 * Triangle collision helpers for the ball: a uniform spatial grid over a triangle soup and the
 * closest-point-on-triangle test (Ericson, Real-Time Collision Detection 5.1.5).
 */

/** Uniform grid over triangle AABBs; query returns every triangle whose cell touches a sphere. */
export class TriGrid {
    private cells = new Map<number, number[]>();
    private stamp: Int32Array;
    private stampId = 0;
    constructor(private tris: Float32Array, private triCount: number, private cell = 2) {
        this.stamp = new Int32Array(triCount);
        for (let i = 0; i < triCount; i++) {
            const o = i * 9;
            let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            for (let k = 0; k < 3; k++) {
                const x = tris[o + k * 3]!, y = tris[o + k * 3 + 1]!, z = tris[o + k * 3 + 2]!;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            const x0 = this.ci(minX), x1 = this.ci(maxX), y0 = this.ci(minY), y1 = this.ci(maxY), z0 = this.ci(minZ), z1 = this.ci(maxZ);
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
                const key = TriGrid.key(x, y, z);
                let list = this.cells.get(key);
                if (!list) { list = []; this.cells.set(key, list); }
                list.push(i);
            }
        }
    }
    private ci(v: number): number { return Math.floor(v / this.cell); }
    private static key(x: number, y: number, z: number): number {
        return ((x + 512) << 20) | ((y + 512) << 10) | (z + 512);
    }
    /** Fills `out` with unique triangle indices; returns the count. */
    query(cx: number, cy: number, cz: number, r: number, out: number[]): number {
        this.stampId++;
        let n = 0;
        const x0 = this.ci(cx - r), x1 = this.ci(cx + r), y0 = this.ci(cy - r), y1 = this.ci(cy + r), z0 = this.ci(cz - r), z1 = this.ci(cz + r);
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
            const list = this.cells.get(TriGrid.key(x, y, z));
            if (!list) continue;
            for (let i = 0; i < list.length; i++) {
                const t = list[i]!;
                if (this.stamp[t] === this.stampId) continue;
                this.stamp[t] = this.stampId;
                out[n++] = t;
            }
        }
        return n;
    }
}

/** Closest point on triangle (a,b,c) to p, written to `out`. Returns nothing; `out` is the point. */
export function closestPointOnTriangle(
    px: number, py: number, pz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    out: Vec3,
): void {
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) { out.set(ax, ay, az); return; }
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { out.set(bx, by, bz); return; }
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        out.set(ax + abx * v, ay + aby * v, az + abz * v); return;
    }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) { out.set(cx, cy, cz); return; }
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / (d2 - d6);
        out.set(ax + acx * w, ay + acy * w, az + acz * w); return;
    }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        out.set(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w); return;
    }
    const denom = 1 / (va + vb + vc);
    const v = vb * denom, w = vc * denom;
    out.set(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}
