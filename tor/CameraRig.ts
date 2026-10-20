import * as THREE from 'three';
import { clamp, smoothFactor, wrapAngle } from '../sim/math3.js';
import type { IntroKey } from '../sim/stageData.js';

/**
 * The stage camera. It lives in WORLD space (the stage tilts underneath it), and behaves like the
 * arcade original: it sits behind the ball, swings slowly toward the direction the ball is
 * travelling, and the stick is interpreted relative to its heading.
 *
 * Modes: chase (gameplay), intro (fly-through, goal -> start), orbit (goal celebration), hold (fall-out).
 */
export type CamMode = 'chase' | 'intro' | 'orbit' | 'hold';

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();

export class CameraRig {
    /** Heading (rad): the direction the camera looks along, h = (sin yaw, 0, cos yaw). */
    yaw = 0;
    mode: CamMode = 'chase';
    dist = 7.4;
    height = 4.5;
    fov = 58;
    readonly pos = new THREE.Vector3(0, 5, -8);
    readonly look = new THREE.Vector3();
    private introKeys: IntroKey[] = [];
    private introT = 0;
    private introTotal = 0;
    private orbitAngle = 0;
    private orbitBase = 0;
    private orbitT = 0;
    private orbitCenter = new THREE.Vector3();
    private shake = 0;
    /** Extra pull-back (m) that eases in with speed. */
    private speedPull = 0;
    private kick = 0;
    /** Extra height (m) that eases in while the stage is pitched forward: the deck behind the ball rises toward the camera. */
    private tiltLift = 0;

    constructor(private camera: THREE.PerspectiveCamera) {}

    snapTo(ball: THREE.Vector3, yaw: number): void {
        this.yaw = yaw;
        this.setChaseTarget(ball, 0, tmp);
        this.pos.copy(tmp);
        this.look.copy(ball).addScaledVector(UP, 0.7);
        this.apply();
    }

    startIntro(keys: IntroKey[]): void {
        this.introKeys = keys;
        this.introT = 0;
        this.introTotal = keys.length ? keys[keys.length - 1]!.t : 0;
        this.mode = keys.length >= 2 ? 'intro' : 'chase';
    }
    /** 0..1 progress through the intro. */
    introProgress(): number { return this.introTotal > 0 ? clamp(this.introT / this.introTotal, 0, 1) : 1; }
    skipIntro(): void { this.introT = this.introTotal; }

    startOrbit(center: THREE.Vector3): void {
        this.mode = 'orbit';
        this.orbitCenter.copy(center);
        const d = tmp.copy(this.pos).sub(center);
        this.orbitAngle = this.orbitBase = Math.atan2(d.x, d.z);
        this.orbitT = 0;
    }

    addShake(a: number): void { this.shake = Math.min(1, this.shake + a); }
    addKick(a: number): void { this.kick = Math.min(1, this.kick + a); }

    private setChaseTarget(ball: THREE.Vector3, pull: number, out: THREE.Vector3): THREE.Vector3 {
        const d = this.dist + pull;
        return out.set(ball.x - Math.sin(this.yaw) * d, ball.y + this.height + pull * 0.18 + this.tiltLift, ball.z - Math.cos(this.yaw) * d);
    }

    /** Advance the camera. ballVel is the ball's velocity in world axes. */
    update(dt: number, ball: THREE.Vector3, ballVel: THREE.Vector3, orbitInput: number, time: number, pitch = 0): void {
        // stage pitched forward by `pitch` rad: the deck `dist` m behind the ball rises by dist * sin(pitch); lift the camera with it
        this.tiltLift += (this.dist * Math.sin(Math.max(0, pitch)) * 1.05 - this.tiltLift) * smoothFactor(dt, 0.14);
        if (this.mode === 'intro') {
            this.updateIntro(dt);
        } else if (this.mode === 'orbit') {
            // goal celebration: stay in front of the gate (a wide orbit puts its shell between camera and ball), sway a little,
            // and look to the right of the ball so it sits left of the result panel
            this.orbitT += dt;
            this.orbitAngle = this.orbitBase + Math.sin(this.orbitT * 0.7) * 0.3;
            const r = 8.4, a = this.orbitAngle;
            this.orbitCenter.lerp(ball, smoothFactor(dt, 0.35));
            tmp.set(this.orbitCenter.x + Math.sin(a) * r, this.orbitCenter.y + 3.0, this.orbitCenter.z + Math.cos(a) * r);
            this.pos.lerp(tmp, smoothFactor(dt, 0.45));
            tmp2.copy(ball).addScaledVector(UP, 0.8);
            tmp2.x += Math.cos(a) * 3.0; tmp2.z -= Math.sin(a) * 3.0;
            this.look.lerp(tmp2, smoothFactor(dt, 0.25));
        } else if (this.mode === 'hold') {
            // keep looking at where the ball was, slowly drifting up
            this.look.lerp(ball, smoothFactor(dt, 0.6));
        } else {
            // yaw: manual orbit + auto swing toward travel direction
            this.yaw += orbitInput * 2.0 * dt;
            const hs = Math.hypot(ballVel.x, ballVel.z);
            if (hs > 2.2) {
                const want = Math.atan2(ballVel.x, ballVel.z);
                const rate = clamp((hs - 2.2) / 9, 0, 1) * 2.6;
                this.yaw += wrapAngle(want - this.yaw) * (1 - Math.exp(-rate * dt));
            }
            this.speedPull += (clamp(hs / 22, 0, 1) * 1.6 - this.speedPull) * smoothFactor(dt, 0.6);
            this.setChaseTarget(ball, this.speedPull + this.kick * 0.5, tmp);
            const kh = smoothFactor(dt, 0.11), kv = smoothFactor(dt, 0.2);
            this.pos.x += (tmp.x - this.pos.x) * kh;
            this.pos.z += (tmp.z - this.pos.z) * kh;
            this.pos.y += (tmp.y - this.pos.y) * kv;
            tmp2.copy(ball).addScaledVector(UP, 0.7);
            this.look.x += (tmp2.x - this.look.x) * smoothFactor(dt, 0.06);
            this.look.z += (tmp2.z - this.look.z) * smoothFactor(dt, 0.06);
            this.look.y += (tmp2.y - this.look.y) * smoothFactor(dt, 0.12);
        }
        this.shake *= Math.exp(-dt * 6);
        this.kick *= Math.exp(-dt * 5);
        this.apply(time);
    }

    private updateIntro(dt: number): void {
        this.introT += dt;
        const keys = this.introKeys;
        const total = this.introTotal;
        const t = clamp(this.introT, 0, total);
        // ease the whole flight in and out
        const u = t / total;
        const e = u * u * (3 - 2 * u);
        const tt = e * total;
        let i = 0;
        while (i < keys.length - 2 && keys[i + 1]!.t < tt) i++;
        const k0 = keys[i]!, k1 = keys[i + 1]!;
        const f = clamp((tt - k0.t) / Math.max(1e-4, k1.t - k0.t), 0, 1);
        const s = f * f * (3 - 2 * f);
        const km = keys[Math.max(0, i - 1)]!, kn = keys[Math.min(keys.length - 1, i + 2)]!;
        const cr = (a: number, b: number, c: number, d: number, x: number) =>
            0.5 * (2 * b + (-a + c) * x + (2 * a - 5 * b + 4 * c - d) * x * x + (-a + 3 * b - 3 * c + d) * x * x * x);
        this.pos.set(cr(km.pos[0], k0.pos[0], k1.pos[0], kn.pos[0], s), cr(km.pos[1], k0.pos[1], k1.pos[1], kn.pos[1], s), cr(km.pos[2], k0.pos[2], k1.pos[2], kn.pos[2], s));
        this.look.set(cr(km.look[0], k0.look[0], k1.look[0], kn.look[0], s), cr(km.look[1], k0.look[1], k1.look[1], kn.look[1], s), cr(km.look[2], k0.look[2], k1.look[2], kn.look[2], s));
    }

    private apply(time = 0): void {
        this.camera.position.copy(this.pos);
        if (this.shake > 0.001) {
            const a = this.shake * 0.12;
            this.camera.position.x += Math.sin(time * 71) * a;
            this.camera.position.y += Math.cos(time * 83) * a;
        }
        this.camera.lookAt(this.look);
        if (Math.abs(this.camera.fov - this.fov) > 0.01) {
            this.camera.fov = this.fov;
            this.camera.updateProjectionMatrix();
        }
    }
}
