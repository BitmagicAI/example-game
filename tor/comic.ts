// @ts-nocheck -- TSL shader-graph code: three's node typings are incomplete; names are verified at module link time
import * as THREE from 'three';
import { LightingModel, MeshStandardNodeMaterial, MeshToonNodeMaterial } from 'three/webgpu';
import {
    Fn, float, vec2, vec3, vec4, uniform, dot, smoothstep, mix, pow, saturate, normalView, positionView, positionLocal,
    diffuseColor, screenCoordinate, fract, length, max, step, mx_fractal_noise_float, mx_noise_float, sin, cos, materialColor, attribute,
} from 'three/tsl';
import { isWebGpuActive } from 'engine/render/backend/RendererType.js';
import { EMIT_SCALE } from './StageBatch.js';

/**
 * The comic-book look, as a material. One lighting model shared by everything in the stage:
 *
 *   - banded light (shadow / mid / lit tones) with anti-aliased band edges, driven by the scene's own
 *     sun, so the real shadow maps still cut the bands;
 *   - hue-shifted shadows: the shadow band is tinted (violet in warm light) rather than just darkened;
 *   - a halftone dot screen in the darkest band, like a printed comic;
 *   - a coloured rim light that lifts silhouettes off the background;
 *   - painterly albedo: world-independent (stage-local) fractal noise breaks flat colours up.
 *
 * WebGPU uses TSL (this file). The classic WebGL renderer gets `MeshToonMaterial` with a 3-tone ramp:
 * same banding and colours, without the halftone / rim / paint (see createComicMaterial).
 *
 * All look parameters are shared uniforms (`comicStyle`) so a world (patch / graveyard / workshop)
 * re-themes every material at once with `setComicStyle`.
 */

export interface ComicStyleValues {
    shadow: string;      // multiplier tint of the shadow band (albedo * tint)
    mid: string;
    lit: string;
    rim: string;
    rimAmount: number;
    halftone: number;    // 0..1 strength of dots in the shadow band
    dotSize: number;     // px per dot cell
    bandLo: number;      // terminator between shadow and mid
    bandHi: number;      // between mid and lit
    paint: number;       // albedo noise amplitude
    ink: string;         // colour the dots print in
}

export const DEFAULT_STYLE: ComicStyleValues = {
    shadow: '#7a55b8', mid: '#f0c9d0', lit: '#ffffff', rim: '#ffb070', rimAmount: 0.5,
    halftone: 0.7, dotSize: 7, bandLo: 0.30, bandHi: 0.68, paint: 0.14, ink: '#2a1240',
};

const U = {
    shadow: uniform(new THREE.Color(DEFAULT_STYLE.shadow)),
    mid: uniform(new THREE.Color(DEFAULT_STYLE.mid)),
    lit: uniform(new THREE.Color(DEFAULT_STYLE.lit)),
    rim: uniform(new THREE.Color(DEFAULT_STYLE.rim)),
    ink: uniform(new THREE.Color(DEFAULT_STYLE.ink)),
    rimAmount: uniform(DEFAULT_STYLE.rimAmount),
    halftone: uniform(DEFAULT_STYLE.halftone),
    dotSize: uniform(DEFAULT_STYLE.dotSize),
    bandLo: uniform(DEFAULT_STYLE.bandLo),
    bandHi: uniform(DEFAULT_STYLE.bandHi),
    paint: uniform(DEFAULT_STYLE.paint),
};

/**
 * Character shading (the animal in the ball), separate from the stage's: a fill light that lifts it out of shadow and a lean of its albedo toward
 * warm cream so it reads against purple surroundings. Classic: fill white x 0.2 (the animals' old `selfLight`), no cream, so nothing changes.
 */
const CU = {
    fill: uniform(new THREE.Color(0.2, 0.2, 0.2)),
    /** 0..1: how far the character's direct light and tone bands lose the scene's tint (classic 0: lit exactly like the stage). */
    neutral: uniform(0),
    cream: uniform(0),
    creamColor: uniform(new THREE.Color('#f6e2c0')),
    /** Saturation of the animal's own colours (1 = as painted: mix(luma, c, 1) is c exactly). */
    saturation: uniform(1),
};
const characterGL = new Set<THREE.MeshToonMaterial>();
const smoothGL = new Set<THREE.MeshStandardMaterial>();

export function setCharacterShading(v: { fill: string; fillAmount: number; cream: number; creamColor: string; neutral: number; saturation?: number } | null): void {
    if (v) { CU.fill.value.set(v.fill).multiplyScalar(v.fillAmount); CU.cream.value = v.cream; CU.creamColor.value.set(v.creamColor); CU.neutral.value = v.neutral; CU.saturation.value = v.saturation ?? 1; }
    else { CU.fill.value.setRGB(0.2, 0.2, 0.2); CU.cream.value = 0; CU.neutral.value = 0; CU.saturation.value = 1; }
    // WebGL fallback (no fill term there): lean the material colour toward cream instead
    for (const m of characterGL) m.color.setRGB(1, 1, 1).lerp(CU.creamColor.value, CU.cream.value * 1.5);
    for (const m of smoothGL) { m.color.copy(m.userData.baseColor as THREE.Color).lerp(CU.creamColor.value, CU.cream.value * 1.5); m.emissive.copy(CU.fill.value); }
}

/** Re-theme every comic material (both renderers). Values you omit keep their current setting. */
export function setComicStyle(v: Partial<ComicStyleValues>): void {
    if (v.shadow) U.shadow.value.set(v.shadow);
    if (v.mid) U.mid.value.set(v.mid);
    if (v.lit) U.lit.value.set(v.lit);
    if (v.rim) U.rim.value.set(v.rim);
    if (v.ink) U.ink.value.set(v.ink);
    if (v.rimAmount !== undefined) U.rimAmount.value = v.rimAmount;
    if (v.halftone !== undefined) U.halftone.value = v.halftone;
    if (v.dotSize !== undefined) U.dotSize.value = v.dotSize;
    if (v.bandLo !== undefined) U.bandLo.value = v.bandLo;
    if (v.bandHi !== undefined) U.bandHi.value = v.bandHi;
    if (v.paint !== undefined) U.paint.value = v.paint;
    gradientMap = null; // rebuilt lazily from the current tones for the WebGL fallback
}

const INV_PI = 1 / Math.PI;
const luma = (c: ReturnType<typeof vec3>) => dot(c, vec3(0.2126, 0.7152, 0.0722));

/** Rotated screen-space halftone: 1 where a dot is printed. `lit` 0 = darkest -> bigger dots. */
const halftoneMask = Fn(([lit]: [ReturnType<typeof float>]) => {
    const a = 0.7853981; // 45 deg screen angle
    const p = screenCoordinate.div(U.dotSize);
    const rp = vec2(p.x.mul(cos(a)).add(p.y.mul(sin(a))), p.y.mul(cos(a)).sub(p.x.mul(sin(a))));
    const cell = fract(rp).sub(0.5);
    const d = length(cell);
    // dot radius grows as the surface gets darker
    const radius = float(0.62).mul(saturate(float(1).sub(lit.mul(2.6))));
    const fw = float(0.08);
    return float(1).sub(smoothstep(radius.sub(fw), radius.add(fw), d)).mul(step(0.001, radius));
});

class ComicLightingModel extends LightingModel {
    constructor(private ht: any, private selfLight: any, private character = false) { super(); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    direct({ lightDirection, lightColor, reflectedLight }: any): void {
        const nl = dot(normalView, lightDirection).mul(0.5).add(0.5);
        const w = nl.fwidth().mul(0.75).max(0.01);
        const b1 = smoothstep(U.bandLo.sub(w), U.bandLo.add(w), nl);
        const b2 = smoothstep(U.bandHi.sub(w), U.bandHi.add(w), nl);
        let tone = mix(mix(vec3(U.shadow), vec3(U.mid), b1), vec3(U.lit), b2);
        let light = lightColor;
        if (this.character) {
            // the animal keeps its own colours under a strongly tinted sky: tone bands and light lose their hue (mix(a, b, 0) = a: classic unchanged)
            tone = mix(tone, vec3(luma(tone)).mul(1.15), CU.neutral);
            light = mix(lightColor, vec3(luma(lightColor)), CU.neutral);
        }
        // lightColor already carries the light's intensity AND its shadow-map attenuation
        reflectedLight.directDiffuse.addAssign(tone.mul(light).mul(diffuseColor.rgb).mul(INV_PI));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    indirect(builder: any): void {
        const { irradiance, reflectedLight, ambientOcclusion } = builder.context;
        reflectedLight.indirectDiffuse.addAssign(irradiance.mul(diffuseColor.rgb).mul(INV_PI));
        reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    finish(builder: any): void {
        const { outgoingLight, reflectedLight } = builder.context;
        // how lit is this pixel? (direct light against the albedo it lights)
        const albedo = max(luma(diffuseColor.rgb), 0.06);
        const litAmt = saturate(luma(reflectedLight.directDiffuse).div(albedo).mul(2.2));
        // halftone dots printed into the shadow
        const dots = halftoneMask(litAmt).mul(U.halftone).mul(this.ht).mul(float(1).sub(saturate(litAmt.mul(3.0))));
        outgoingLight.assign(mix(outgoingLight, outgoingLight.mul(vec3(U.ink)).mul(1.2), dots.mul(0.85)));
        // per-material lift so small characters never drop into murk (characters: the look's fill light)
        if (this.character) outgoingLight.addAssign(diffuseColor.rgb.mul(vec3(CU.fill)));
        else outgoingLight.addAssign(diffuseColor.rgb.mul(this.selfLight));
        // rim light: brighter on the sunlit side of a silhouette
        const viewDir = positionView.negate().normalize();
        const fres = pow(float(1).sub(saturate(dot(normalView, viewDir))), 3.0);
        outgoingLight.addAssign(vec3(U.rim).mul(fres).mul(U.rimAmount).mul(saturate(litAmt.add(0.35))));
    }
}

export interface ComicOptions {
    color?: THREE.ColorRepresentation;
    map?: THREE.Texture | null;
    emissive?: THREE.ColorRepresentation;
    emissiveIntensity?: number;
    vertexColors?: boolean;
    side?: THREE.Side;
    transparent?: boolean;
    opacity?: number;
    /** painterly noise amplitude multiplier for this material (0 = flat) */
    paint?: number;
    /** noise feature size (larger = coarser brush strokes) */
    paintScale?: number;
    /** halftone dot strength multiplier for this material (0 = none; characters use 0) */
    halftone?: number;
    /** extra self-illumination as a fraction of albedo (0..1) */
    selfLight?: number;
    /**
     * Batched stage geometry (StageBatch): the painterly noise amplitude (1, or 0 for glowing parts) comes from `emitK.w` and the emissive colour from
     * `emitK.xyz`, so one material can draw meshes that used to have a material each.
     */
    batched?: boolean;
    /** No painterly noise (a far, smooth surface such as a lake): skips the five noise samples per fragment. */
    flat?: boolean;
    /** The animal: lit by setCharacterShading's fill instead of `selfLight`, albedo leaned toward its cream. */
    character?: boolean;
}

export class ComicNodeMaterial extends MeshToonNodeMaterial {
    private htU = uniform(1);
    private slU = uniform(0);
    private isCharacter = false;
    constructor(o: ComicOptions = {}) {
        super();
        this.isCharacter = !!o.character;
        this.htU.value = o.halftone ?? 1;
        this.slU.value = o.selfLight ?? 0;
        this.color = new THREE.Color(o.color ?? 0xffffff);
        if (o.map) this.map = o.map;
        if (o.emissive !== undefined) { this.emissive = new THREE.Color(o.emissive); this.emissiveIntensity = o.emissiveIntensity ?? 1; }
        this.vertexColors = !!o.vertexColors;
        if (o.side !== undefined) this.side = o.side;
        if (o.transparent) { this.transparent = true; this.opacity = o.opacity ?? 1; }
        const pk = o.paint ?? 1;
        const ps = o.paintScale ?? 1;
        const emitK = o.batched ? attribute('emitK', 'vec4') : null;
        if (emitK) this.emissiveNode = emitK.xyz.mul(EMIT_SCALE);
        if (o.character) {
            // mix(a, b, 0) is a exactly: at cream 0 the animal is as painted
            this.colorNode = vec4(characterAlbedo(), materialColor.a);
            return;
        }
        if (o.flat) return;                   // no painterly noise at all
        if (pk === 0 && !o.batched) return;   // no painterly variation: the colour is the material colour (the graph below would multiply five noise samples by zero)
        // painterly albedo: two octaves of stage-local noise (object space, so it rides with the surface)
        const p = positionLocal;
        const kA = emitK ? emitK.w : null;
        const broad = mx_fractal_noise_float(p.mul(0.55 * ps), 3, 2.0, 0.5);
        const fine = mx_noise_float(p.mul(4.2 * ps));
        const streak = mx_noise_float(vec3(p.x.mul(0.8 * ps), p.y.mul(9.0 * ps), p.z.mul(0.8 * ps)));
        const variation = kA
            ? float(1).add(broad.mul(U.paint).mul(kA)).add(fine.mul(U.paint).mul(kA.mul(0.5))).add(streak.mul(U.paint).mul(kA.mul(0.35)))
            : float(1).add(broad.mul(U.paint).mul(pk)).add(fine.mul(U.paint).mul(0.5 * pk)).add(streak.mul(U.paint).mul(0.35 * pk));
        this.colorNode = materialColor.mul(variation);
    }
    setupLightingModel(): ComicLightingModel {
        return new ComicLightingModel(this.htU, this.slU, this.isCharacter);
    }
}

/** The animal's albedo: its painted colour, saturation-scaled, leaned toward cream (both no-ops at their classic values). */
function characterAlbedo() {
    const c = materialColor.rgb;
    const saturated = max(mix(vec3(luma(c)), c, CU.saturation), vec3(0));
    return mix(saturated, vec3(CU.creamColor).mul(luma(saturated).mul(1.1).add(0.08)), CU.cream);
}

/**
 * Smooth-shaded twin of a character's comic material, for looks with `character.shading: 'smooth'` (looks.ts): the standard lit material, so the
 * scene's sun, ambient and sky light wrap the animal in soft gradients instead of bands. Same painted texture, same fill light and cream lean as the
 * comic character (the `CU` uniforms), no halftone. The screen-space ink outline still draws its silhouette: that pass covers the whole frame.
 */
export function createCharacterSmoothMaterial(o: { color: THREE.Color; map: THREE.Texture | null }): THREE.Material {
    if (isWebGpuActive()) {
        const m = new MeshStandardNodeMaterial();
        m.color = o.color.clone();
        if (o.map) m.map = o.map;
        m.roughness = 0.62;
        m.metalness = 0;
        const base = characterAlbedo();
        m.colorNode = vec4(base, materialColor.a);
        m.emissiveNode = base.mul(vec3(CU.fill));
        return m;
    }
    const m = new THREE.MeshStandardMaterial({ color: o.color, map: o.map, roughness: 0.62, metalness: 0, emissiveMap: o.map });
    m.userData.baseColor = o.color.clone();
    m.color.lerp(CU.creamColor.value, CU.cream.value * 1.5);
    m.emissive.copy(CU.fill.value);
    smoothGL.add(m);
    return m;
}

// ---- classic WebGL fallback -------------------------------------------------------------
let gradientMap: THREE.DataTexture | null = null;
function toonRamp(): THREE.DataTexture {
    if (gradientMap) return gradientMap;
    const d = new Uint8Array([120, 120, 120, 255, 205, 205, 205, 255, 255, 255, 255, 255]);
    const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.needsUpdate = true;
    gradientMap = t;
    return t;
}

/** One entry point for both renderers. Returns a plain THREE.Material. */
export function createComicMaterial(o: ComicOptions = {}): THREE.Material {
    if (isWebGpuActive()) return new ComicNodeMaterial(o);
    const m = new THREE.MeshToonMaterial({
        color: o.color ?? 0xffffff, map: o.map ?? null, gradientMap: toonRamp(), vertexColors: !!o.vertexColors,
        side: o.side ?? THREE.FrontSide, transparent: !!o.transparent, opacity: o.opacity ?? 1,
    });
    if (o.emissive !== undefined) { m.emissive.set(o.emissive); m.emissiveIntensity = o.emissiveIntensity ?? 1; }
    if (o.character) characterGL.add(m);
    return m;
}

/**
 * Stage materials are shared by every stage of the session: the same colour / structure is the same material instance. three.js WebGPU creates one
 * render pipeline per material instance (and generates its WGSL again), so per-stage materials cost 20-50 pipeline compilations on every stage swap
 * (a 100-470 ms hitch); shared instances keep their compiled pipelines. Never disposed: there are ~150 of them across all 30 stages.
 */
const sessionMaterials = new Map<string, THREE.Material>();

let stageOpaque: THREE.Material | null = null;
/** The one material every plain opaque stage mesh is drawn with after StageBatch: white, the colour comes from the (baked) vertex colours. */
export function stageOpaqueMaterial(): THREE.Material {
    if (!stageOpaque) { stageOpaque = createComicMaterial({ color: '#ffffff', vertexColors: true, paint: 1, batched: true }); stageOpaque.name = 'stage'; }
    return stageOpaque;
}

let stageGround: THREE.Material | null = null;
/**
 * The island ground (StageBatch GROUND): the stage material with a polygon offset that pushes its depth slightly back, so a boardwalk lying in
 * the island's top plane wins the depth test everywhere instead of flickering through the grass.
 */
export function stageGroundMaterial(): THREE.Material {
    if (!stageGround) {
        stageGround = createComicMaterial({ color: '#ffffff', vertexColors: true, paint: 1, batched: true });
        stageGround.polygonOffset = true;
        stageGround.polygonOffsetFactor = 1;
        stageGround.polygonOffsetUnits = 2;
        stageGround.name = 'stageGround';
    }
    return stageGround;
}

let stageFlat: THREE.Material | null = null;
/**
 * StageBatch draws the surfaces that are smooth and far (b09's lake, ripples and mist) with this one: same lighting, fog, rim and vertex colours as the
 * stage material but without the painterly noise, which is five 3D noise samples per fragment and sub-pixel aliasing at those distances.
 */
export function stageFlatMaterial(): THREE.Material {
    if (!stageFlat) { stageFlat = createComicMaterial({ color: '#ffffff', vertexColors: true, batched: true, flat: true }); stageFlat.name = 'stageFlat'; }
    return stageFlat;
}
/** Replace every mesh material under `root` with a comic twin (colour, emissive and vertex colours carried over). */
export function comicifyScene(root: THREE.Object3D, cache = sessionMaterials): void {
    root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const src = mesh.material as THREE.MeshStandardMaterial;
        if (!src || (src as { isComic?: boolean }).isComic) return;
        const hasColors = !!mesh.geometry.getAttribute('color');
        const key = `${src.name}|${src.color.getHex()}|${src.emissive.getHex()}|${src.emissiveIntensity}|${hasColors}|${src.transparent}`;
        let m = cache.get(key);
        if (!m) {
            const glows = src.emissiveIntensity > 0 && src.emissive.getHex() !== 0;
            m = createComicMaterial({
                color: src.color, vertexColors: hasColors,
                emissive: glows ? src.emissive : undefined, emissiveIntensity: src.emissiveIntensity,
                transparent: src.transparent, opacity: src.opacity,
                paint: glows ? 0 : 1,
            });
            (m as { isComic?: boolean }).isComic = true;
            m.name = src.name;
            // batchable (opaque): StageBatch bakes colour, emissive and painterly amplitude into vertex attributes and draws it with stageOpaqueMaterial()
            m.userData.batch = !src.transparent ? { glow: glows, emissive: [src.emissive.r * src.emissiveIntensity, src.emissive.g * src.emissiveIntensity, src.emissive.b * src.emissiveIntensity] } : null;
            cache.set(key, m);
        }
        mesh.material = m;
    });
}
