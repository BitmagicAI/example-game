import { Quat, Vec3, applyQuat, clamp } from './math3.js';
import { TriGrid } from './collision.js';

/**
 * Data model of a Trick or Roll stage as the simulation sees it. It is produced by
 * `parseStageGlb` from the GLB that Blender exports (tools/level/*.py), so the art and the
 * physics always come from one file.
 *
 * Coordinates are the stage's own ("stage-local") frame: metres, +Y up, +Z forward, exactly as
 * authored. Animated groups (spinning discs, sliding planks...) carry their own frame; their
 * pose at time t is `evalPose`.
 */

/** How an animated group moves. Angles in degrees, times in seconds. */
export type AnimSpec =
    /** Continuous spin about a group-local axis. */
    | { kind: 'rotate'; axis: [number, number, number]; degPerSec: number; phaseDeg?: number }
    /** Ping-pong between two stage-space offsets from the rest position. `pause` = fraction of the period spent still at each end. */
    | { kind: 'linear'; from: [number, number, number]; to: [number, number, number]; period: number; phase?: number; pause?: number }
    /** Oscillating rotation (a swinging bar, a pendulum). */
    | { kind: 'sway'; axis: [number, number, number]; amplitudeDeg: number; period: number; phase?: number }
    /** Circular translation in the stage's XZ plane. */
    | { kind: 'orbit'; radius: number; period: number; phase?: number }
    /** Sawtooth translation: slides by `to` over one period, then snaps back (seamless for repeating tread patterns). */
    | { kind: 'loop'; to: [number, number, number]; period: number; phase?: number };

export interface SurfaceProps {
    /** Coulomb-ish friction coefficient (tangential speed removed per unit normal impulse). */
    friction: number;
    /** Bounce coefficient for impacts faster than the rest threshold. */
    restitution: number;
    /** Belt surface velocity, in the group's local frame (m/s). */
    conveyor: [number, number, number] | null;
}

export interface CollisionMesh {
    name: string;
    /** 9 floats per triangle, in the owning group's local frame. */
    tris: Float32Array;
    triCount: number;
    surface: SurfaceProps;
    grid: TriGrid;
}

export interface CollisionGroup {
    id: string;
    /** Node name in the GLB for animated groups, 'static' for the world. */
    nodeName: string;
    meshes: CollisionMesh[];
    /** Rest transform of the group inside the stage. */
    basePos: Vec3;
    baseQuat: Quat;
    anim: AnimSpec | null;
    /** Group-local AABB of all its triangles (for a cheap reject). */
    min: Vec3;
    max: Vec3;
}

export type ItemKind = 'start' | 'goal' | 'candy' | 'bucket' | 'bumper' | 'wormhole' | 'light' | 'cam' | 'prop' | 'spawner';

export interface StageItem {
    id: number;
    name: string;
    kind: ItemKind;
    /** Owning animated group id, or -1 for the static world. Position/quat are group-local. */
    group: number;
    pos: Vec3;
    quat: Quat;
    extras: Record<string, unknown>;
}

export interface IntroKey { pos: [number, number, number]; look: [number, number, number]; t: number }

export interface StageData {
    name: string;
    title: string;
    world: string;
    /** Seconds on the clock. */
    time: number;
    /** Par time (seconds) for the bonus. */
    par: number;
    /** Stage-local Y below which the ball is out. */
    fallY: number;
    /** Point the stage tilts about. */
    pivot: Vec3;
    groups: CollisionGroup[];
    items: StageItem[];
    intro: IntroKey[];
    extras: Record<string, unknown>;
    /** Total candy value available (singles + 10 per bucket). */
    candyTotal: number;
}

const SCRATCH_OFF = new Vec3();
const SCRATCH_AXIS = new Vec3();
const SCRATCH_Q = new Quat();

/** Triangle wave 0..1..0 over one period, with optional dwell at the ends and a smooth ease. */
function pingPong(t: number, period: number, phase: number, pause: number): number {
    let u = (t / period + phase) % 1;
    if (u < 0) u += 1;
    // 0..0.5 forward, 0.5..1 back
    const half = u < 0.5 ? u * 2 : (1 - u) * 2;
    const p = clamp(pause, 0, 0.45);
    const s = clamp((half - p) / (1 - 2 * p), 0, 1);
    return (1 - Math.cos(Math.PI * s)) / 2;   // sine ease: gentle accelerations so the ball can ride it
}

/** Pose (stage frame) of a group at stage time t. */
export function evalPose(g: CollisionGroup, t: number, outPos: Vec3, outQuat: Quat): void {
    outPos.copy(g.basePos);
    outQuat.copy(g.baseQuat);
    const a = g.anim;
    if (!a) return;
    switch (a.kind) {
        case 'rotate': {
            const ang = ((a.phaseDeg ?? 0) + a.degPerSec * t) * (Math.PI / 180);
            SCRATCH_AXIS.set(a.axis[0], a.axis[1], a.axis[2]).normalize();
            SCRATCH_Q.setAxisAngle(SCRATCH_AXIS.x, SCRATCH_AXIS.y, SCRATCH_AXIS.z, ang);
            outQuat.multiply(SCRATCH_Q);
            break;
        }
        case 'sway': {
            const ang = a.amplitudeDeg * (Math.PI / 180) * Math.sin(2 * Math.PI * (t / a.period + (a.phase ?? 0)));
            SCRATCH_AXIS.set(a.axis[0], a.axis[1], a.axis[2]).normalize();
            SCRATCH_Q.setAxisAngle(SCRATCH_AXIS.x, SCRATCH_AXIS.y, SCRATCH_AXIS.z, ang);
            outQuat.multiply(SCRATCH_Q);
            break;
        }
        case 'linear': {
            const e = pingPong(t, a.period, a.phase ?? 0, a.pause ?? 0.1);
            outPos.x += a.from[0] + (a.to[0] - a.from[0]) * e;
            outPos.y += a.from[1] + (a.to[1] - a.from[1]) * e;
            outPos.z += a.from[2] + (a.to[2] - a.from[2]) * e;
            break;
        }
        case 'loop': {
            let u = (t / a.period + (a.phase ?? 0)) % 1;
            if (u < 0) u += 1;
            outPos.x += a.to[0] * u; outPos.y += a.to[1] * u; outPos.z += a.to[2] * u;
            break;
        }
        case 'orbit': {
            const ang = 2 * Math.PI * (t / a.period + (a.phase ?? 0));
            outPos.x += Math.cos(ang) * a.radius;
            outPos.z += Math.sin(ang) * a.radius;
            break;
        }
    }
}

/** Transform a group-local point into the stage frame at the given pose. */
export function localToStage(pos: Vec3, quat: Quat, local: Vec3, out: Vec3): Vec3 {
    applyQuat(quat, local, SCRATCH_OFF);
    return out.set(SCRATCH_OFF.x + pos.x, SCRATCH_OFF.y + pos.y, SCRATCH_OFF.z + pos.z);
}
