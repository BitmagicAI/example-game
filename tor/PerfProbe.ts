/**
 * Debug-only frame profiler for tools/perf.mjs (exposed as window.__tor.probe when the page has ?debug=1).
 * It times the game's per-frame parts and the engine's render call by wrapping the methods (prototypes, so stage swaps keep
 * being measured), and reads renderer.info. Nothing here runs unless the probe is attached.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
interface Span { n: number; sum: number; max: number }

export interface ProbeReport {
    frames: number;
    /** label -> { ms per frame (sum / frames), calls per frame, worst single call } */
    spans: Record<string, { msPerFrame: number; callsPerFrame: number; maxMs: number }>;
    info: { calls: number; triangles: number; geometries: number; textures: number; frame: number; callsPerFrame: number; trianglesPerFrame: number };
}

export class PerfProbe {
    private readonly spans = new Map<string, Span>();
    private readonly wrapped = new Set<string>();
    private running = false;
    private frames = 0;
    private info0 = { calls: 0, triangles: 0, frame: 0 };

    constructor(private readonly game: any, private readonly engine: any) {}

    private wrap(target: any, name: string, label: string): void {
        if (!target || typeof target[name] !== 'function' || this.wrapped.has(label)) return;
        this.wrapped.add(label);
        const orig = target[name] as (...a: unknown[]) => unknown;
        const self = this;
        target[name] = function (this: unknown, ...args: unknown[]): unknown {
            if (!self.running) return orig.apply(this, args);
            const t0 = performance.now();
            try { return orig.apply(this, args); } finally { self.add(label, performance.now() - t0); }
        };
    }

    private add(label: string, ms: number): void {
        let s = this.spans.get(label);
        if (!s) this.spans.set(label, s = { n: 0, sum: 0, max: 0 });
        s.n++; s.sum += ms; if (ms > s.max) s.max = ms;
        if (label === 'engine.render') this.frames++;
    }

    attach(): void {
        const g = this.game;
        const proto = (o: any) => (o ? Object.getPrototypeOf(o) : null);
        this.wrap(g, 'update', 'game.update');
        this.wrap(g, 'syncViews', 'game.syncViews');
        this.wrap(proto(g.sim), 'step', 'sim.step');
        this.wrap(proto(g.view), 'sync', 'stage.sync');
        this.wrap(proto(g.ball), 'update', 'ball.update');
        this.wrap(proto(g.items), 'update', 'items.update');
        this.wrap(proto(g.fx), 'update', 'fx.update');
        this.wrap(proto(g.input), 'update', 'input.update');
        this.wrap(proto(g.cam), 'update', 'cam.update');
        this.wrap(proto(g.hud), 'setTime', 'hud.setTime');
        this.wrap(proto(g.hud), 'setSpeed', 'hud.setSpeed');
        this.wrap(this.engine, 'renderActiveFrame', 'engine.render');
    }

    start(): void {
        this.attach(); this.spans.clear(); this.frames = 0; this.running = true;
        const r = this.engine.renderer?.info?.render;
        this.info0 = { calls: r?.calls ?? 0, triangles: r?.triangles ?? 0, frame: r?.frame ?? 0 };
    }

    stop(): ProbeReport {
        this.running = false;
        const frames = Math.max(1, this.frames);
        const spans: ProbeReport['spans'] = {};
        for (const [k, s] of this.spans) spans[k] = { msPerFrame: +(s.sum / frames).toFixed(3), callsPerFrame: +(s.n / frames).toFixed(2), maxMs: +s.max.toFixed(2) };
        const info = this.engine.renderer?.info;
        const r = info?.render;
        // renderer.info counts every render() of the frame (scene, shadow, post passes) and only resets per its own frame counter: use deltas per engine frame
        const df = Math.max(1, (r?.frame ?? 0) - this.info0.frame);
        const perFrame = (now: number, was: number) => (now >= was ? (now - was) / frames : now);
        return {
            frames: this.frames,
            spans,
            info: {
                calls: r?.calls ?? -1, triangles: r?.triangles ?? -1, geometries: info?.memory?.geometries ?? -1, textures: info?.memory?.textures ?? -1,
                frame: df, callsPerFrame: +perFrame(r?.calls ?? 0, this.info0.calls).toFixed(1), trianglesPerFrame: Math.round(perFrame(r?.triangles ?? 0, this.info0.triangles)),
            },
        };
    }

    /** Every visible mesh with what it costs to draw: for finding out where the draw calls come from. */
    meshList(): Array<Record<string, unknown>> {
        const out: Array<Record<string, unknown>> = [];
        const scene = this.engine.scene;
        scene.traverse((o: any) => {
            if (!o.isMesh) return;
            let vis = o.visible;
            for (let p = o.parent; vis && p; p = p.parent) if (!p.visible) vis = false;
            if (!vis) return;
            const g = o.geometry;
            const tris = Math.round((g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3) * (o.isInstancedMesh ? o.count : 1));
            let root: any = o;
            while (root.parent && root.parent !== scene) root = root.parent;
            let grp = '';
            for (let p = o.parent; p && !grp; p = p.parent) if (typeof p.name === 'string' && p.name.startsWith('A_')) grp = p.name;
            const m = Array.isArray(o.material) ? o.material[0] : o.material;
            out.push({ name: o.name, root: root.name || root.type, group: grp, tris, mat: m?.name || m?.type, matType: m?.type, transparent: !!m?.transparent, cast: !!o.castShadow, recv: !!o.receiveShadow, inst: !!o.isInstancedMesh, skinned: !!o.isSkinnedMesh, frustumCulled: o.frustumCulled });
        });
        return out;
    }

    /** What is in the scene right now: objects, meshes (visible), unique geometries/materials, triangles if everything were drawn. */
    sceneStats(): Record<string, number> {
        const scene = this.engine.scene;
        let objects = 0, meshes = 0, visibleMeshes = 0, skinned = 0, instanced = 0, lights = 0, tris = 0, visTris = 0, transparent = 0, points = 0;
        const geos = new Set<unknown>(), mats = new Set<unknown>();
        scene.traverse((o: any) => {
            objects++;
            if (o.isLight) lights++;
            if (o.isPoints) points++;
            if (!o.isMesh) return;
            meshes++;
            if (o.isSkinnedMesh) skinned++;
            if (o.isInstancedMesh) instanced++;
            const g = o.geometry;
            const n = g?.index ? g.index.count / 3 : (g?.attributes?.position?.count ?? 0) / 3;
            tris += n;
            let vis = o.visible;
            for (let p = o.parent; vis && p; p = p.parent) if (!p.visible) vis = false;
            if (vis) { visibleMeshes++; visTris += n; }
            if (g) geos.add(g);
            const m = o.material;
            for (const mm of Array.isArray(m) ? m : [m]) { if (mm) { mats.add(mm); if (mm.transparent && vis) transparent++; } }
        });
        return { objects, meshes, visibleMeshes, skinned, instanced, lights, points, uniqueGeometries: geos.size, uniqueMaterials: mats.size, transparentVisible: transparent, sceneTris: Math.round(tris), visibleTris: Math.round(visTris) };
    }
}
