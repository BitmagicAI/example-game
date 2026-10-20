import * as THREE from 'three';
import type { StageSim } from '../sim/physics.js';
import type { GroundLook } from './looks.js';

/**
 * The ball's contact on the ground, for looks with `ground` (looks.ts): a soft dark disc that says where the ball is (and, in the air, where it
 * will land) and a faint light pool from the glass. Both lie on the highest floor below the ball, found in the sim's own collision triangles
 * (static stage and moving decks alike), shrink and fade with height, and are hidden without a look.
 *
 * Lives under the ball's root (stage space, never rotated), so it follows the ball from stage to stage.
 */

const BALL_R = 0.5;
const UP_MIN = 0.6;

let radial: THREE.DataTexture | null = null;
/** 64x64 white disc whose alpha falls off smoothly from the centre (no canvas: works wherever three runs). */
function radialTexture(): THREE.DataTexture {
    if (radial) return radial;
    const n = 64, d = new Uint8Array(n * n * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
        const a = r >= 1 ? 0 : Math.pow(1 - r * r, 1.6);
        const o = (y * n + x) * 4;
        d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.round(a * 255);
    }
    radial = new THREE.DataTexture(d, n, n, THREE.RGBAFormat);
    radial.magFilter = radial.minFilter = THREE.LinearFilter;
    radial.needsUpdate = true;
    return radial;
}

const _q = new THREE.Quaternion();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class BallGround {
    readonly root = new THREE.Group();
    private readonly shadow: THREE.Mesh;
    private readonly pool: THREE.Mesh;
    private readonly shadowMat: THREE.MeshBasicMaterial;
    private readonly poolMat: THREE.MeshBasicMaterial;
    private look: GroundLook | null = null;
    private scratch: number[] = [];

    constructor() {
        this.root.name = 'BallGround';
        const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
        this.shadowMat = new THREE.MeshBasicMaterial({ color: 0x0b0714, map: radialTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        this.poolMat = new THREE.MeshBasicMaterial({ color: 0x9fe3c4, map: radialTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
        this.shadow = new THREE.Mesh(geo, this.shadowMat);
        this.pool = new THREE.Mesh(geo, this.poolMat);
        this.shadow.renderOrder = 0;
        this.pool.renderOrder = 4;
        for (const m of [this.shadow, this.pool]) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; this.root.add(m); }
        this.root.visible = false;
    }

    setLook(look: GroundLook | null): void {
        this.look = look;
        this.root.visible = !!look;
        if (look) this.poolMat.color.set(look.pool);
    }

    /** Highest floor point below the ball (stage space) into `out` with its normal into `_n`; false when there is none within 8 m. */
    private probe(sim: StageSim, out: THREE.Vector3): boolean {
        const p = sim.p;
        let best = -Infinity;
        sim.stage.groups.forEach((g, gi) => {
            // the ball in the group's own frame (movers: inverse of their current pose)
            let lx = p.x, ly = p.y, lz = p.z;
            let gq: THREE.Quaternion | null = null;
            if (gi > 0) {
                const gs = sim.gstate[gi]!;
                gq = new THREE.Quaternion(gs.quat1.x, gs.quat1.y, gs.quat1.z, gs.quat1.w);
                _p.set(p.x - gs.pos1.x, p.y - gs.pos1.y, p.z - gs.pos1.z).applyQuaternion(_q.copy(gq).invert());
                lx = _p.x; ly = _p.y; lz = _p.z;
            }
            for (const m of g.meshes) {
                const cnt = m.grid.query(lx, ly - 4, lz, 4.2, this.scratch);
                const t = m.tris;
                for (let k = 0; k < cnt; k++) {
                    const o = this.scratch[k]! * 9;
                    const x0 = t[o]!, y0 = t[o + 1]!, z0 = t[o + 2]!, x1 = t[o + 3]!, y1 = t[o + 4]!, z1 = t[o + 5]!, x2 = t[o + 6]!, y2 = t[o + 7]!, z2 = t[o + 8]!;
                    const d = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
                    if (Math.abs(d) < 1e-9) continue;
                    const a = ((z1 - z2) * (lx - x2) + (x2 - x1) * (lz - z2)) / d;
                    const b = ((z2 - z0) * (lx - x2) + (x0 - x2) * (lz - z2)) / d;
                    const c = 1 - a - b;
                    if (a < 0 || b < 0 || c < 0) continue;
                    const y = a * y0 + b * y1 + c * y2;
                    if (y > ly + 0.05) continue;
                    // normal, facing up
                    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0, vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
                    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                    const nl = Math.hypot(nx, ny, nz);
                    if (nl < 1e-9) continue;
                    nx /= nl; ny /= nl; nz /= nl;
                    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
                    if (ny < UP_MIN) continue;
                    // back to stage space to compare heights across groups
                    _p.set(lx, y, lz);
                    if (gq) { _p.applyQuaternion(gq); const gs = sim.gstate[gi]!; _p.x += gs.pos1.x; _p.y += gs.pos1.y; _p.z += gs.pos1.z; }
                    if (_p.y > best) {
                        best = _p.y;
                        out.copy(_p);
                        _n.set(nx, ny, nz);
                        if (gq) _n.applyQuaternion(gq);
                    }
                }
            }
        });
        return best > -Infinity && p.y - best < 8;
    }

    update(sim: StageSim): void {
        const look = this.look;
        if (!look) return;
        const hit = new THREE.Vector3();
        if (!this.probe(sim, hit)) { this.shadow.visible = this.pool.visible = false; return; }
        const h = Math.max(0, sim.p.y - BALL_R - hit.y);
        _q.setFromUnitVectors(UP, _n);
        for (const m of [this.shadow, this.pool]) {
            m.visible = true;
            m.position.set(hit.x - sim.p.x, hit.y - sim.p.y + 0.015, hit.z - sim.p.z);
            m.quaternion.copy(_q);
        }
        const s = 0.8 * (1 + h * 0.15);
        this.shadow.scale.setScalar(s);
        this.shadowMat.opacity = look.shadow * Math.max(0, 1 - h / 7);
        this.pool.scale.setScalar(1.7);
        const k = look.poolStrength * Math.max(0, 1 - h / 2.5);
        this.poolMat.color.set(look.pool).multiplyScalar(k);
        this.pool.visible = k > 0.002;
    }
}
