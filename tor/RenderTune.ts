/**
 * Render-cost tuning that keeps the picture the same.
 *
 * The engine assembles the post chain (GameEnginePostFx.ts) and only exposes the AO radius / intensity. The GTAO node it builds runs at FULL
 * resolution with 16 samples, which made it the most expensive pass of the frame by far (measured on an M3 Max: 2.2 ms of 4.9 ms GPU at 720p, 5.2 of 8.2 at
 * 1440p; the sky is discarded early, so it scales with the pixels the stage covers). three's own documentation for GTAONode says a resolutionScale of 0.5
 * "should be sufficient for most scenes", and here the AO is soft contact darkening under a 2 px ink outline: a frame-by-frame comparison against full
 * resolution differs by 0.25-0.55 levels of 255 on average (dither-level noise structure, no shape change).
 *
 * The WebGL fallback chain (classic GTAOPass, which also renders the scene a second time for normals) gets the same treatment; there AO was about half of
 * the frame at 3024x1964 (39 ms -> 21 ms without it).
 *
 * `?ao=full` restores the engine's full-resolution AO (for comparisons), `?ao=0.75` or any 0.25..1 value picks another scale.
 */
import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';

interface NodeLike { traverse?: (cb: (n: unknown) => void) => void }
interface GtaoLike { resolutionScale: number; samples?: { value: number } }
/** three's classic GTAOPass (the WebGL fallback chain). */
interface GtaoPassLike { setSize(w: number, h: number): void; __torScale?: { v: number } }

const isGtao = (n: unknown): n is GtaoLike => {
    const c = (n as { constructor?: { type?: string } } | null)?.constructor;
    return c?.type === 'GTAONode';
};

export function aoScaleFromUrl(): number {
    try {
        const v = new URLSearchParams(window.location.search).get('ao');
        if (v === 'full') return 1;
        const n = Number(v);
        if (v !== null && Number.isFinite(n) && n >= 0.25 && n <= 1) return n;
    } catch { /* no window */ }
    return 0.5;
}

export class RenderTune {
    private pipeline: unknown = null;
    private failed = false;
    aoScale = aoScaleFromUrl();

    constructor(private readonly engine: EngineLike) {}

    /** Call once per frame: does work only when the engine has (re)built its post pipeline. */
    update(): void {
        if (this.failed) return;
        const eng = this.engine as unknown as { bloomPipeline?: { outputNode?: NodeLike } | null; gtaoPass?: GtaoPassLike | null };
        const bp = eng.bloomPipeline ?? null;
        const gp = eng.gtaoPass ?? null;
        if (bp === this.pipeline && gp === this.classic) return;
        this.pipeline = bp;
        this.classic = gp;
        if (bp || gp) this.apply();
    }
    private classic: unknown = null;

    /** WebGL fallback: the composer resizes GTAOPass to the full drawing buffer on every resize, so its setSize is wrapped to ask for the scaled size. */
    private applyClassic(): void {
        const eng = this.engine as unknown as { gtaoPass?: GtaoPassLike | null; renderer?: { getDrawingBufferSize?: (v: THREE.Vector2) => unknown } };
        const gp = eng.gtaoPass;
        if (!gp) return;
        if (!gp.__torScale) {
            const box = gp.__torScale = { v: this.aoScale };
            const orig = gp.setSize.bind(gp);
            gp.setSize = (w: number, h: number) => orig(Math.max(1, Math.round(w * box.v)), Math.max(1, Math.round(h * box.v)));
        }
        gp.__torScale.v = this.aoScale;
        const size = new THREE.Vector2();
        eng.renderer?.getDrawingBufferSize?.(size);
        if (size.x > 0) gp.setSize(size.x, size.y);
    }

    /** Re-apply now (after changing `aoScale` at runtime). */
    apply(): void {
        const bp = (this.engine as unknown as { bloomPipeline?: { outputNode?: NodeLike } | null }).bloomPipeline;
        const root = bp?.outputNode;
        try {
            const seen = new Set<unknown>();
            root?.traverse?.((n) => {
                if (isGtao(n) && !seen.has(n)) { seen.add(n); n.resolutionScale = this.aoScale; }
            });
            this.applyClassic();
        } catch (e) {
            this.failed = true;
            console.warn('[tor] render tuning skipped:', e);
        }
    }
}
