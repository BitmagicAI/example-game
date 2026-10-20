/**
 * Minimal mutable 3D math for the Trick or Roll simulation core.
 *
 * Pure TypeScript, no three.js / engine imports: the sim also runs in Node for the
 * automated stage tests (tools/sim). Conventions match glTF / the engine: metres, +Y up,
 * right-handed, quaternions are (x, y, z, w). Hot paths mutate in place and take an `out`
 * parameter so a 60 Hz sim with sub-steps does not allocate.
 */

export class Vec3 {
    constructor(public x = 0, public y = 0, public z = 0) {}
    set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
    copy(v: Vec3): this { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    clone(): Vec3 { return new Vec3(this.x, this.y, this.z); }
    add(v: Vec3): this { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v: Vec3): this { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    scale(s: number): this { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaled(v: Vec3, s: number): this { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    dot(v: Vec3): number { return this.x * v.x + this.y * v.y + this.z * v.z; }
    lengthSq(): number { return this.x * this.x + this.y * this.y + this.z * this.z; }
    length(): number { return Math.sqrt(this.lengthSq()); }
    normalize(): this {
        const l = this.length();
        if (l > 1e-12) this.scale(1 / l); else this.set(0, 1, 0);
        return this;
    }
    cross(a: Vec3, b: Vec3): this {
        const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
        this.x = x; this.y = y; this.z = z; return this;
    }
    lerp(v: Vec3, t: number): this {
        this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this;
    }
    distanceTo(v: Vec3): number { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    toArray(): [number, number, number] { return [this.x, this.y, this.z]; }
}

export class Quat {
    constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
    set(x: number, y: number, z: number, w: number): this { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
    copy(q: Quat): this { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
    clone(): Quat { return new Quat(this.x, this.y, this.z, this.w); }
    identity(): this { return this.set(0, 0, 0, 1); }
    /** axis must be unit length. */
    setAxisAngle(ax: number, ay: number, az: number, angle: number): this {
        const s = Math.sin(angle / 2);
        return this.set(ax * s, ay * s, az * s, Math.cos(angle / 2));
    }
    /** this = a * b  (apply b first, then a). Safe if `this` aliases a or b. */
    multiplyQuats(a: Quat, b: Quat): this {
        const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
        const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
        const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
        const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
        return this.set(x, y, z, w);
    }
    premultiply(q: Quat): this { return this.multiplyQuats(q, this); }
    multiply(q: Quat): this { return this.multiplyQuats(this, q); }
    conjugate(): this { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
    normalize(): this {
        const l = Math.hypot(this.x, this.y, this.z, this.w) || 1;
        return this.set(this.x / l, this.y / l, this.z / l, this.w / l);
    }
    slerp(b: Quat, t: number): this {
        let cos = this.x * b.x + this.y * b.y + this.z * b.z + this.w * b.w;
        let bx = b.x, by = b.y, bz = b.z, bw = b.w;
        if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
        let s0: number, s1: number;
        if (cos > 0.9995) { s0 = 1 - t; s1 = t; }
        else {
            const th = Math.acos(cos), sn = Math.sin(th);
            s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn;
        }
        return this.set(this.x * s0 + bx * s1, this.y * s0 + by * s1, this.z * s0 + bz * s1, this.w * s0 + bw * s1).normalize();
    }
}

/** out = q * v */
export function applyQuat(q: Quat, v: Vec3, out: Vec3): Vec3 {
    const { x, y, z, w } = q;
    // t = 2 * cross(q.xyz, v)
    const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
    out.x = v.x + w * tx + (y * tz - z * ty);
    out.y = v.y + w * ty + (z * tx - x * tz);
    out.z = v.z + w * tz + (x * ty - y * tx);
    return out;
}

/** out = q^-1 * v (q must be unit length). */
export function applyQuatInverse(q: Quat, v: Vec3, out: Vec3): Vec3 {
    const { x, y, z, w } = q;
    const nx = -x, ny = -y, nz = -z;
    const tx = 2 * (ny * v.z - nz * v.y), ty = 2 * (nz * v.x - nx * v.z), tz = 2 * (nx * v.y - ny * v.x);
    out.x = v.x + w * tx + (ny * tz - nz * ty);
    out.y = v.y + w * ty + (nz * tx - nx * tz);
    out.z = v.z + w * tz + (nx * ty - ny * tx);
    return out;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const wrapAngle = (a: number): number => {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
};
/** Frame-rate independent exponential smoothing factor for time constant tau (seconds). */
export const smoothFactor = (dt: number, tau: number): number => 1 - Math.exp(-dt / Math.max(1e-6, tau));

/** Deterministic PRNG (mulberry32) for anything that must repeat between runs. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
