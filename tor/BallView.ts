// @ts-nocheck -- TSL shader-graph code (glass shell): three's node typings are incomplete
import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
    float, vec3, vec4, uniform, dot, smoothstep, mix, pow, saturate, normalView, positionView, normalLocal, positionLocal, abs, max, min, reflect,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/render/backend/RendererType.js';
import { loadCharacterModel } from 'engine/character/loading/CharacterModelLoader.js';
import type { EngineLike, GameData } from 'types/game.js';
import { getAssetUrlByName } from 'types/game.js';
import { AnimalRig, BONE } from './AnimalRig.js';
import { createCharacterSmoothMaterial, createComicMaterial, setCharacterShading } from './comic.js';
import type { StageSim } from '../sim/physics.js';
import type { CharacterLook, GlassLook, GroundLook } from './looks.js';
import { BallGround } from './BallGround.js';
import { forRig, loadLocomotionClips, type LocomotionSet } from './AnimalClips.js';

/**
 * The hero: an animal running inside a glass ball. The shell rolls with the physics orientation
 * (rolling bands make the spin readable); the animal stays upright in the world and turns to face
 * the way the ball travels, running in time with its speed.
 */
export const BALL_RADIUS = 0.5;

const tint = uniform(new THREE.Color('#ffd58a'));
const inkCol = uniform(new THREE.Color('#1a0d26'));

/**
 * The look's glass (looks.ts GlassLook), blended in by `nightK`: 0 is the classic shell exactly (mix(a, b, 0) = a), 1 the look's clear glass:
 * nearly invisible in the middle so the animal reads, a thin cool edge, small view-fixed highlights, a faint reflection of the night sky at grazing
 * angles, a glow that stays on the silhouette, and fainter rolling bands.
 */
const G = {
    nightK: uniform(0),
    edge: uniform(new THREE.Color('#e6fff4')),
    glow: uniform(new THREE.Color('#9fe3c4')),
    centre: uniform(0.015),
    bands: uniform(0.16),
    highlights: uniform(0.55),
    ink: uniform(0.35),
    inkColor: uniform(new THREE.Color('#2a1d48')),
    skyLo: uniform(new THREE.Color('#1c1630')),
    skyHi: uniform(new THREE.Color('#8f86a6')),
};
const glG = {
    uNightK: { value: 0 }, uEdge: { value: new THREE.Color('#e6fff4') }, uGlow: { value: new THREE.Color('#9fe3c4') }, uCentre: { value: 0.015 },
    uBands: { value: 0.16 }, uHigh: { value: 0.55 }, uInk: { value: 0.35 }, uInkCol: { value: new THREE.Color('#2a1d48') },
};

function setGlass(g: GlassLook | null): void {
    G.nightK.value = g ? 1 : 0;
    glG.uNightK.value = g ? 1 : 0;
    if (!g) return;
    G.edge.value.set(g.edge); G.glow.value.set(g.glow); G.inkColor.value.set(g.inkColor);
    G.centre.value = g.centre; G.bands.value = g.bands; G.highlights.value = g.highlights; G.ink.value = g.ink;
    glG.uEdge.value.set(g.edge); glG.uGlow.value.set(g.glow); glG.uInkCol.value.set(g.inkColor);
    glG.uCentre.value = g.centre; glG.uBands.value = g.bands; glG.uHigh.value = g.highlights; glG.uInk.value = g.ink;
}

/** Classic-WebGL twin of the TSL glass shell below: same fresnel, view-fixed window highlights, rolling great-circle bands and ink ring. */
const glTint = { value: new THREE.Color('#ffd58a') };
function glassFrontGL(): THREE.Material {
    const m = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
    m.customProgramCacheKey = () => 'torGlassFront';
    m.onBeforeCompile = (sh) => {
        sh.uniforms.uTint = glTint;
        Object.assign(sh.uniforms, glG);
        sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying vec3 vObjN; varying vec3 vViewN; varying vec3 vViewP;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjN = normal; vViewN = normalize(normalMatrix * normal); vViewP = (modelViewMatrix * vec4(position, 1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nuniform vec3 uTint; uniform float uNightK; uniform vec3 uEdge; uniform vec3 uGlow; uniform float uCentre; uniform float uBands; uniform float uHigh; uniform float uInk; uniform vec3 uInkCol; varying vec3 vObjN; varying vec3 vViewN; varying vec3 vViewP;')
            .replace('#include <opaque_fragment>', `
                vec3 nV = normalize(vViewN); vec3 vd = normalize(-vViewP);
                float ndv = clamp(dot(nV, vd), 0.0, 1.0);
                float fres = pow(1.0 - ndv, 2.2);
                float h1 = dot(nV, normalize(vec3(-0.44, 0.64, 0.63)));
                float blob1 = smoothstep(0.90, 0.925, h1);
                float h2 = dot(nV, normalize(vec3(0.42, -0.52, 0.74)));
                float blob2 = smoothstep(0.962, 0.972, h2);
                float streak = smoothstep(0.32, 0.36, fres) * (1.0 - smoothstep(0.42, 0.5, fres)) * smoothstep(0.1, 0.5, h1 + 0.25);
                vec3 n = normalize(vObjN);
                float band = max(max(1.0 - smoothstep(0.014, 0.034, abs(n.y)), 1.0 - smoothstep(0.014, 0.034, abs(n.x))), 1.0 - smoothstep(0.014, 0.034, abs(n.z)));
                float ring = 1.0 - smoothstep(0.22, 0.30, ndv);
                vec3 base = mix(uTint, vec3(1.0), clamp(blob1 + blob2 + streak * 0.6, 0.0, 1.0));
                vec3 col = mix(mix(base, uTint * 1.25, band * 0.7), vec3(0.102, 0.05, 0.149), ring);
                float alpha = max(clamp(0.06 + fres * 0.5 + blob1 * 0.9 + blob2 + streak * 0.55 + band * 0.62, 0.0, 1.0), ring * 0.96);
                // the look's clear glass (see G)
                float fr3 = pow(1.0 - ndv, 3.0);
                float edgeN = smoothstep(0.62, 0.95, 1.0 - ndv) * (1.0 - smoothstep(0.95, 1.0, 1.0 - ndv) * 0.6);
                float hiN = (smoothstep(0.968, 0.978, h1) + smoothstep(0.985, 0.99, h2)) * uHigh;
                float ringN = (1.0 - smoothstep(0.08, 0.14, ndv)) * uInk;
                vec3 rv = reflect(-vd, nV);
                vec3 colN = mix(vec3(0.11, 0.086, 0.188), vec3(0.56, 0.525, 0.65), clamp(rv.y * 0.5 + 0.5, 0.0, 1.0));
                colN = mix(colN, uGlow, fr3 * 0.6);
                colN = mix(colN, uEdge, edgeN);
                colN = mix(colN, vec3(1.0), clamp(hiN, 0.0, 1.0));
                colN = mix(colN, uInkCol, ringN);
                float alphaN = max(clamp(uCentre + fr3 * 0.3 + edgeN * 0.5 + hiN * 0.9 + band * 0.62 * uBands, 0.0, 1.0), ringN * 0.9);
                gl_FragColor = vec4(mix(col, colN, uNightK), mix(alpha, alphaN, uNightK));
            `);
    };
    return m;
}

function glassFront(): THREE.Material {
    if (!isWebGpuActive()) return glassFrontGL();
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.FrontSide });
    const nV = normalView.normalize();
    const viewDir = positionView.negate().normalize();
    const ndv = saturate(dot(nV, viewDir));
    const fres = pow(float(1).sub(ndv), 2.2);
    // comic window-reflection highlights, fixed in view space
    const h1 = dot(nV, vec3(-0.44, 0.64, 0.63).normalize());
    const blob1 = smoothstep(0.90, 0.925, h1);
    const h2 = dot(nV, vec3(0.42, -0.52, 0.74).normalize());
    const blob2 = smoothstep(0.962, 0.972, h2);
    const streak = smoothstep(0.32, 0.36, fres).mul(float(1).sub(smoothstep(0.42, 0.5, fres))).mul(smoothstep(0.1, 0.5, h1.add(0.25)));
    // rolling bands: three great circles in the ball's own (rotating) frame
    const n = normalLocal;
    const w0 = 0.014, w1 = 0.034;
    const band = max(max(float(1).sub(smoothstep(w0, w1, abs(n.y))), float(1).sub(smoothstep(w0, w1, abs(n.x)))), float(1).sub(smoothstep(w0, w1, abs(n.z))));
    // ink ring on the silhouette
    const ring = float(1).sub(smoothstep(0.22, 0.30, ndv));
    const base = mix(vec3(tint), vec3(1.0), saturate(blob1.add(blob2).add(streak.mul(0.6))));
    const col = mix(mix(base, vec3(tint).mul(1.25), band.mul(0.7)), vec3(inkCol), ring);
    const alpha = saturate(float(0.06).add(fres.mul(0.5)).add(blob1.mul(0.9)).add(blob2).add(streak.mul(0.55)).add(band.mul(0.62))).max(ring.mul(0.96));
    // the look's clear glass (see G)
    const fr3 = pow(float(1).sub(ndv), 3.0);
    const edgeN = smoothstep(0.62, 0.95, float(1).sub(ndv)).mul(float(1).sub(smoothstep(0.95, 1.0, float(1).sub(ndv)).mul(0.6)));
    const hiN = smoothstep(0.968, 0.978, h1).add(smoothstep(0.985, 0.99, h2)).mul(G.highlights);
    const ringN = float(1).sub(smoothstep(0.08, 0.14, ndv)).mul(G.ink);
    const rv = reflect(viewDir.negate(), nV);
    let colN = mix(vec3(G.skyLo), vec3(G.skyHi), saturate(rv.y.mul(0.5).add(0.5)));
    colN = mix(colN, vec3(G.glow), fr3.mul(0.6));
    colN = mix(colN, vec3(G.edge), edgeN);
    colN = mix(colN, vec3(1.0), saturate(hiN));
    colN = mix(colN, vec3(G.inkColor), ringN);
    const alphaN = saturate(G.centre.add(fr3.mul(0.3)).add(edgeN.mul(0.5)).add(hiN.mul(0.9)).add(band.mul(0.62).mul(G.bands))).max(ringN.mul(0.9));
    m.colorNode = mix(col, colN, G.nightK);
    m.opacityNode = mix(alpha, alphaN, G.nightK);
    return m;
}

function glassBack(): THREE.Material {
    if (!isWebGpuActive()) {
        const gl = new THREE.MeshBasicMaterial({ color: 0x8a5a2a, transparent: true, opacity: 0.12, side: THREE.BackSide, depthWrite: false });
        glBack.push(gl);
        return gl;
    }
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.BackSide });
    const viewDir = positionView.negate().normalize();
    const ndv = saturate(dot(normalView.normalize().negate(), viewDir));
    const rim = pow(float(1).sub(ndv), 1.5);
    m.colorNode = mix(mix(vec3(tint).mul(0.35), vec3(0.16, 0.08, 0.22), rim), vec3(0.09, 0.075, 0.15), G.nightK);
    m.opacityNode = mix(saturate(float(0.05).add(rim.mul(0.32))), saturate(float(0.02).add(rim.mul(0.16))), G.nightK);
    return m;
}
const glBack: THREE.MeshBasicMaterial[] = [];

/**
 * A copy of `geo` whose normals are averaged over every vertex sharing a position (UV seams and facets alike), so a faceted low-poly animal shades
 * smoothly. Positions, UVs and skin weights are the same; only the normals differ.
 */
function smoothNormalGeometry(geo: THREE.BufferGeometry): THREE.BufferGeometry {
    const g = geo.clone();
    const P = g.getAttribute('position'), N = g.getAttribute('normal');
    if (!P || !N) return g;
    const key = (i: number): string => `${P.getX(i).toFixed(5)},${P.getY(i).toFixed(5)},${P.getZ(i).toFixed(5)}`;
    const sums = new Map<string, [number, number, number]>();
    for (let i = 0; i < P.count; i++) {
        const k = key(i);
        const s = sums.get(k);
        if (s) { s[0] += N.getX(i); s[1] += N.getY(i); s[2] += N.getZ(i); } else sums.set(k, [N.getX(i), N.getY(i), N.getZ(i)]);
    }
    const out = new Float32Array(P.count * 3);
    for (let i = 0; i < P.count; i++) {
        const s = sums.get(key(i))!;
        const l = Math.hypot(s[0], s[1], s[2]) || 1;
        out[i * 3] = s[0] / l; out[i * 3 + 1] = s[1] / l; out[i * 3 + 2] = s[2] / l;
    }
    g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    return g;
}

/**
 * Inverted-hull outline for the animal (the look's `character.outline`): the same geometry drawn back faces only, pushed out along its normals.
 * The push is in the mesh's own units (`width` metres / the mesh's world scale), after skinning on WebGPU and before it on WebGL (close enough for
 * a hull a centimetre thick).
 */
const outlineColor = uniform(new THREE.Color('#24163c'));
const glOutline = { value: new THREE.Color('#24163c') };
function outlineMaterial(width: number): THREE.Material {
    if (!isWebGpuActive()) {
        const m = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
        m.customProgramCacheKey = () => 'torOutline';
        const w = { value: width };
        m.onBeforeCompile = (sh) => {
            sh.uniforms.uOW = w; sh.uniforms.uOC = glOutline;
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uOW;').replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * uOW;');
            sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec3 uOC;').replace('#include <opaque_fragment>', 'gl_FragColor = vec4(uOC, 1.0);');
        };
        m.userData.width = w;
        return m;
    }
    const m = new MeshBasicNodeMaterial({ side: THREE.BackSide });
    const w = uniform(width);
    m.positionNode = positionLocal.add(normalLocal.mul(w));
    m.colorNode = vec3(outlineColor);
    m.userData.width = w;
    return m;
}

export interface BallLook { tint: string; }

/** One animal's locomotion: the engine's idle / walk / run clips on its own mixer (AnimalClips.ts), blended by speed in BallView.poseClips. */
interface Loco { mixer: THREE.AnimationMixer; set: LocomotionSet; idle: THREE.AnimationAction; walk: THREE.AnimationAction; run: THREE.AnimationAction }
type AnimalEntry = { root: THREE.Object3D; rig: AnimalRig; fitted: boolean; loco: Loco | null };

/** Fastest playback of the walk / run clips relative to their natural speed: faster than this a real gait turns into a twitch, so a fast ball slips a little under the feet. */
const WALK_MAX_RATE = 2.0;
const RUN_MAX_RATE = 4.0;

function makeLoco(root: THREE.Object3D, rig: AnimalRig, clips: LocomotionSet): Loco {
    const set = forRig(clips, rig.hipsBindPosition, rig.hipsBindPosition.y, rig.boneNames);
    const mixer = new THREE.AnimationMixer(root);
    const action = (c: THREE.AnimationClip): THREE.AnimationAction => {
        const a = mixer.clipAction(c);
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.timeScale = 0;   // BallView sets every action's time itself (one shared stride phase)
        a.setEffectiveWeight(0);
        a.play();
        return a;
    };
    return { mixer, set, idle: action(set.idle.clip), walk: action(set.walk.clip), run: action(set.run.clip) };
}

/** The look's ball and character settings (null: classic). */
export interface BallViewLook { glass: GlassLook | null; character: CharacterLook | null; ground: GroundLook | null }

export class BallView {
    /** At the ball centre, stage coordinates, never rotated itself. */
    readonly root = new THREE.Group();
    private shell = new THREE.Group();
    private anchor = new THREE.Group();
    private animalRoot: THREE.Object3D | null = null;
    private rig: AnimalRig | null = null;
    private facing = 0;
    private phase = 0;
    private lean = 0;
    private bob = 0;
    private airT = 0;
    private prevGrounded = true;
    private landSquash = 0;
    private celebrate = 0;
    /** Expression: 'run' is the normal cycle; the others override the pose. */
    mood: 'run' | 'cheer' | 'panic' | 'wave' = 'run';
    private moodT = 0;

    constructor() {
        this.root.name = 'Ball';
        const geo = new THREE.SphereGeometry(BALL_RADIUS, 48, 32);
        const back = new THREE.Mesh(geo, glassBack());
        back.renderOrder = 1;
        const front = new THREE.Mesh(geo, glassFront());
        front.renderOrder = 3;
        back.castShadow = false; front.castShadow = false;
        this.shell.add(back, front);
        this.root.add(this.shell, this.anchor, this.ground.root);
    }

    setTint(hex: string): void { tint.value.set(hex); glTint.value.set(hex); }

    /** Debug (portrait renders): show `mood` frozen `t` seconds into it (null releases). */
    private hold: { mood: 'run' | 'cheer' | 'panic' | 'wave'; t: number } | null = null;
    holdPose(mood: 'run' | 'cheer' | 'panic' | 'wave' | null, t = 0): void {
        this.hold = mood ? { mood, t } : null;
        this.pose(0, 0, false, 0);
    }

    /** Debug: show/hide the dynamic-eye meshes and the static body. */
    debugEyes(dyn: boolean, body: boolean): void {
        this.animalRoot?.traverse((o) => {
            if (o.name.startsWith('DynamicEye')) o.visible = dyn;
            else if (o.name.startsWith('EyeSurface')) o.visible = body;
        });
    }

    /** Debug: the animal's bounding box in ball-local space (centre and size, metres) with the current pose. */
    debugAnimalBox(): object | null {
        if (!this.animalRoot) return null;
        this.root.updateMatrixWorld(true);
        const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
        const box = new THREE.Box3();
        const v = new THREE.Vector3(), m4 = new THREE.Matrix4();
        this.animalRoot.traverse((o) => {
            const mesh = o as THREE.SkinnedMesh;
            if (!mesh.isMesh || !mesh.visible) return;
            m4.multiplyMatrices(inv, mesh.matrixWorld);
            const pos = mesh.geometry.attributes.position!;
            for (let i = 0; i < pos.count; i += 4) {
                if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
                box.expandByPoint(v.applyMatrix4(m4));
            }
        });
        const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
        let far = 0;
        return { center: c.toArray().map((x) => +x.toFixed(3)), size: sz.toArray().map((x) => +x.toFixed(3)), min: box.min.toArray().map((x) => +x.toFixed(3)), max: box.max.toArray().map((x) => +x.toFixed(3)), far };
    }

    /** Debug: every mesh of the current animal (name, visibility, colour). */
    debugAnimal(): object[] {
        const out: object[] = [];
        this.animalRoot?.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh) return;
            // faceting: vertices sharing a position whose normals disagree (flat-shaded low-poly) vs agree (smooth)
            const P = m.geometry.getAttribute('position'), N = m.geometry.getAttribute('normal');
            const byPos = new Map<string, number[]>();
            for (let i = 0; i < (P?.count ?? 0); i++) {
                const k = `${P!.getX(i).toFixed(4)},${P!.getY(i).toFixed(4)},${P!.getZ(i).toFixed(4)}`;
                let l = byPos.get(k); if (!l) byPos.set(k, l = []); l.push(i);
            }
            let shared = 0, split = 0;
            if (N) for (const l of byPos.values()) {
                if (l.length < 2) continue;
                shared++;
                const a = l[0]!;
                if (l.some((b) => N.getX(a) * N.getX(b) + N.getY(a) * N.getY(b) + N.getZ(a) * N.getZ(b) < 0.98)) split++;
            }
            const mat = m.material as THREE.Material;
            out.push({ name: o.name, visible: o.visible, parent: o.parent?.name, tris: (m.geometry.index?.count ?? 0) / 3, material: mat.type, verts: P?.count ?? 0, positions: byPos.size, splitNormalsAt: `${split}/${shared}` });
        });
        return out;
    }

    /** Contact shadow and light pool under the ball (looks with `ground`). */
    readonly ground = new BallGround();
    private look: BallViewLook = { glass: null, character: null, ground: null };

    /** Apply a stage look's glass, character and ground settings (null fields = classic). Cheap: uniforms and visibility only. */
    setLook(look: BallViewLook): void {
        this.look = look;
        setGlass(look.glass);
        setCharacterShading(look.character);
        const c = look.character;
        if (c?.outline) { outlineColor.value.set(c.outline); glOutline.value.set(c.outline); }
        for (const m of glBack) m.opacity = look.glass ? 0.05 : 0.12;
        this.anchor.scale.setScalar(c?.scale ?? 1);
        for (const e of this.outlines) e.visible = !!c?.outline;
        this.applyShading();
        this.ground.setLook(look.ground);
        this.refreshOutlineWidths();
    }

    /** Every animal loaded so far gets the look's shading (comic unless the look asks for smooth). */
    private applyShading(): void {
        const smooth = this.look.character?.shading === 'smooth';
        for (const entry of this.loadedRoots) {
            entry.traverse((o) => {
                const m = o as THREE.Mesh;
                const sh = m.userData?.shading as { comic: THREE.Material; smooth: THREE.Material; flat: THREE.BufferGeometry; smoothGeo?: THREE.BufferGeometry } | undefined;
                if (!m.isMesh || !sh) return;
                m.material = smooth ? sh.smooth : sh.comic;
                if (smooth) sh.smoothGeo ??= smoothNormalGeometry(sh.flat);
                m.geometry = smooth ? sh.smoothGeo! : sh.flat;
            });
        }
    }
    private loadedRoots: THREE.Object3D[] = [];

    /** Outline hulls of every animal loaded so far (shown only with a character look). */
    private outlines: THREE.Mesh[] = [];

    private refreshOutlineWidths(): void {
        const width = this.look.character?.outlineWidth ?? 0.012;
        const s = new THREE.Vector3();
        for (const o of this.outlines) {
            const src = o.userData.source as THREE.Mesh;
            src.updateWorldMatrix(true, false);
            src.getWorldScale(s);
            const k = (s.x * this.anchor.scale.x) / Math.max(1e-6, this.root.getWorldScale(new THREE.Vector3()).x * this.anchor.scale.x);
            const u = (o.material as THREE.Material).userData.width as { value: number };
            u.value = width / Math.max(1e-6, k);
        }
    }

    private addOutlines(root: THREE.Object3D): void {
        const meshes: THREE.Mesh[] = [];
        root.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.isOutline) meshes.push(o as THREE.Mesh); });
        for (const m of meshes) {
            if (!m.geometry.getAttribute('normal')) continue;
            const mat = outlineMaterial(0.01);
            let hull: THREE.Mesh;
            const sk = m as THREE.SkinnedMesh;
            if (sk.isSkinnedMesh) {
                const h = new THREE.SkinnedMesh(sk.geometry, mat);
                h.bind(sk.skeleton, sk.bindMatrix);
                h.bindMode = sk.bindMode;
                hull = h;
                m.parent!.add(h);
                h.position.copy(m.position); h.quaternion.copy(m.quaternion); h.scale.copy(m.scale);
            } else {
                hull = new THREE.Mesh(m.geometry, mat);
                m.add(hull);
            }
            hull.userData.isOutline = true;
            hull.userData.source = m;
            hull.name = `${m.name}:outline`;
            hull.frustumCulled = false;
            hull.castShadow = false;
            hull.receiveShadow = false;
            hull.renderOrder = 2;
            hull.visible = !!this.look.character?.outline;
            this.outlines.push(hull);
        }
    }

    private animalCache = new Map<string, Promise<AnimalEntry | null>>();
    /** The current animal's clips (null: they did not load, the procedural gait runs). */
    private loco: Loco | null = null;
    /** Shared stride phase of the walk and run clips (0..1), and the idle's own clock. */
    private cyc = 0;
    private idleT = 0;
    private loadToken = 0;
    private shownAnimal: string | null = null;

    /** The asset name of the animal that is on the ball right now (null until the first one has loaded). */
    get animalName(): string | null { return this.shownAnimal; }

    private loadEntry(engine: EngineLike, gameData: GameData | null, assetName: string): Promise<AnimalEntry | null> {
        let p = this.animalCache.get(assetName);
        if (p) return p;
        p = (async () => {
            // ?animaldir=build/chars_opt loads <dir>/<asset name>.glb from the dev server instead of the registered asset (tools/ comparisons only)
            const dir = new URLSearchParams(window.location.search).get('animaldir');
            const url = dir ? `/${dir.replace(/^\/+|\/+$/g, '')}/${assetName}.glb` : getAssetUrlByName(gameData, assetName);
            if (!url) { console.warn('[tor] animal asset missing:', assetName); return null; }
            const model = await loadCharacterModel(engine.loader, url);
            const root = model.scene;
            root.traverse((o) => {
                const m = o as THREE.SkinnedMesh;
                if (m.isMesh) {
                    m.castShadow = true; m.receiveShadow = false; m.frustumCulled = false;
                    const src = m.material as THREE.MeshStandardMaterial;
                    const comic = createComicMaterial({ color: src.color, map: src.map, vertexColors: false, paint: 0, halftone: 0, selfLight: 0.2, character: true });
                    // both shadings exist from the start, so a look switching between them only swaps materials (each compiles once)
                    m.userData.shading = { comic, smooth: createCharacterSmoothMaterial({ color: src.color, map: src.map }), flat: m.geometry };
                    m.material = this.look.character?.shading === 'smooth' ? m.userData.shading.smooth : comic;
                    m.renderOrder = 2;
                }
            });
            this.addOutlines(root);
            this.loadedRoots.push(root);
            this.applyShading();
            const rig = new AnimalRig(root);
            const clips = await loadLocomotionClips(engine).catch((e: unknown) => { console.warn('[tor] locomotion clips did not load, the procedural gait runs instead:', e); return null; });
            return { root, rig, fitted: false, loco: clips ? makeLoco(root, rig, clips) : null };
        })();
        this.animalCache.set(assetName, p);
        return p;
    }

    /**
     * Scale and place the animal so that EVERY pose we play (run cycle, jump, wave, cheer, panic) stays inside the glass:
     * sample the skinned vertices of those poses, find the smallest sphere that holds them (centred on the ball's vertical
     * axis, free to slide up and down) and size the animal to that sphere's radius minus the glass margin.
     */
    private fitAnimal(entry: AnimalEntry): void {
        if (entry.fitted) return;
        entry.fitted = true;
        const { root, rig } = entry;
        root.scale.setScalar(1); root.position.set(0, 0, 0); root.quaternion.identity();
        const keep = { rig: this.rig, loco: this.loco, mood: this.mood, phase: this.phase, moodT: this.moodT, bob: this.bob, lean: this.lean, land: this.landSquash, cyc: this.cyc };
        this.rig = rig;
        this.loco = entry.loco;
        const v = new THREE.Vector3();
        const m4 = new THREE.Matrix4();
        const inv = new THREE.Matrix4();
        const grab = (into: number[]): void => {
            root.updateMatrixWorld(true);
            inv.copy(root.matrixWorld).invert();
            root.traverse((o) => {
                const mesh = o as THREE.SkinnedMesh;
                if (!mesh.isMesh || !mesh.visible) return;
                m4.multiplyMatrices(inv, mesh.matrixWorld);
                const pos = mesh.geometry.attributes.position!;
                for (let i = 0; i < pos.count; i += 3) {
                    if (mesh.isSkinnedMesh) mesh.getVertexPosition(i, v); else v.fromBufferAttribute(pos, i);
                    v.applyMatrix4(m4);
                    into.push(v.x, v.y, v.z);
                }
            });
        };
        const shoot = (mood: 'run' | 'cheer' | 'panic' | 'wave', moodT: number, phase: number, speed: number, air: boolean, into: number[]): void => {
            this.mood = mood; this.moodT = moodT; this.phase = phase; this.bob = 0; this.lean = 0; this.landSquash = 0;
            this.pose(0, speed, air, 0);
            grab(into);
        };
        const rest: number[] = [];
        const pts: number[] = [];
        shoot('run', 0, 0, 0, false, rest);
        for (let i = 0; i < rest.length; i++) pts.push(rest[i]!);
        if (entry.loco) {
            // every eighth of the idle, walk and run clips, each on its own
            const L = entry.loco;
            for (const one of [L.idle, L.walk, L.run]) {
                for (let k = 0; k < 8; k++) {
                    for (const a of [L.idle, L.walk, L.run]) a.setEffectiveWeight(a === one ? 1 : 0);
                    one.time = (k / 8) * one.getClip().duration;
                    L.mixer.update(0);
                    grab(pts);
                }
            }
        } else {
            for (const ph of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) shoot('run', 0, ph, 9, false, pts);
            shoot('run', 0, 0, 9, true, pts);
            shoot('run', 0, 1.2, 4, true, pts);
        }
        for (const t of [0.11, 0.22, 0.34, 0.5]) shoot('cheer', t, 0, 0, false, pts);
        for (const t of [0.1, 0.2, 0.3, 0.4, 0.5]) shoot('panic', t, 0, 0, false, pts);
        for (const t of [0.3, 0.6, 0.9, 1.2, 1.6]) shoot('wave', t, 0, 0, false, pts);
        this.rig = keep.rig; this.loco = keep.loco; this.mood = keep.mood; this.phase = keep.phase; this.moodT = keep.moodT; this.bob = keep.bob; this.lean = keep.lean; this.landSquash = keep.land; this.cyc = keep.cyc;
        rig.reset(); rig.apply();
        // horizontal centre from the rest pose, vertical shift by ternary search (the enclosing radius is convex in it)
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (let i = 0; i < rest.length; i += 3) { x0 = Math.min(x0, rest[i]!); x1 = Math.max(x1, rest[i]!); z0 = Math.min(z0, rest[i + 2]!); z1 = Math.max(z1, rest[i + 2]!); }
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        let y0 = Infinity, y1 = -Infinity;
        for (let i = 1; i < pts.length; i += 3) { y0 = Math.min(y0, pts[i]!); y1 = Math.max(y1, pts[i]!); }
        const r2 = (t: number): number => {
            let m = 0;
            for (let i = 0; i < pts.length; i += 3) {
                const dx = pts[i]! - cx, dz = pts[i + 2]! - cz, dy = pts[i + 1]! + t;
                const d = dx * dx + dz * dz + dy * dy;
                if (d > m) m = d;
            }
            return m;
        };
        let lo = -y1 - 0.5, hi = -y0 + 0.5;
        for (let k = 0; k < 40; k++) {
            const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
            if (r2(a) < r2(b)) hi = b; else lo = a;
        }
        const t = (lo + hi) / 2;
        const rEnc = Math.sqrt(r2(t));
        const s = (BALL_RADIUS - 0.07) / rEnc;
        root.scale.setScalar(s);
        root.position.set(-cx * s, t * s, -cz * s);
        if (new URLSearchParams(window.location.search).has('debug')) {
            console.log(`[tor] animal fit: enclosing radius ${rEnc.toFixed(2)} m, scale ${s.toFixed(2)}, stands ${(rig.height * s).toFixed(2)} m tall in a ${(BALL_RADIUS * 2).toFixed(1)} m ball, leg ${(rig.legLength * s).toFixed(3)} m`);
            if (entry.loco) {
                const h = rig.hipsHeight * s;
                console.log(`[tor] gait (anchor scale 1): clips, hips ${h.toFixed(3)} m, natural walk ${(entry.loco.set.walk.speed * h).toFixed(2)} m/s, run ${(entry.loco.set.run.speed * h).toFixed(2)} m/s (playback up to ${WALK_MAX_RATE}x / ${RUN_MAX_RATE}x)`);
            }
        }
    }

    /** Put `assetName` (a character asset in world.json) inside the ball; a missing asset keeps the current animal. */
    async setAnimal(engine: EngineLike, gameData: GameData | null, assetName: string): Promise<void> {
        const token = ++this.loadToken;
        const entry = await this.loadEntry(engine, gameData, assetName);
        if (!entry || token !== this.loadToken) return;
        this.fitAnimal(entry);
        if (this.animalRoot && this.animalRoot !== entry.root) this.anchor.remove(this.animalRoot);
        this.animalRoot = entry.root;
        this.rig = entry.rig;
        this.loco = entry.loco;
        this.anchor.add(entry.root);
        this.shownAnimal = assetName;
        this.pose(0, 0, false, 0);
        this.refreshOutlineWidths();
    }

    /** Curl the tail chain up over the back (a long tail would poke out of the glass) with a little sway. */
    private tailPose(r: AnimalRig, sway: number, curl: number): void {
        const n = r.tail.length;
        for (let i = 0; i < n; i++) r.set(r.tail[i]!, (curl / n) * (1.25 - 0.5 * (i / n)), sway * 0.07, 0);
    }

    /**
     * Run-cycle pose. `speed` is the ball's surface speed (m/s): the glass rolls under the animal at exactly the speed the ball travels, so the feet
     * keep pace with it. One leg cycle covers `stride` metres of surface (two steps of the animal's real leg, scaled to the ball, plus a flight
     * phase when running); the cadence is speed / stride, capped at MAX_CADENCE so the legs stay readable at 60 fps. Two gaits blend by speed:
     * a walk (small swing, upright, gentle arms) and a run (long swing, knees folding on the way forward, lean, pumping arms, bounce).
     */
    private pose(dt: number, speed: number, air: boolean, accel: number): void {
        const r = this.rig;
        if (!r) return;
        if (this.hold) { this.mood = this.hold.mood; this.moodT = this.hold.t; dt = 0; }
        const gait = smooth01((speed - 1.0) / (3.0 - 1.0));          // 0 walk .. 1 run
        const moving = smooth01((speed - 0.05) / 0.55);              // standing still .. walking
        const amp = 0.48 + (0.9 - 0.48) * gait;                      // hip swing (rad)
        const leg = r.legLength * this.animalScale();                // metres, as the animal stands in the ball
        const step = 2 * leg * Math.sin(amp);
        const stride = 2 * step * (1 + 0.7 * gait);                 // the run bounds: a flight phase between footfalls
        const cadence = Math.min(MAX_CADENCE, (Math.PI * 2 * speed) / Math.max(0.05, stride));
        this.phase += dt * (air ? Math.max(cadence, 9) : Math.max(cadence, 2.2 * (1 - moving)));
        const p = this.phase;
        const S = Math.sin(p), C = Math.cos(p);
        r.reset();
        if (this.mood !== 'run') {
            this.moodT += dt;
            const t = this.moodT;
            r.set(BONE.hips, 0.05, Math.sin(t * 3) * 0.12, 0);
            if (this.mood === 'cheer') {
                const b = Math.abs(Math.sin(t * 7));
                r.set(BONE.lArm, -0.2 + Math.sin(t * 9) * 0.25, 0, 2.7); r.set(BONE.rArm, -0.2 - Math.sin(t * 9) * 0.25, 0, -2.7);
                r.set(BONE.lFore, -0.3, 0, 0); r.set(BONE.rFore, -0.3, 0, 0);
                r.set(BONE.lUp, -0.25 * b, 0, -0.08); r.set(BONE.rUp, -0.25 * b, 0, 0.08);
                r.set(BONE.lLeg, 0.4 * b, 0, 0); r.set(BONE.rLeg, 0.4 * b, 0, 0);
                r.set(BONE.head, -0.15 + Math.sin(t * 7) * 0.08, 0, 0);
                r.setHips(0, b * 0.09, 0);
            } else if (this.mood === 'panic') {
                r.set(BONE.lArm, Math.sin(t * 15) * 0.6, 0, 2.5); r.set(BONE.rArm, Math.cos(t * 15) * 0.6, 0, -2.5);
                r.set(BONE.lFore, -0.6 + Math.sin(t * 17) * 0.4, 0, 0); r.set(BONE.rFore, -0.6 + Math.cos(t * 17) * 0.4, 0, 0);
                r.set(BONE.lUp, Math.sin(t * 13) * 0.7, 0, -0.2); r.set(BONE.rUp, Math.cos(t * 13) * 0.7, 0, 0.2);
                r.set(BONE.lLeg, 0.6 + Math.sin(t * 13) * 0.4, 0, 0); r.set(BONE.rLeg, 0.6 + Math.cos(t * 13) * 0.4, 0, 0);
                r.set(BONE.head, 0.1, Math.sin(t * 9) * 0.3, 0);
            } else {   // wave
                r.set(BONE.rArm, -0.1, 0, -2.5 + Math.sin(t * 3) * 0.05); r.set(BONE.rFore, -0.3 + Math.sin(t * 9) * 0.55, 0, 0);
                r.set(BONE.lArm, 0, 0, -1.15); r.set(BONE.lFore, -0.3, 0, 0);
                r.set(BONE.head, 0.05, Math.sin(t * 2) * 0.25, Math.sin(t * 2.4) * 0.08);
                r.setHips(0, Math.sin(t * 2.6) * 0.012, 0);
            }
            this.tailPose(r, Math.sin(t * 4), 1.7);
            r.apply();
            return;
        }
        this.moodT = 0;
        void accel;
        if (this.loco) { this.poseClips(dt, speed, air, r); return; }
        const a = air ? 1 : 0;
        const k = moving * (1 - a);
        // legs: S > 0 swings the left leg forward (-X); the knee folds on the way forward (C > 0 for the left leg) and more so when running
        const swing = amp * S * k;
        const knee = 0.45 + 0.85 * gait;
        const lean = (0.06 + 0.3 * gait) * moving + this.lean;
        r.set(BONE.hips, lean * 0.35 + a * 0.15, 0.1 * S * k, 0);
        r.set(BONE.spine, lean * 0.3, 0, 0);
        r.set(BONE.spine1, lean * 0.2, -0.08 * S * k, 0);
        r.set(BONE.neck, -lean * 0.25, 0, 0);
        r.set(BONE.head, -lean * 0.2, 0, 0);
        r.set(BONE.lUp, -swing - a * 0.5 + 0.04, 0, -0.06);
        r.set(BONE.rUp, swing - a * 0.5 + 0.04, 0, 0.06);
        r.set(BONE.lLeg, (Math.max(0, C) * knee + 0.08 * gait) * k + a * 0.9 + 0.05, 0, 0);
        r.set(BONE.rLeg, (Math.max(0, -C) * knee + 0.08 * gait) * k + a * 0.9 + 0.05, 0, 0);
        r.set(BONE.lFoot, (-0.15 * gait - 0.25 * Math.max(0, -C) * gait) * k, 0, 0);
        r.set(BONE.rFoot, (-0.15 * gait - 0.25 * Math.max(0, C) * gait) * k, 0, 0);
        // arms swing against the legs: loose when walking, bent and pumping when running; up when airborne
        const arm = (0.3 + 0.45 * gait) * S * k;
        r.set(BONE.lArm, -arm * (1 - a), 0, -1.2 + a * 1.5);
        r.set(BONE.rArm, arm * (1 - a), 0, 1.2 - a * 1.5);
        r.set(BONE.lFore, -0.35 - 0.7 * gait * k - 0.3 * gait * Math.max(0, -S) * k - a * 0.3, 0, 0);
        r.set(BONE.rFore, -0.35 - 0.7 * gait * k - 0.3 * gait * Math.max(0, S) * k - a * 0.3, 0, 0);
        // bounce: twice per cycle (each footfall), higher with the run's flight phase
        const bounce = Math.abs(S) * (0.012 + 0.022 * gait) * k;
        this.bob += (bounce - this.bob) * Math.min(1, dt * 20);
        r.setHips(0, this.bob - this.landSquash * 0.03, 0);
        this.tailPose(r, S * (0.5 + gait), 1.7 + 0.25 * gait);
        r.apply();
    }

    /**
     * Locomotion from the engine's clips. The glass rolls under the animal at the ball's surface speed, and the animal plays each clip at the rate
     * that makes its feet keep pace: natural speed = the clip's own root motion scaled to this animal's hip height, rate = speed / natural speed,
     * capped (WALK_MAX_RATE, RUN_MAX_RATE). Idle -> walk -> run blend by speed on one shared stride phase, so a foot that is down in the walk is
     * down in the run too. The tail keeps its curl over the back (the clips have no tail) so it stays inside the glass.
     */
    private poseClips(dt: number, speed: number, air: boolean, r: AnimalRig): void {
        const L = this.loco!;
        const hips = r.hipsHeight * this.animalScale();
        const walkNat = Math.max(0.05, L.set.walk.speed * hips), runNat = Math.max(0.05, L.set.run.speed * hips);
        const moving = smooth01((speed - 0.03) / 0.3);
        const b = smooth01((speed - 1.15 * walkNat) / Math.max(0.01, runNat - 1.15 * walkNat));
        const wDur = L.walk.getClip().duration, rDur = L.run.getClip().duration;
        const rate = ((1 - b) * Math.min(WALK_MAX_RATE, speed / walkNat) / wDur + b * Math.min(RUN_MAX_RATE, speed / runNat) / rDur) * (air ? 0.6 : 1);
        this.cyc = (this.cyc + dt * rate) % 1;
        this.idleT += dt;
        L.idle.time = this.idleT % L.idle.getClip().duration;
        L.walk.time = this.cyc * wDur;
        L.run.time = this.cyc * rDur;
        L.idle.setEffectiveWeight(1 - moving);
        L.walk.setEffectiveWeight(moving * (1 - b));
        L.run.setEffectiveWeight(moving * b);
        L.mixer.update(0);
        const n = r.tail.length, sway = Math.sin(this.cyc * Math.PI * 2) * (0.5 + b), curl = 1.7 + 0.25 * b;
        if (n) r.applyTail((i) => [(curl / n) * (1.25 - 0.5 * (i / n)), sway * 0.07, 0]);
    }

    /** World scale of the animal (its fit to the glass times the look's scale): turns the rig's leg length into metres. */
    private animalScale(): number {
        return (this.animalRoot?.scale.x ?? 1) * this.anchor.scale.x;
    }

    /** Sync to the sim. `stageQuat`: world orientation of the stage (the animal counters it). */
    update(sim: StageSim, dt: number, worldVel: THREE.Vector3, stageQuat: THREE.Quaternion, cameraYaw: number, faceYaw: number | null = null): void {
        this.root.position.set(sim.p.x, sim.p.y, sim.p.z);
        this.shell.quaternion.set(sim.q.x, sim.q.y, sim.q.z, sim.q.w);
        // facing: toward horizontal travel (world), slowly back to the camera heading at rest
        const hs = Math.hypot(worldVel.x, worldVel.z);
        const want = faceYaw !== null ? faceYaw : hs > 0.8 ? Math.atan2(worldVel.x, worldVel.z) : this.facing;
        let d = want - this.facing;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.facing += d * (1 - Math.exp(-dt * 9));
        // animal upright in the world: cancel the stage tilt, then yaw
        qa.copy(stageQuat).invert();
        qb.setFromAxisAngle(AXY, this.facing);
        this.anchor.quaternion.copy(qa).multiply(qb);
        // squash when landing
        const grounded = sim.grounded;
        if (grounded && !this.prevGrounded) this.landSquash = 1;
        this.prevGrounded = grounded;
        this.landSquash *= Math.exp(-dt * 9);
        this.airT = grounded ? 0 : this.airT + dt;
        const air = this.airT > 0.12;
        // the glass rolls under the animal at the ball's own speed (slopes included); in the air the legs just paddle
        const speed = grounded ? Math.hypot(sim.v.x, sim.v.y, sim.v.z) : Math.hypot(sim.v.x, sim.v.z) * 0.6;
        this.pose(dt, speed, air, 0);
        this.ground.update(sim);
        void cameraYaw;
    }
}

/** Fastest leg cycle (rad/s, 10 cycles a second, 6 frames each at 60 fps): beyond it the feet would strobe, so a very fast ball slips a little under them. */
const MAX_CADENCE = Math.PI * 2 * 10;
/** 0..1 smoothstep of an already normalised value. */
function smooth01(x: number): number { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); }

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const AXY = new THREE.Vector3(0, 1, 0);
