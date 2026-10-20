import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { getBuiltinAnimationDef } from 'engine/animation/library/AnimationPacks.js';

/**
 * The engine's own locomotion clips (motion capture on the Mixamo skeleton the animals are rigged to) for the animal in the ball: idle, walk and
 * run, loaded once per session. Each clip is made IN PLACE for the ball: the hips' forward root motion is removed (the ball does the travelling)
 * and their bob and sway are kept, as offsets from the clip's rest height, so `forRig` can rescale them to an animal of any size.
 *
 * `speed` is the clip's natural ground speed in clip-character hip heights per second (measured from its own root motion), so an animal plays
 * it at the right rate for ITS size: natural m/s = speed * the animal's hip height.
 */
export interface LocomotionClip {
    clip: THREE.AnimationClip;
    /** Hip heights travelled per second at timeScale 1 (0 for the idle). */
    speed: number;
}

export interface LocomotionSet { idle: LocomotionClip; walk: LocomotionClip; run: LocomotionClip }

const HIPS = 'mixamorigHips';
let loading: Promise<LocomotionSet> | null = null;

/** Root motion out of the hips track: forward (z) and lateral (x) travel become offsets around the straight line through the loop, y around the rest height. */
function inPlace(src: THREE.AnimationClip, name: string): LocomotionClip {
    const clip = src.clone();
    clip.name = name;
    let speed = 0;
    const track = clip.tracks.find((t) => t.name === `${HIPS}.position`);
    if (track) {
        const v = track.values, n = track.times.length, dur = Math.max(1e-6, clip.duration);
        const restY = v[1]!;   // first frame's height stands for the rest height (the clip's own rest pose has the same)
        const dz = v[(n - 1) * 3 + 2]! - v[2]!, dx = v[(n - 1) * 3]! - v[0]!;
        speed = Math.hypot(dx, dz) / dur / restY;
        const out = new Float32Array(v.length);
        for (let i = 0; i < n; i++) {
            const t = track.times[i]! / dur;
            out[i * 3] = (v[i * 3]! - v[0]! - dx * t) / restY;
            out[i * 3 + 1] = (v[i * 3 + 1]! - restY) / restY;
            out[i * 3 + 2] = (v[i * 3 + 2]! - v[2]! - dz * t) / restY;
        }
        // stored as offsets in hip heights; `forRig` turns them into the animal's own hips positions
        clip.tracks[clip.tracks.indexOf(track)] = new THREE.VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(out));
    }
    return { clip, speed };
}

/** Load (once) and prepare the idle, walk and run clips. */
export function loadLocomotionClips(engine: EngineLike): Promise<LocomotionSet> {
    loading ??= (async () => {
        const load = async (id: string, name: string): Promise<LocomotionClip> => {
            const url = getBuiltinAnimationDef(id)?.animationUrl;
            if (!url) throw new Error(`[tor] no built-in animation ${id}`);
            const gltf = await (engine.loader as { loadAsync(u: string): Promise<{ animations: THREE.AnimationClip[] }> }).loadAsync(url);
            const src = gltf.animations[0];
            if (!src) throw new Error(`[tor] ${id} has no clip`);
            return inPlace(src, name);
        };
        const [idle, walk, run] = await Promise.all([load('mGenIdle01', 'idle'), load('mGenWalk01', 'walk'), load('mGenSlowRun01', 'run')]);
        return { idle, walk, run };
    })();
    loading.catch(() => { loading = null; });
    return loading;
}

/**
 * The set made for one animal: hips offsets scaled by its hip height (model units) and added to its own bind position, and only the tracks of
 * bones the animal has (its tail, for one, is not in the clips: BallView keeps posing it).
 */
export function forRig(set: LocomotionSet, hipsBind: THREE.Vector3, hipsHeight: number, boneNames: ReadonlySet<string>): LocomotionSet {
    const adapt = (lc: LocomotionClip): LocomotionClip => {
        const clip = lc.clip.clone();
        clip.tracks = clip.tracks.filter((t) => boneNames.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        const i = clip.tracks.findIndex((t) => t.name === `${HIPS}.position`);
        if (i >= 0) {
            const t = clip.tracks[i]!, v = new Float32Array(t.values.length);
            for (let k = 0; k < v.length; k += 3) {
                v[k] = hipsBind.x + t.values[k]! * hipsHeight;
                v[k + 1] = hipsBind.y + t.values[k + 1]! * hipsHeight;
                v[k + 2] = hipsBind.z + t.values[k + 2]! * hipsHeight;
            }
            clip.tracks[i] = new THREE.VectorKeyframeTrack(t.name, Array.from(t.times), Array.from(v));
        }
        return { clip, speed: lc.speed };
    };
    return { idle: adapt(set.idle), walk: adapt(set.walk), run: adapt(set.run) };
}
