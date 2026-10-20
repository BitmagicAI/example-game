import { Quat, Vec3, applyQuat, applyQuatInverse, clamp, smoothFactor } from './math3.js';
import { closestPointOnTriangle } from './collision.js';
import { evalPose, localToStage, type CollisionGroup, type CollisionMesh, type StageData, type StageItem } from './stageData.js';

/**
 * Trick or Roll ball physics, in the manner of the original arcade tilt-and-roll games:
 *
 *  - The STAGE tilts (driven by the stick, with a little lag). The ball lives in the stage's own
 *    frame, where gravity is simply the world's "down" rotated into that frame. No rigid-body
 *    engine, no spin dynamics: a sliding sphere with restitution and Coulomb-style friction
 *    against triangle collision.
 *  - Fixed 60 Hz, adaptively sub-stepped so a fast ball never tunnels through thin geometry.
 *  - Moving parts (spinning discs, sliding planks) are collision groups with a pose per time; the
 *    ball is carried by friction through the surface's velocity at the contact point.
 *
 * Everything is deterministic (no randomness, fixed steps), which is what lets tools/sim run
 * whole stages headlessly with a bot to prove they can be finished.
 */

export interface Tuning {
    radius: number;
    /** m/s^2. The original scales its world so the ball behaves like a small toy: ~3.6 g. */
    gravity: number;
    tiltMaxDeg: number;
    /** Seconds; tilt follows the stick through this exponential lag. */
    tiltTau: number;
    tiltRateDeg: number;
    /** Impacts slower than this (m/s) do not bounce. */
    restThreshold: number;
    maxSpeed: number;
    /** Max ball travel per sub-step (m). */
    subDist: number;
    maxSub: number;
    bumperBoost: number;
    bumperMinOut: number;
    candyPickup: number;
    wormholeCooldown: number;
    /** Extra drag on the ball while airborne (1/s), keeps launches from going ballistic-forever. */
    airDrag: number;
}

export const DEFAULT_TUNING: Tuning = {
    radius: 0.5,
    gravity: 35.28,
    tiltMaxDeg: 24,
    tiltTau: 0.07,
    tiltRateDeg: 260,
    restThreshold: 2.2,
    maxSpeed: 60,
    subDist: 0.16,
    maxSub: 24,
    bumperBoost: 1.35,
    bumperMinOut: 9,
    candyPickup: 0.95,
    wormholeCooldown: 0.9,
    airDrag: 0.05,
};

export type SimEvent =
    | { type: 'candy'; item: number; value: number; pos: Vec3 }
    | { type: 'goal'; item: number; tier: string }
    | { type: 'fall' }
    | { type: 'bump'; strength: number; pos: Vec3; normal: Vec3 }
    | { type: 'impact'; speed: number; pos: Vec3; normal: Vec3 }
    | { type: 'warp'; from: Vec3; to: Vec3 };

export interface GroupState {
    pos0: Vec3; quat0: Quat;
    pos1: Vec3; quat1: Quat;
    linVel: Vec3; angVel: Vec3;
}

interface Contact {
    depth: number;
    group: number;
    mesh: CollisionMesh | null;
    /** Contact normal in the GROUP frame (points from surface toward the ball). */
    nLocal: Vec3;
    /** Contact point in the group frame. */
    cp: Vec3;
    bumper: boolean;
}

const V = {
    a: new Vec3(), b: new Vec3(), c: new Vec3(), d: new Vec3(), e: new Vec3(),
    n: new Vec3(), vs: new Vec3(), vrel: new Vec3(), vt: new Vec3(), lp: new Vec3(), cp: new Vec3(), cpw: new Vec3(),
    gl: new Vec3(), up: new Vec3(0, 1, 0), tmpQ: new Quat(), tmpQ2: new Quat(), tmpQ3: new Quat(),
};

export class StageSim {
    readonly T: Tuning;
    readonly stage: StageData;

    /** Stage clock: drives animated groups; advances every step, including the intro (the movers are alive in the fly-through). */
    time = 0;
    /** While true the clock stands still: READY holds every mover at its start pose, so GO always begins from the same phase. */
    animHold = false;
    readonly p = new Vec3();
    readonly v = new Vec3();
    /** Ball roll orientation (stage frame). */
    readonly q = new Quat();
    private omega = new Vec3();
    grounded = false;
    groundNormal = new Vec3(0, 1, 0);
    airTime = 0;
    /** Speed of the most recent normal impact (m/s) and stage time it happened. */
    lastImpact = 0;
    lastImpactTime = -10;

    /** Tilt angles (rad): pitch > 0 = far edge down (ball rolls away from the camera). */
    tiltPitch = 0;
    tiltRoll = 0;
    /** Stage orientation in the world (about the pivot). Updated every step. */
    readonly stageQuat = new Quat();
    /** Camera heading (rad) used to interpret the stick this step. */
    heading = 0;

    readonly gstate: GroupState[];
    /** How many times a ball squeezed into geometry had to be lifted out (should stay 0 in normal play; tools/sim prints it). */
    rescues = 0;
    readonly collected = new Set<number>();
    readonly events: SimEvent[] = [];
    fallen = false;
    goalHit = false;
    private warpCooldown = 0;
    /** The portal the ball just came out of: it cannot fire again until the ball has left it (a slow ball used to ping-pong between the pair). */
    private warpLock: StageItem | null = null;
    private impactCooldown = 0;
    private readonly qbuf: number[] = [];
    private readonly contact: Contact = {
        depth: 0, group: 0, mesh: null, nLocal: new Vec3(), cp: new Vec3(), bumper: false,
    };
    readonly start: StageItem;
    readonly goals: StageItem[];
    readonly candies: StageItem[];
    readonly bumpers: StageItem[];
    readonly wormholes: StageItem[];
    private itemById = new Map<string, StageItem>();

    constructor(stage: StageData, tuning: Partial<Tuning> = {}) {
        this.stage = stage;
        this.T = { ...DEFAULT_TUNING, ...tuning };
        this.gstate = stage.groups.map(() => ({
            pos0: new Vec3(), quat0: new Quat(), pos1: new Vec3(), quat1: new Quat(), linVel: new Vec3(), angVel: new Vec3(),
        }));
        this.start = stage.items.find((i) => i.kind === 'start')!;
        this.goals = stage.items.filter((i) => i.kind === 'goal');
        this.candies = stage.items.filter((i) => i.kind === 'candy' || i.kind === 'bucket');
        this.bumpers = stage.items.filter((i) => i.kind === 'bumper');
        this.wormholes = stage.items.filter((i) => i.kind === 'wormhole');
        for (const it of stage.items) this.itemById.set(it.name, it);
        this.reset();
    }

    /** Back to the start pad, candies restored, stage clock and tilt zeroed. */
    /** Restart the stage clock at 0 and pose the movers there (call when READY begins; the camera cut hides the jump). */
    restartClock(): void {
        this.time = 0;
        this.poseAll(0, 0);
    }

    reset(): void {
        this.time = 0;
        this.animHold = false;
        this.collected.clear();
        this.events.length = 0;
        this.fallen = false;
        this.goalHit = false;
        this.tiltPitch = 0;
        this.tiltRoll = 0;
        this.warpCooldown = 0;
        this.warpLock = null;
        this.impactCooldown = 0;
        this.grounded = false;
        this.airTime = 0;
        this.p.copy(this.itemStagePos(this.start, V.a));
        this.v.set(0, 0, 0);
        this.omega.set(0, 0, 0);
        this.q.identity();
        this.poseAll(0, 0);
        this.updateStageQuat();
    }

    /** Position of an item in the stage frame at the current pose of its group. */
    itemStagePos(it: StageItem, out: Vec3): Vec3 {
        if (it.group <= 0) return out.copy(it.pos);
        const gs = this.gstate[it.group]!;
        return localToStage(gs.pos1, gs.quat1, it.pos, out);
    }

    /** World-frame gravity direction is fixed; this is it in the stage frame. */
    private gravityLocal(out: Vec3): Vec3 {
        V.d.set(0, -this.T.gravity, 0);
        return applyQuatInverse(this.stageQuat, V.d, out);
    }

    /** Pose every group at stage time t; h > 0 also derives the surface velocities over that interval. */
    private poseAll(t: number, h: number): void {
        for (let i = 0; i < this.stage.groups.length; i++) {
            const g = this.stage.groups[i]!;
            const gs = this.gstate[i]!;
            gs.pos0.copy(gs.pos1); gs.quat0.copy(gs.quat1);
            evalPose(g, t, gs.pos1, gs.quat1);
            if (h <= 0) {
                gs.pos0.copy(gs.pos1); gs.quat0.copy(gs.quat1);
                gs.linVel.set(0, 0, 0); gs.angVel.set(0, 0, 0);
                continue;
            }
            if (!g.anim) { gs.linVel.set(0, 0, 0); gs.angVel.set(0, 0, 0); continue; }
            gs.linVel.copy(gs.pos1).sub(gs.pos0).scale(1 / h);
            // dq = q1 * conj(q0): the rotation that took the group from its last pose to this one
            V.tmpQ.copy(gs.quat0).conjugate();
            V.tmpQ2.multiplyQuats(gs.quat1, V.tmpQ);
            if (V.tmpQ2.w < 0) V.tmpQ2.set(-V.tmpQ2.x, -V.tmpQ2.y, -V.tmpQ2.z, -V.tmpQ2.w);
            const s = Math.hypot(V.tmpQ2.x, V.tmpQ2.y, V.tmpQ2.z);
            if (s < 1e-9) gs.angVel.set(0, 0, 0);
            else {
                const ang = 2 * Math.atan2(s, V.tmpQ2.w);
                gs.angVel.set(V.tmpQ2.x / s, V.tmpQ2.y / s, V.tmpQ2.z / s).scale(ang / h);
            }
        }
    }

    private updateStageQuat(): void {
        const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
        // h = camera forward (sin, 0, cos); r = screen right = h x up = (-cos, 0, sin)
        V.tmpQ.setAxisAngle(-ch, 0, sh, -this.tiltPitch);   // pitch about r
        V.tmpQ2.setAxisAngle(sh, 0, ch, this.tiltRoll);    // roll about h
        this.stageQuat.multiplyQuats(V.tmpQ2, V.tmpQ).normalize();
    }

    /**
     * Ball centre in the world. The stage is drawn tilted about the BALL (the render pivot is the ball's own position), so the
     * ball never swings up and down with the tilt and the camera never ends up under a deck that tilted away, however far the
     * ball is from the stage origin. Physics is unaffected (it works in the stage frame).
     */
    worldBallPos(out: Vec3): Vec3 {
        return out.copy(this.p);
    }
    toWorld(local: Vec3, out: Vec3): Vec3 {
        V.e.copy(local).sub(this.p);
        applyQuat(this.stageQuat, V.e, out);
        return out.add(this.p);
    }
    /** Ball velocity in world axes (the stage is drawn tilted about the ball, so this is just the stage-frame velocity). */
    worldBallVel(out: Vec3): Vec3 {
        return out.copy(this.v);
    }

    /**
     * Advance one fixed step.
     * @param sx stick right (-1..1), sy stick forward (-1..1), both relative to the camera heading
     */
    step(dt: number, sx: number, sy: number, heading: number, controls = true): void {
        this.events.length = 0;
        this.heading = heading;
        // ---- tilt (stick -> target angle -> lagged, rate-limited follow)
        const max = this.T.tiltMaxDeg * (Math.PI / 180);
        let tx = controls ? sx : 0, ty = controls ? sy : 0;
        const m = Math.hypot(tx, ty);
        if (m > 1) { tx /= m; ty /= m; }
        const k = smoothFactor(dt, this.T.tiltTau);
        const rate = this.T.tiltRateDeg * (Math.PI / 180) * dt;
        this.tiltPitch += clamp((ty * max - this.tiltPitch) * k, -rate, rate);
        this.tiltRoll += clamp((tx * max - this.tiltRoll) * k, -rate, rate);
        this.updateStageQuat();

        this.gravityLocal(V.gl);

        // ---- sub-steps
        const speed = this.v.length();
        const n = clamp(Math.ceil((speed * dt) / this.T.subDist), 1, this.T.maxSub);
        const h = dt / n;
        for (let s = 0; s < n; s++) {
            if (!this.animHold) this.time += h;
            this.poseAll(this.time, h);
            this.v.addScaled(V.gl, h);
            if (!this.grounded) this.v.scale(1 - this.T.airDrag * h);
            // after the goal the ball settles (the original catches it in the goal area)
            if (this.goalHit) this.v.scale(Math.exp(-2.4 * h));
            const sp = this.v.length();
            if (sp > this.T.maxSpeed) this.v.scale(this.T.maxSpeed / sp);
            this.p.addScaled(this.v, h);
            this.grounded = false;
            this.solveContacts(h);
            this.integrateRoll(h);
            this.triggers(h);
        }
        this.airTime = this.grounded ? 0 : this.airTime + dt;
        if (this.impactCooldown > 0) this.impactCooldown -= dt;
        if (this.warpCooldown > 0) this.warpCooldown -= dt;
    }

    private integrateRoll(h: number): void {
        const w = this.omega.length();
        if (w < 1e-6) return;
        const a = w * h;
        V.tmpQ3.setAxisAngle(this.omega.x / w, this.omega.y / w, this.omega.z / w, a);
        this.q.premultiply(V.tmpQ3).normalize();
        if (!this.grounded) this.omega.scale(1 - 0.4 * h);
    }

    // ------------------------------------------------------------------ collision

    private solveContacts(h: number): void {
        const r = this.T.radius;
        const stage = this.stage;
        const c = this.contact;
        for (let pass = 0; pass < 6; pass++) {
            let bestDepth = 0.0002;
            let found = false;
            // triangle meshes
            for (let gi = 0; gi < stage.groups.length; gi++) {
                const g = stage.groups[gi]!;
                const gs = this.gstate[gi]!;
                V.a.set(this.p.x - gs.pos1.x, this.p.y - gs.pos1.y, this.p.z - gs.pos1.z);
                const lp = applyQuatInverse(gs.quat1, V.a, V.lp);
                if (lp.x < g.min.x - r || lp.x > g.max.x + r || lp.y < g.min.y - r || lp.y > g.max.y + r || lp.z < g.min.z - r || lp.z > g.max.z + r) continue;
                for (const mesh of g.meshes) {
                    const nq = mesh.grid.query(lp.x, lp.y, lp.z, r, this.qbuf);
                    const tris = mesh.tris;
                    for (let k = 0; k < nq; k++) {
                        const o = this.qbuf[k]! * 9;
                        closestPointOnTriangle(
                            lp.x, lp.y, lp.z,
                            tris[o]!, tris[o + 1]!, tris[o + 2]!, tris[o + 3]!, tris[o + 4]!, tris[o + 5]!, tris[o + 6]!, tris[o + 7]!, tris[o + 8]!,
                            V.cp,
                        );
                        const dx = lp.x - V.cp.x, dy = lp.y - V.cp.y, dz = lp.z - V.cp.z;
                        const d2 = dx * dx + dy * dy + dz * dz;
                        if (d2 >= r * r) continue;
                        const d = Math.sqrt(d2);
                        const depth = r - d;
                        if (depth <= bestDepth) continue;
                        bestDepth = depth;
                        found = true;
                        c.depth = depth; c.group = gi; c.mesh = mesh; c.bumper = false;
                        c.cp.copy(V.cp);
                        if (d > 1e-6) c.nLocal.set(dx / d, dy / d, dz / d);
                        else {
                            // centre exactly on the triangle: use the face normal, oriented against the ball's motion
                            V.b.set(tris[o + 3]! - tris[o]!, tris[o + 4]! - tris[o + 1]!, tris[o + 5]! - tris[o + 2]!);
                            V.c.set(tris[o + 6]! - tris[o]!, tris[o + 7]! - tris[o + 1]!, tris[o + 8]! - tris[o + 2]!);
                            c.nLocal.cross(V.b, V.c).normalize();
                            if (c.nLocal.dot(this.v) > 0) c.nLocal.scale(-1);
                        }
                    }
                }
            }
            // bumpers (vertical cylinders)
            for (const b of this.bumpers) {
                const gi = Math.max(0, b.group);
                const gs = this.gstate[gi]!;
                V.a.set(this.p.x - gs.pos1.x, this.p.y - gs.pos1.y, this.p.z - gs.pos1.z);
                const lp = applyQuatInverse(gs.quat1, V.a, V.lp);
                const R = Number(b.extras.radius ?? 1);
                const H = Number(b.extras.height ?? 0.9);
                const dx = lp.x - b.pos.x, dz = lp.z - b.pos.z;
                const dist = Math.hypot(dx, dz);
                const inv = dist > 1e-6 ? 1 / dist : 0;
                const rr = Math.min(dist, R);
                V.cp.set(b.pos.x + dx * inv * rr, clamp(lp.y, b.pos.y, b.pos.y + H), b.pos.z + dz * inv * rr);
                const ex = lp.x - V.cp.x, ey = lp.y - V.cp.y, ez = lp.z - V.cp.z;
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 >= r * r) continue;
                const d = Math.sqrt(d2);
                const depth = r - d;
                if (depth <= bestDepth) continue;
                bestDepth = depth; found = true;
                c.depth = depth; c.group = gi; c.mesh = null; c.bumper = true;
                c.cp.copy(V.cp);
                if (d > 1e-6) c.nLocal.set(ex / d, ey / d, ez / d);
                else c.nLocal.set(dx * inv, dist > 1e-6 ? 0 : 1, dz * inv);
            }
            if (!found) break;
            this.resolve(c, h);
            // squeezed for good (a deck docking against a dock while the ball is in the gap): 6 passes could not push it out
            if (pass === 5 && bestDepth > 0.2) this.popOut();
        }
    }

    /** Deepest overlap of the ball with any solid at its current position (no side effects). */
    private deepestOverlap(): number {
        const r = this.T.radius;
        let best = 0;
        for (let gi = 0; gi < this.stage.groups.length; gi++) {
            const g = this.stage.groups[gi]!;
            const gs = this.gstate[gi]!;
            V.a.set(this.p.x - gs.pos1.x, this.p.y - gs.pos1.y, this.p.z - gs.pos1.z);
            const lp = applyQuatInverse(gs.quat1, V.a, V.lp);
            if (lp.x < g.min.x - r || lp.x > g.max.x + r || lp.y < g.min.y - r || lp.y > g.max.y + r || lp.z < g.min.z - r || lp.z > g.max.z + r) continue;
            for (const mesh of g.meshes) {
                const nq = mesh.grid.query(lp.x, lp.y, lp.z, r, this.qbuf);
                const tris = mesh.tris;
                for (let k = 0; k < nq; k++) {
                    const o = this.qbuf[k]! * 9;
                    closestPointOnTriangle(lp.x, lp.y, lp.z, tris[o]!, tris[o + 1]!, tris[o + 2]!, tris[o + 3]!, tris[o + 4]!, tris[o + 5]!, tris[o + 6]!, tris[o + 7]!, tris[o + 8]!, V.cp);
                    const d = Math.hypot(lp.x - V.cp.x, lp.y - V.cp.y, lp.z - V.cp.z);
                    if (r - d > best) best = r - d;
                }
            }
        }
        return best;
    }

    /** Rescue a ball embedded in geometry it cannot be pushed out of sideways: lift it straight up until it is free. */
    private popOut(): void {
        for (let k = 0; k < 12; k++) {
            this.p.y += 0.25;
            if (this.deepestOverlap() < 0.02) break;
        }
        if (this.v.y < 0) this.v.y = 0;
        this.rescues++;
    }

    private resolve(c: Contact, h: number): void {
        const gs = this.gstate[c.group]!;
        const n = applyQuat(gs.quat1, c.nLocal, V.n).normalize();
        this.p.addScaled(n, c.depth);
        // surface velocity at the contact point
        localToStage(gs.pos1, gs.quat1, c.cp, V.cpw);
        V.d.copy(V.cpw).sub(gs.pos1);
        V.vs.cross(gs.angVel, V.d).add(gs.linVel);
        if (c.mesh?.surface.conveyor) {
            const cv = c.mesh.surface.conveyor;
            V.d.set(cv[0], cv[1], cv[2]);
            applyQuat(gs.quat1, V.d, V.d);
            V.vs.add(V.d);
        }
        V.vrel.copy(this.v).sub(V.vs);
        const vn = V.vrel.dot(n);
        if (vn < 0) {
            const impact = -vn;
            if (c.bumper) {
                const out = Math.max(impact * this.T.bumperBoost, this.T.bumperMinOut);
                V.vrel.addScaled(n, out - vn);
                this.v.copy(V.vs).add(V.vrel);
                this.events.push({ type: 'bump', strength: out, pos: this.p.clone(), normal: n.clone() });
                this.omega.set(0, 0, 0);
                return;
            }
            const surf = c.mesh!.surface;
            const e = impact > this.T.restThreshold ? surf.restitution : 0;
            const dvn = impact * (1 + e);
            V.vrel.addScaled(n, dvn);
            // tangential friction, bounded by mu * normal impulse
            const vd = V.vrel.dot(n);
            V.vt.copy(V.vrel).addScaled(n, -vd);
            const st = V.vt.length();
            const maxF = surf.friction * dvn;
            if (st <= maxF) V.vrel.copy(n).scale(vd);
            else V.vrel.addScaled(V.vt, -maxF / st);
            this.v.copy(V.vs).add(V.vrel);
            if (impact > 2.5 && this.impactCooldown <= 0) {
                this.impactCooldown = 0.12;
                this.lastImpact = impact;
                this.lastImpactTime = this.time;
                // report in stage frame
                this.events.push({ type: 'impact', speed: impact, pos: this.p.clone().addScaled(n, -this.T.radius), normal: n.clone() });
            }
        }
        // ground classification is in the WORLD-independent stage frame: up is +Y of the stage
        if (n.y > 0.4) {
            this.grounded = true;
            this.groundNormal.copy(n);
        }
        // rolling without slipping, relative to the surface
        V.vt.copy(this.v).sub(V.vs);
        V.vt.addScaled(n, -V.vt.dot(n));
        this.omega.cross(n, V.vt).scale(1 / this.T.radius);
    }

    // ------------------------------------------------------------------ triggers

    private triggers(h: number): void {
        const st = this.stage;
        // candies can still be collected while the goal celebration rolls on; nothing else
        if (this.fallen) return;
        // candy
        for (const it of this.candies) {
            if (this.collected.has(it.id)) continue;
            this.itemStagePos(it, V.b);
            const dx = V.b.x - this.p.x, dy = V.b.y - this.p.y, dz = V.b.z - this.p.z;
            const R = this.T.candyPickup * (it.kind === 'bucket' ? 1.25 : 1);
            if (dx * dx + dy * dy + dz * dz < R * R) {
                this.collected.add(it.id);
                this.events.push({ type: 'candy', item: it.id, value: it.kind === 'bucket' ? 10 : 1, pos: V.b.clone() });
            }
        }
        // goal
        if (!this.goalHit) {
            for (const gl of this.goals) {
                V.a.set(this.p.x - gl.pos.x, this.p.y - gl.pos.y, this.p.z - gl.pos.z);
                const lp = applyQuatInverse(gl.quat, V.a, V.lp);
                const w = Number(gl.extras.w ?? 3), hh = Number(gl.extras.h ?? 3), d = Number(gl.extras.d ?? 1.6);
                if (Math.abs(lp.x) < w / 2 && lp.y > -0.6 && lp.y < hh && Math.abs(lp.z) < d / 2) {
                    this.goalHit = true;
                    this.events.push({ type: 'goal', item: gl.id, tier: String(gl.extras.tier ?? 'blue') });
                    break;
                }
            }
        }
        // wormholes
        if (this.warpLock) {
            this.itemStagePos(this.warpLock, V.b);
            const RL = Number(this.warpLock.extras.radius ?? 1.1) + 0.3;
            const lx = V.b.x - this.p.x, ly = V.b.y - this.p.y, lz = V.b.z - this.p.z;
            if (lx * lx + ly * ly + lz * lz > RL * RL) this.warpLock = null;
        }
        if (this.warpCooldown <= 0 && !this.goalHit) {
            for (const w of this.wormholes) {
                if (w === this.warpLock) continue;
                this.itemStagePos(w, V.b);
                const R = Number(w.extras.radius ?? 1.1);
                const dx = V.b.x - this.p.x, dy = V.b.y - this.p.y, dz = V.b.z - this.p.z;
                if (dx * dx + dy * dy + dz * dz < R * R) {
                    const tgt = this.itemById.get(String(w.extras.target ?? ''));
                    if (!tgt) continue;
                    const from = this.p.clone();
                    this.itemStagePos(tgt, this.p);
                    this.warpCooldown = this.T.wormholeCooldown;
                    this.warpLock = tgt;
                    // keep speed, turn it to leave the exit along its facing
                    const sp = this.v.length();
                    V.a.set(0, 0, 1);
                    applyQuat(tgt.quat, V.a, V.c);
                    if (w.extras.exit !== false) this.v.set(V.c.x * sp, Math.min(this.v.y, 0), V.c.z * sp);
                    this.events.push({ type: 'warp', from, to: this.p.clone() });
                    break;
                }
            }
        }
        // out of the world
        if (this.p.y < st.fallY && !this.goalHit) {
            this.fallen = true;
            this.events.push({ type: 'fall' });
        }
    }
}
