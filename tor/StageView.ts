import * as THREE from 'three';
import type { EngineLike, GameData } from 'types/game.js';
import { getAssetUrlByName } from 'types/game.js';
import { parseStageGlb } from '../sim/stageGlb.js';
import { MeshoptDecoder } from './GltfDecoders.js';
import type { StageData } from '../sim/stageData.js';
import type { StageSim } from '../sim/physics.js';
import { comicifyScene, stageGroundMaterial, stageOpaqueMaterial, stageFlatMaterial } from './comic.js';
import { batchStage, lakeParam } from './StageBatch.js';
import { expandFlatMeshes } from './StageExpand.js';
import { isWebGpuActive } from 'engine/render/backend/RendererType.js';
import { activeDeviceQualityTier } from 'engine/quality/DeviceQuality.js';
import { lookForStage, type StageLook } from './looks.js';
import { buildRouteLights } from './RouteLights.js';

/** Where a stage GLB comes from: the registered asset (published games) or the dev-served file. */
export function stageUrl(gameData: GameData | null, name: string): string {
    // ?stagedir=build/level loads a freshly built stage straight from the build folder (tools/ only;
    // does not touch src/, so the creator's dev tab is never reloaded by a stage author's test run)
    const dir = new URLSearchParams(window.location.search).get('stagedir');
    if (dir) return `/${dir.replace(/^\/+|\/+$/g, '')}/${name}.glb`;
    return getAssetUrlByName(gameData, name) ?? `/src/work/stages/${name}.glb`;
}

export interface LoadedStage {
    data: StageData;
    /** The GLB scene (visual meshes, item empties; collision meshes already removed). */
    scene: THREE.Group;
    /** The stage's look (looks.ts), or null when it renders as its world. */
    look: StageLook | null;
}

/** A look's palette and glow colours, written onto the freshly parsed GLB materials (each load parses its own) before they become comic materials. */
function recolor(scene: THREE.Object3D, look: StageLook): void {
    const seen = new Set<THREE.Material>();
    scene.traverse((o) => {
        const mat = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
        if (!(o as THREE.Mesh).isMesh || !mat || Array.isArray(mat) || seen.has(mat)) return;
        seen.add(mat);
        const glow = look.glow?.[mat.name];
        if (glow) { mat.color.set(glow.color); mat.emissive.set(glow.color); mat.emissiveIntensity = glow.intensity; return; }
        const albedo = look.palette?.[mat.name];
        if (albedo) mat.color.set(albedo);
    });
}

const cache = new Map<string, Promise<{ buf: ArrayBuffer }>>();

/**
 * Stage files the pick screen (tools/pick-screen/overlay.src.html) already started downloading while the page's scripts were still loading:
 * a promise of the bytes (null when that download failed). Handed over once; the game then owns the buffer.
 */
function takeEarlyBytes(url: string): Promise<ArrayBuffer | null> | null {
    const pre = (window as unknown as { __torPre?: Record<string, Promise<ArrayBuffer | null> | undefined> }).__torPre;
    const p = pre?.[url];
    if (!p) return null;
    delete pre![url];
    return p;
}

function stageBytes(gameData: GameData | null, name: string, low = false): Promise<{ buf: ArrayBuffer }> {
    const url = stageUrl(gameData, name);
    let p = cache.get(url);
    if (!p) {
        const download = (): Promise<{ buf: ArrayBuffer }> => fetch(url, low ? ({ priority: 'low' } as RequestInit) : undefined).then(async (r) => {
            if (!r.ok) throw new Error(`stage ${name}: HTTP ${r.status} for ${url}`);
            return { buf: await r.arrayBuffer() };
        });
        const early = takeEarlyBytes(url);
        p = early ? early.then((buf) => (buf ? { buf } : download())) : download();   // an early download that failed is simply requested again here
        p.catch(() => cache.delete(url));   // a failed download is retried by the next request instead of being remembered
        cache.set(url, p);
        while (cache.size > 3) cache.delete(cache.keys().next().value!);   // only a stage or two ahead is worth keeping; the browser cache holds the rest
    }
    return p;
}

/** Resolves when a stage's bytes are here (or their download failed): lets other downloads start in the idle time the stage's CPU-bound setup (parse, batching, GPU warm-up) leaves on the link. */
export function whenStageBytes(gameData: GameData | null, name: string): Promise<void> {
    return stageBytes(gameData, name).then(() => undefined, () => undefined);
}

/** Start downloading a stage's GLB now; loadStageAsset picks the same request up later (nothing is downloaded twice). `low` = do not compete with what is on screen. */
export function prefetchStageBytes(gameData: GameData | null, name: string, low = false): void {
    void stageBytes(gameData, name, low).catch(() => { /* loadStageAsset reports it when the stage is really needed */ });
}

export async function loadStageAsset(engine: EngineLike, gameData: GameData | null, name: string): Promise<LoadedStage> {
    const { buf } = await stageBytes(gameData, name);
    cache.delete(stageUrl(gameData, name));   // consumed: the parsed data lives on in the stage; keeping 3 MB per stage ever played would add up
    const t0 = performance.now();
    await MeshoptDecoder.ready;   // resolves at once when the WASM is already up (and the file may not need it at all)
    const data = parseStageGlb(buf, { meshopt: MeshoptDecoder });
    const t1 = performance.now();
    // GLTFLoader may detach the buffer it parses, so give it its own copy
    const gltf = await (engine.loader as { parseAsync(d: ArrayBuffer, path: string): Promise<{ scene: THREE.Group }> }).parseAsync(buf.slice(0), '');
    const scene = gltf.scene;
    const t2 = performance.now();
    const rebuilt = expandFlatMeshes(scene);   // flat-shaded meshes are stored without normals (see StageExpand.ts)
    if (new URLSearchParams(window.location.search).has('debug')) console.log(`[tor] stage ${name} load: ${(buf.byteLength / 1024).toFixed(0)} KB, collision parse ${(t1 - t0).toFixed(0)} ms, glTF parse (incl. meshopt decode) ${(t2 - t1).toFixed(0)} ms, flat normals rebuilt for ${rebuilt} meshes in ${(performance.now() - t2).toFixed(0)} ms`);
    const look = lookForStage(name, data.world);
    if (look) recolor(scene, look);
    comicifyScene(scene);
    const kill: THREE.Object3D[] = [];
    scene.traverse((o) => { if (o.name.startsWith('C_')) kill.push(o); });
    for (const o of kill) {
        o.parent?.remove(o);
        (o as THREE.Mesh).geometry?.dispose();
    }
    return { data, scene, look };
}

/**
 * The rendered stage: the GLB scene under a root that the sim tilts, animated groups posed from
 * the sim every frame, and the per-item objects (candy, gate...) that need runtime behaviour.
 */
export class StageView {
    /** Tilt root: the sim's stage quaternion is applied here. Everything in stage coordinates lives under it. */
    readonly root = new THREE.Group();
    /** Stage content (the GLB scene). */
    readonly content: THREE.Object3D;
    readonly data: StageData;
    private animNodes: (THREE.Object3D | null)[];
    readonly candyObjects = new Map<number, THREE.Object3D>();
    /** The far-lake mesh(es) split off by batchStage (stage b09), and whether they currently use the noise-free material. */
    private lakeMeshes: THREE.Mesh[] = [];
    private lakeFlat = false;

    constructor(loaded: LoadedStage) {
        this.data = loaded.data;
        this.content = loaded.scene;
        this.root.add(this.content);
        this.content.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
        });
        this.animNodes = this.data.groups.map((g, i) => (i === 0 ? null : this.content.getObjectByName(g.nodeName) ?? null));
        this.root.position.set(0, 0, 0);
        if (new URLSearchParams(window.location.search).get('batch') !== '0') {   // ?batch=0 keeps the meshes as authored (for A/B comparisons)
            const t0 = performance.now();
            const st = batchStage(this.content, new Set(this.animNodes.filter((n): n is THREE.Object3D => !!n)), stageOpaqueMaterial(), isWebGpuActive(), loaded.look?.warmLight ?? null, stageGroundMaterial());
            this.lakeMeshes = st.lake;
            console.log(`[tor] stage batched: ${st.meshesBefore} meshes -> ${st.meshesAfter} (${st.merged} merged batches, ${st.kept} kept) in ${(performance.now() - t0).toFixed(0)} ms`);
            this.applyLakeQuality();
        }
        if (loaded.look?.routeLights) {
            const lights = buildRouteLights(this.data, loaded.look.routeLights, (gi) => this.nodeForGroup(gi));
            if (new URLSearchParams(window.location.search).has('debug')) console.log(`[tor] route lights: ${lights.map((m) => `${m.name} ${m.geometry.index!.count / 3} tris`).join(', ') || 'none'}`);
        }
    }

    /**
     * The 480 m lake of stage b09 covers most of the screen, so its painterly noise is the biggest single per-pixel cost of any stage. On the top
     * quality tier (`ultra`) it is drawn as authored; on every rung below (the engine's own auto tuner steps a device down when it cannot hold its
     * frame rate, phones start lower) it uses the noise-free material, which only loses the faint brush streaks on the far water. `?lake=full` /
     * `?lake=flat` force one or the other.
     */
    private applyLakeQuality(): void {
        const p = lakeParam();
        const flat = p === 'flat' || (p === 'auto' && activeDeviceQualityTier() !== 'ultra');
        if (flat === this.lakeFlat && this.lakeMeshes[0]?.material === (flat ? stageFlatMaterial() : stageOpaqueMaterial())) return;
        this.lakeFlat = flat;
        const m = flat ? stageFlatMaterial() : stageOpaqueMaterial();
        for (const l of this.lakeMeshes) l.material = m;
    }

    /** Object that animated-group children should attach to (group node, or the static content). */
    nodeForGroup(gi: number): THREE.Object3D {
        return (gi > 0 ? this.animNodes[gi] : null) ?? this.content;
    }

    /** Pose animated groups and tilt the root from the sim state. The stage tilts about the ball (see StageSim.toWorld). */
    sync(sim: StageSim): void {
        if (this.lakeMeshes.length) this.applyLakeQuality();
        const q = sim.stageQuat, b = sim.p;
        this.root.quaternion.set(q.x, q.y, q.z, q.w);
        this.root.position.set(b.x, b.y, b.z);
        this.content.position.set(-b.x, -b.y, -b.z);
        for (let i = 1; i < this.animNodes.length; i++) {
            const n = this.animNodes[i];
            if (!n) continue;
            const gs = sim.gstate[i]!;
            n.position.set(gs.pos1.x, gs.pos1.y, gs.pos1.z);
            n.quaternion.set(gs.quat1.x, gs.quat1.y, gs.quat1.z, gs.quat1.w);
        }
    }

    dispose(): void {
        this.root.removeFromParent();
        this.root.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) m.geometry?.dispose();   // materials are shared across stages (comic.ts sessionMaterials) and stay compiled
        });
    }
}
