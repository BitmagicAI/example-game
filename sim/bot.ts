import { Quat, Vec3, clamp } from './math3.js';
import type { StageSim } from './physics.js';
import { evalPose, localToStage } from './stageData.js';

/**
 * Route-following bot: a stand-in for a competent-but-not-perfect player. It reads the stage's
 * `route` (waypoints authored in Blender) and tilts the stage toward a lookahead point with a
 * speed target. Used by tools/sim (headless stage tests) and the in-browser debug autoplay, so
 * both drive the very same code.
 */
export interface BotOptions {
    vmax: number;
    look: number;
    kp: number;
    /** 0..1 amount of random stick error (a sloppy player). */
    noise: number;
    seed: number;
}

/**
 * The bot holds at route point `seg` until moving group `group`'s pose is within `radius` of `at` (a ferry deck arriving).
 * mode 'sweep' is for a rotating bar (`length` m x `thick` m along the group's local X, as kit.sweeper builds it) that crosses
 * the route: hold at `seg` until the next `ahead` metres of route can be run without meeting the bar (a player watching the gap).
 */
export interface WaitSpec {
    seg: number; group: string; at: [number, number, number]; radius: number;
    mode?: 'near' | 'sweep'; length?: number; thick?: number; ahead?: number;
    /** 'sweep' waits: bar angles (degrees) around the hub for a cross or star; default a single bar along local X. */
    bars?: number[];
    /** 'near' waits: only release when the deck will STILL be within `radius` this many seconds from now (it is docked, not leaving). */
    dwell?: number;
}

export const DEFAULT_BOT: BotOptions = { vmax: 9, look: 4.5, kp: 3.2, noise: 0, seed: 12345 };

export class RouteBot {
    readonly route: Vec3[];
    /** Optional per-waypoint target speeds (m/s at the steady profile, 4th number of a route point). */
    private speeds: (number | undefined)[];
    private seg = 0;
    private o: BotOptions;
    private rand: number;
    private target = new Vec3();

    private waits: WaitSpec[];
    private released = new Set<WaitSpec>();
    private gp = new Vec3(); private gq = new Quat(); private loc = new Vec3(); private e1 = new Vec3(); private e2 = new Vec3();

    constructor(route: number[][], opts: Partial<BotOptions> = {}, waits: WaitSpec[] = []) {
        this.waits = waits;
        this.route = route.map((p) => new Vec3(p[0]!, p[1]!, p[2]!));
        this.speeds = route.map((p) => (p.length > 3 ? p[3] : undefined));
        this.o = { ...DEFAULT_BOT, ...opts };
        this.rand = this.o.seed;
    }

    reset(): void { this.seg = 0; this.rand = this.o.seed; this.released.clear(); }

    private rnd(): number {
        this.rand = (Math.imul(this.rand, 1664525) + 1013904223) >>> 0;
        return this.rand / 4294967296 - 0.5;
    }

    /**
     * Would sweeper `w` meet the ball if it ran the route from point `w.seg` for `w.ahead` metres, reaching that point in `t0` s
     * and travelling at `v` m/s? The bar is a capsule (ball radius + a safety margin) sampled a little before/after each arrival time.
     */
    private sweepClear(sim: StageSim, w: WaitSpec, dHold: number, v0: number, vT: number): boolean {
        const g = sim.stage.groups.find((x) => x.id === w.group);
        if (!g) return true;
        const half = (w.length ?? 8) / 2;
        const rad = (w.thick ?? 0.55) / 2 + 0.5 + 0.3;
        // arrival time after d metres from speed v0, accelerating (about 9 m/s^2 in practice) toward the cruise speed vT
        const acc = 9, dRamp = Math.max(0, (vT * vT - v0 * v0) / (2 * acc));
        const arrive = (d: number): number => {
            if (d <= dRamp) return (-v0 + Math.sqrt(v0 * v0 + 2 * acc * d)) / acc;
            return Math.max(0, (vT - v0) / acc) + (d - dRamp) / Math.max(vT, 0.1);
        };
        const r = this.route;
        let i = Math.min(w.seg, r.length - 2);
        let a = r[i]!, b = r[i + 1]!, segLen = Math.hypot(b.x - a.x, b.z - a.z), into = 0;
        const step = 0.7, ahead = w.ahead ?? 10;
        for (let s = 0; s <= ahead; s += step, into += step) {
            while (into > segLen && i < r.length - 2) {
                into -= segLen; i++; a = r[i]!; b = r[i + 1]!; segLen = Math.hypot(b.x - a.x, b.z - a.z);
            }
            const u = segLen > 1e-6 ? Math.min(1, into / segLen) : 0;
            const px = a.x + (b.x - a.x) * u, pz = a.z + (b.z - a.z) * u;
            const ta = sim.time + arrive(dHold + s);
            for (const dt of [-0.25, 0, 0.25]) {
                evalPose(g, ta + dt, this.gp, this.gq);
                for (const deg of w.bars ?? [0]) {
                    const ar = (deg * Math.PI) / 180, cx = Math.cos(ar) * half, cz = -Math.sin(ar) * half;   // a bar rotated `deg` about the hub (yaw)
                    localToStage(this.gp, this.gq, this.loc.set(cx, 0, cz), this.e1);
                    localToStage(this.gp, this.gq, this.loc.set(-cx, 0, -cz), this.e2);
                    const dx = this.e2.x - this.e1.x, dz = this.e2.z - this.e1.z, l2 = dx * dx + dz * dz || 1;
                    const k = clamp(((px - this.e1.x) * dx + (pz - this.e1.z) * dz) / l2, 0, 1);
                    if (Math.hypot(px - (this.e1.x + dx * k), pz - (this.e1.z + dz * k)) < rad) return false;
                }
            }
        }
        return true;
    }

    /** Stick (x right, y forward) for the given camera heading. */
    stick(sim: StageSim, heading: number, out: { x: number; y: number }): void {
        const r = this.route;
        const p = sim.p, v = sim.v;
        while (this.seg < r.length - 2) {
            const a = r[this.seg]!, b = r[this.seg + 1]!;
            const abx = b.x - a.x, abz = b.z - a.z, l2 = abx * abx + abz * abz || 1;
            if (((p.x - a.x) * abx + (p.z - a.z) * abz) / l2 > 1) this.seg++; else break;
        }
        // lookahead point along the route
        let remain = this.o.look, i = this.seg;
        const a0 = r[i]!, b0 = r[i + 1]!;
        const abx0 = b0.x - a0.x, abz0 = b0.z - a0.z, L0 = Math.hypot(abx0, abz0) || 1;
        const u0 = clamp(((p.x - a0.x) * abx0 + (p.z - a0.z) * abz0) / (L0 * L0), 0, 1);
        let px = a0.x + abx0 * u0, pz = a0.z + abz0 * u0;
        let left = L0 * (1 - u0);
        while (remain > left && i < r.length - 2) {
            remain -= left; i++;
            const a2 = r[i]!, b2 = r[i + 1]!;
            px = a2.x; pz = a2.z;
            left = Math.hypot(b2.x - a2.x, b2.z - a2.z);
        }
        const a3 = r[i]!, b3 = r[i + 1]!;
        const l3 = Math.hypot(b3.x - a3.x, b3.z - a3.z) || 1;
        const k = Math.min(remain, left) / l3;
        this.target.set(px + (b3.x - a3.x) * k, 0, pz + (b3.z - a3.z) * k);
        const end = r[r.length - 1]!;
        const goalDist = Math.hypot(end.x - p.x, end.z - p.z);
        // a route point can ask for a specific speed (a run-up before a jump); profiles scale it by vmax/9
        const hint = this.speeds[Math.min(i + 1, this.speeds.length - 1)];
        const cruise = hint !== undefined ? hint * (this.o.vmax / 9) : this.o.vmax;
        let vwant = hint !== undefined ? cruise : Math.min(cruise, 2 + goalDist * 0.9);   // an explicit speed hint (a jump landing by the gate) wins over the slow-down near the goal
        // ferry decks: stop at the edge until the deck arrives, then go; sweepers: wait for a gap in the bar
        for (const w of this.waits) {
            if (this.released.has(w)) continue;
            const hp = r[Math.min(w.seg, r.length - 1)]!;
            const dHold = Math.hypot(hp.x - p.x, hp.z - p.z);
            if (this.seg < w.seg - (w.mode === 'sweep' ? 6 : 1) || dHold > (w.mode === 'sweep' ? 14 : 9)) continue;
            if (w.mode === 'sweep') {
                if (this.seg >= w.seg) { this.released.add(w); continue; }   // past the hold point: committed
                if (this.sweepClear(sim, w, dHold, Math.hypot(v.x, v.z), Math.max(3, cruise - 1.1))) continue;   // the controller settles ~1.1 m/s under its target speed: predict the real arrival
            } else {
                const gi = sim.stage.groups.findIndex((g) => g.id === w.group);
                const gs = gi >= 0 ? sim.gstate[gi] : undefined;
                if (gs) {
                    let near = Math.hypot(gs.pos1.x - w.at[0], gs.pos1.z - w.at[2]) < w.radius;
                    if (near && w.dwell) {   // still docked in `dwell` seconds? (a deck that is already leaving must not be chased)
                        evalPose(sim.stage.groups[gi]!, sim.time + w.dwell, this.gp, this.gq);
                        near = Math.hypot(this.gp.x - w.at[0], this.gp.z - w.at[2]) < w.radius;
                    }
                    if (near) { this.released.add(w); continue; }
                }
            }
            vwant = Math.min(vwant, Math.max(0, (dHold - 0.8) * (w.mode === 'sweep' ? 1.0 : 1.4)));
            this.target.set(hp.x, 0, hp.z);
            break;
        }
        const dx = this.target.x - p.x, dz = this.target.z - p.z;
        const dist = Math.hypot(dx, dz) || 1;
        const ax = ((dx / dist) * vwant - v.x) * this.o.kp;
        const az = ((dz / dist) * vwant - v.z) * this.o.kp;
        const G = sim.T.gravity * Math.sin((sim.T.tiltMaxDeg * Math.PI) / 180) * 2.4;
        // camera basis: forward h = (sin, cos), right = (-cos, sin)
        const sh = Math.sin(heading), ch = Math.cos(heading);
        let sx = (ax * -ch + az * sh) / G;
        let sy = (ax * sh + az * ch) / G;
        if (this.o.noise) { sx += this.rnd() * this.o.noise; sy += this.rnd() * this.o.noise; }
        out.x = clamp(sx, -1, 1);
        out.y = clamp(sy, -1, 1);
    }
}
