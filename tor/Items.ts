import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { StageItem } from '../sim/stageData.js';
import type { StageSim } from '../sim/physics.js';
import type { StageView } from './StageView.js';
import { createComicMaterial } from './comic.js';

/**
 * Runtime visuals for stage items: wrapped candy (single), candy buckets (x10). They live under the
 * item's own group (so candy on a spinning disc rides it), spin and bob, and disappear when the sim
 * says they were collected.
 */
const PALETTE = ['#ff5fa8', '#37d0ff', '#9cff4a', '#ffd534', '#ff8a2a', '#b47cff'];

function candyGeometry(): THREE.BufferGeometry {
    const body = new THREE.SphereGeometry(0.17, 14, 10);
    body.scale(1.55, 0.95, 0.95);
    const parts: THREE.BufferGeometry[] = [body];
    for (const sgn of [-1, 1]) {
        const twist = new THREE.ConeGeometry(0.16, 0.24, 10, 1, true);
        twist.rotateZ(sgn * Math.PI / 2);
        twist.translate(sgn * 0.36, 0, 0);
        parts.push(twist);
        const tip = new THREE.CylinderGeometry(0.02, 0.02, 0.06, 6);
        tip.rotateZ(Math.PI / 2);
        tip.translate(sgn * 0.5, 0, 0);
        parts.push(tip);
    }
    const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
    g.computeVertexNormals();
    return g;
}

function bucketGeometry(): THREE.BufferGeometry {
    const cup = new THREE.CylinderGeometry(0.52, 0.4, 0.62, 16, 1, true);
    cup.translate(0, -0.05, 0);
    const base = new THREE.CircleGeometry(0.4, 16);
    base.rotateX(Math.PI / 2);
    base.translate(0, -0.36, 0);
    const rim = new THREE.TorusGeometry(0.52, 0.045, 6, 20);
    rim.rotateX(Math.PI / 2);
    rim.translate(0, 0.26, 0);
    const handle = new THREE.TorusGeometry(0.5, 0.03, 6, 20, Math.PI);
    handle.translate(0, 0.26, 0);
    const parts = [cup, base, rim, handle].map((p) => (p.index ? p.toNonIndexed() : p));
    const g = mergeGeometries(parts)!;
    g.computeVertexNormals();
    return g;
}

/** A swirling vortex painted into a canvas: magenta / violet / cyan spiral arms between dark gaps, a bright core, an ink rim. */
function vortexTexture(): THREE.CanvasTexture {
    const N = 256;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(N, N);
    // 3 arms x 2 bands = 6 bands around the circle, so the palette length must divide 6 or a seam shows at the branch cut
    const pal: [number, number, number][] = [[255, 70, 214], [140, 70, 255], [70, 205, 255], [255, 70, 214], [140, 70, 255], [70, 205, 255]];
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const dx = (x + 0.5) / N * 2 - 1, dy = (y + 0.5) / N * 2 - 1;
            const r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
            let R = 0, G = 0, B = 0, A = 255;
            if (r > 1) { A = 0; } else {
                const s = ((th / (Math.PI * 2)) * 3 + r * 2.4 + 8) % 1;
                const band = 0.5 + 0.5 * Math.sin(s * Math.PI * 2);
                const k = Math.floor(((th / (Math.PI * 2)) * 3 + r * 2.4 + 8) * 2) % pal.length;
                const col = pal[Math.abs(k)]!;
                const dark = Math.pow(1 - band, 2.2);                       // dark gaps between the arms
                const core = Math.max(0, 1 - r / 0.28);                     // hot core
                const rim = r > 0.9 ? Math.min(1, (r - 0.9) / 0.1) : 0;     // ink rim
                const m = (1 - dark * 0.82) * (1 - rim);
                R = col[0] * m * 0.85 + 255 * core * 0.85; G = col[1] * m * 0.85 + 240 * core * 0.85; B = col[2] * m * 0.85 + 255 * core * 0.85;
                R = Math.min(255, R + 14 * (1 - rim)); G = Math.min(255, G + 4 * (1 - rim)); B = Math.min(255, B + 30 * (1 - rim));
                R *= 1 - rim * 0.9; G *= 1 - rim * 0.9; B *= 1 - rim * 0.9;
            }
            const i = (y * N + x) * 4;
            img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = A;
        }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}

/** One candy in an InstancedMesh: where it hangs (in its group's frame), its bob phase and whether the sim collected it. */
interface CandySlot { id: number; mesh: THREE.InstancedMesh; index: number; group: number; base: THREE.Vector3; phase: number; gone: boolean }

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _eul = new THREE.Euler(0, 0, 0.5, 'XYZ');
const _scl = new THREE.Vector3(1.55, 1.55, 1.55);
const _zero = new THREE.Vector3(0, 0, 0);
const _mat = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);

/**
 * A stage look's candy (looks.ts `candy`): emission and saturation scaled from the authored values, so ordinary candy stops competing with the
 * player. Material properties only (no recompile); null restores the authored candy exactly.
 */
let candyLook: { emissive: number; saturation: number } | null = null;
export function setCandyLook(look: { emissive: number; saturation: number } | null): void {
    candyLook = look;
    applyCandyLook();
}
function applyCandyLook(): void {
    const c = new THREE.Color(), hsl = { h: 0, s: 0, l: 0 };
    candyMats?.forEach((m, i) => {
        const mm = m as THREE.MeshToonMaterial;
        c.set(PALETTE[i]!);
        if (candyLook) { c.getHSL(hsl); c.setHSL(hsl.h, hsl.s * candyLook.saturation, hsl.l); }
        mm.color.copy(c);
        if (mm.emissive) mm.emissive.copy(c);
        mm.emissiveIntensity = 1.35 * (candyLook?.emissive ?? 1);
    });
    const b = bucketMaterial as THREE.MeshToonMaterial | null;
    if (b) b.emissiveIntensity = 0.9 * (candyLook?.emissive ?? 1);
}

/** Candy and bucket materials, created once per session (see comic.ts sessionMaterials: one pipeline per material instance). */
let candyMats: THREE.Material[] | null = null;
let bucketMaterial: THREE.Material | null = null;
let vortexTexShared: THREE.CanvasTexture | null = null;
let vortexMatShared: THREE.Material | null = null;
let candyGeo: THREE.BufferGeometry | null = null;

/**
 * The six candy InstancedMeshes (one per palette colour) live for the whole session and move from stage to stage. three.js keys an InstancedMesh's
 * render object (WGSL, pipeline) on the object's uuid, so a mesh created per stage compiled 12 pipelines (main + shadow) on every stage swap; these
 * six compile once. `capacity` is how many instances the buffer holds; a stage that needs more replaces the entry (rare, and compiled once more).
 */
interface PoolEntry { mesh: THREE.InstancedMesh; capacity: number }
let candyPool: PoolEntry[] | null = null;
let poolOwner: ItemsView | null = null;
const POOL_CAPACITY = Number(new URLSearchParams(window.location.search).get('candycap')) || 24;   // ?candycap=3 exercises the grow path

function poolEntry(i: number, need: number): PoolEntry {
    candyPool ??= [];
    let e = candyPool[i];
    if (!e || e.capacity < need) {
        e?.mesh.removeFromParent(); e?.mesh.dispose();
        const capacity = Math.max(POOL_CAPACITY, need + 8);
        const mesh = new THREE.InstancedMesh(candyGeo!, candyMats![i]!, capacity);
        mesh.name = `candy${i}`;
        mesh.castShadow = true;
        mesh.frustumCulled = false;                       // the instances spread over the whole stage; a stage-sized sphere would never cull anyway
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = 0;
        e = candyPool[i] = { mesh, capacity };
    }
    return e;
}

export class ItemsView {
    private colors = new Map<number, string>();
    colorOf(id: number): string { return this.colors.get(id) ?? '#ffd534'; }
    /** Buckets (one per stage, with their heaped candy) are plain object trees; single candies are instances (see below). */
    private objs = new Map<number, { obj: THREE.Object3D; base: THREE.Vector3; phase: number; kind: 'bucket' }>();
    /**
     * Single candies: one InstancedMesh per (stage group, palette colour) instead of one Mesh per candy. A stage carries 40-80 candies, and each
     * used to cost a draw call in the main pass AND in the shadow pass (up to 156 of e10's 331 draws), a scene-graph node pair and an Euler->quaternion
     * update per frame. The look is unchanged: same geometry, same six materials, same bob and spin (the instance matrix is the old Group * Mesh
     * transform: position + bob, then Ry(spin) * Rz(0.5), scale 1.55).
     */
    private slots: CandySlot[] = [];
    private groupUsed = new Set<number>();
    private sharedBucket = bucketGeometry();
    private get sharedCandy(): THREE.BufferGeometry { return candyGeo!; }
    private mats: THREE.Material[];
    private bucketMat: THREE.Material;
    private portals: { spin: THREE.Object3D; disc: THREE.Object3D; phase: number }[] = [];

    constructor(private view: StageView, sim: StageSim) {
        candyGeo ??= candyGeometry();
        candyMats ??= PALETTE.map((c) => createComicMaterial({ color: c, emissive: c, emissiveIntensity: 1.35, paint: 0 }));
        bucketMaterial ??= createComicMaterial({ color: '#ff8a1f', emissive: '#ff7a10', emissiveIntensity: 0.9, side: THREE.DoubleSide, paint: 0 });
        if (candyLook) applyCandyLook();
        this.mats = candyMats;
        this.bucketMat = bucketMaterial;
        this.buildCandy(sim);
        for (const it of sim.stage.items) if (it.kind === 'wormhole' && it.extras.target) this.spawnPortal(it);   // a one-way exit is just a landing pad
    }

    /** The wormhole's swirling face: a disc just above the deck that turns, over the kit's static ring and posts. */
    private spawnPortal(it: StageItem): void {
        if (!vortexMatShared) {
            vortexTexShared = vortexTexture();
            vortexMatShared = new THREE.MeshBasicMaterial({ map: vortexTexShared, toneMapped: false });
        }
        const r = Number(it.extras.radius ?? 1.1) * 1.08;
        const spin = new THREE.Group();
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 48), vortexMatShared);
        disc.rotation.x = -Math.PI / 2;
        spin.add(disc);
        spin.position.set(it.pos.x, it.pos.y - 0.5 + 0.13, it.pos.z);
        this.view.nodeForGroup(it.group).add(spin);
        this.portals.push({ spin, disc, phase: it.id * 0.7 });
    }

    /** Every candy of the stage becomes an instance of one of the six pooled meshes; buckets keep their object tree. */
    private buildCandy(sim: StageSim): void {
        // pass 1: how many of each colour, so the pooled meshes are big enough
        const need = new Array<number>(this.mats.length).fill(0);
        let n = 0;
        for (const it of sim.candies) { if (it.kind !== 'bucket') need[n % this.mats.length]!++; n++; }
        const next = new Array<number>(this.mats.length).fill(0);
        poolOwner?.releasePool();
        poolOwner = this;
        const entries = need.map((k, i) => poolEntry(i, k));
        n = 0;
        for (const it of sim.candies) {
            if (it.kind === 'bucket') { this.spawnBucket(it, n++); continue; }
            const ci = n % this.mats.length;
            const mesh = entries[ci]!.mesh;
            this.colors.set(it.id, PALETTE[ci]!);
            const slot: CandySlot = { id: it.id, mesh, index: next[ci]!++, group: it.group, base: new THREE.Vector3(it.pos.x, it.pos.y, it.pos.z), phase: n * 0.9, gone: false };
            this.slots.push(slot);
            this.groupUsed.add(it.group);
            this.writeCandy(slot, 0, 0, null);                    // the true starting pose, so the first frame is right even before update()
            n++;
        }
        entries.forEach((e, i) => {
            e.mesh.count = need[i]!;
            e.mesh.visible = need[i]! > 0;
            e.mesh.instanceMatrix.needsUpdate = true;
            this.view.content.add(e.mesh);
        });
    }

    /** Give the pooled meshes back (this stage is going away, or the next stage is about to take them). */
    private releasePool(): void {
        if (poolOwner !== this) return;
        for (const e of candyPool ?? []) { e.mesh.removeFromParent(); e.mesh.count = 0; }
        poolOwner = null;
    }

    /** Instance matrix = (group pose) * (position + bob) * Ry(spin) * Rz(0.5) * scale 1.55. Candy on a mover rides it: `gm` is the mover's pose in stage space. */
    private writeCandy(s: CandySlot, bob: number, spin: number, gm: THREE.Matrix4 | null): void {
        _pos.set(s.base.x, s.base.y + bob, s.base.z);
        _eul.set(0, spin, 0.5, 'XYZ');
        _quat.setFromEuler(_eul);
        _mat.compose(_pos, _quat, _scl);
        if (gm) _mat.premultiply(gm);
        s.mesh.setMatrixAt(s.index, _mat);
    }

    private spawnBucket(it: StageItem, n: number): void {
        const parent = this.view.nodeForGroup(it.group);
        const g = new THREE.Group();
        this.colors.set(it.id, '#ff9a2a');
        const m = new THREE.Mesh(this.sharedBucket, this.bucketMat);
        m.castShadow = true;
        g.add(m);
        // heaped candy on top
        for (let i = 0; i < 9; i++) {
            const a = i * 2.4;
            const c = new THREE.Mesh(this.sharedCandy, this.mats[i % this.mats.length]);
            c.scale.setScalar(0.62);
            c.position.set(Math.cos(a) * 0.22, 0.34 + (i % 3) * 0.06, Math.sin(a) * 0.22);
            c.rotation.set(i, a, i * 0.7);
            g.add(c);
        }
        g.position.set(it.pos.x, it.pos.y, it.pos.z);
        parent.add(g);
        this.objs.set(it.id, { obj: g, base: g.position.clone(), phase: n * 0.9, kind: 'bucket' });
    }

    private groupMats = new Map<number, THREE.Matrix4>();

    /** Spin + bob, hide what the sim collected. (`cam` is kept for billboarded extras; the candy glow comes from bloom.) */
    update(sim: StageSim, time: number, _cam: THREE.Camera): void {
        // pose of every mover that carries candy (stage space; StageView.sync has just set the nodes from the sim)
        for (const g of this.groupUsed) {
            if (g <= 0) continue;
            const node = this.view.nodeForGroup(g);
            let m = this.groupMats.get(g);
            if (!m) this.groupMats.set(g, m = new THREE.Matrix4());
            m.compose(node.position, node.quaternion, _one);
        }
        for (const s of this.slots) {
            const gone = sim.collected.has(s.id);
            if (gone) {
                if (!s.gone) { s.gone = true; s.mesh.setMatrixAt(s.index, _mat.compose(_pos.set(0, -1e4, 0), _quat.identity(), _zero)); }
                continue;
            }
            s.gone = false;
            const t = time * 2.2 + s.phase;
            this.writeCandy(s, Math.sin(t) * 0.09, t * 0.9, s.group > 0 ? this.groupMats.get(s.group) ?? null : null);
        }
        if (this.slots.length) for (const e of candyPool ?? []) if (e.mesh.count > 0) e.mesh.instanceMatrix.needsUpdate = true;
        for (const [id, o] of this.objs) {
            const gone = sim.collected.has(id);
            o.obj.visible = !gone;
            if (gone) continue;
            const t = time * 2.2 + o.phase;
            o.obj.position.y = o.base.y + Math.sin(t) * 0.09;
            o.obj.rotation.y = time * 0.8;
        }
        for (const p of this.portals) {
            p.spin.rotation.y = -time * 1.7 - p.phase;
            p.disc.scale.setScalar(1 + Math.sin(time * 3.1 + p.phase) * 0.035);
        }
    }

    private legacy: THREE.Group[] = [];
    /** Debug (tools/ab.mjs): draw the candy the way it was drawn before instancing (one Group + Mesh each) so a frame can be compared pixel by pixel. */
    debugLegacy(on: boolean, sim: StageSim, time: number): number {
        for (const g of this.legacy) g.removeFromParent();
        this.legacy.length = 0;
        for (const e of candyPool ?? []) e.mesh.visible = !on && e.mesh.count > 0;
        if (!on) return 0;
        this.update(sim, time, null as unknown as THREE.Camera);
        const inst = new THREE.Matrix4();
        for (const s of this.slots) {
            if (s.gone) continue;
            const g = new THREE.Group();
            const m = new THREE.Mesh(this.sharedCandy, s.mesh.material);
            m.castShadow = true;
            g.add(m);
            s.mesh.getMatrixAt(s.index, inst);
            inst.decompose(g.position, g.quaternion, g.scale);   // the pair collapses to one transform; the mesh keeps identity, so what is compared is the draw path, not the maths
            this.view.content.add(g);
            this.legacy.push(g);
        }
        return this.legacy.length;
    }

    /** Debug (tools): the largest difference between every candy instance and the transform the old Group * Mesh pair gave it at `time`. */
    debugCheck(sim: StageSim, time: number): { candies: number; moving: number; maxDiff: number } {
        this.update(sim, time, null as unknown as THREE.Camera);
        const g = new THREE.Group(), m = new THREE.Mesh();
        g.add(m);
        let maxDiff = 0;
        const inst = new THREE.Matrix4();
        for (const s of this.slots) {
            if (s.gone) continue;
            const t = time * 2.2 + s.phase;
            g.position.set(s.base.x, s.base.y + Math.sin(t) * 0.09, s.base.z);
            m.rotation.set(0, 0, 0.5); m.scale.setScalar(1.55); m.rotation.y = t * 0.9;
            const holder = new THREE.Group();                    // the old tree: candy Group under its mover's node (or the stage content)
            if (s.group > 0) { const n = this.view.nodeForGroup(s.group); holder.position.copy(n.position); holder.quaternion.copy(n.quaternion); }
            holder.add(g);
            holder.updateMatrixWorld(true);
            s.mesh.getMatrixAt(s.index, inst);
            for (let i = 0; i < 16; i++) maxDiff = Math.max(maxDiff, Math.abs(inst.elements[i]! - m.matrixWorld.elements[i]!));
            holder.remove(g);
        }
        return { candies: this.slots.length, moving: this.slots.filter((x) => x.group > 0).length, maxDiff };
    }

    dispose(): void {
        for (const o of this.objs.values()) o.obj.removeFromParent();
        this.objs.clear();
        this.releasePool();
        this.slots.length = 0;
        this.sharedBucket.dispose();
        for (const p of this.portals) { p.spin.removeFromParent(); (p.disc as THREE.Mesh).geometry.dispose(); }
        this.portals.length = 0;
    }
}
