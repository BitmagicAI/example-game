import type { ComicStyleValues } from './comic.js';
import type { WorldTheme } from './worlds.js';

/**
 * Stage looks: a per-stage art direction on top of the stage's world theme (worlds.ts). A world gives the mood of a whole course; a look re-grades
 * chosen stages of it without touching the others. Every field is optional and means "as the world has it"; a stage without a look renders exactly
 * as before (every part of the look system is a no-op at its classic settings).
 *
 * `night`: the Pumpkin Patch at night: deep aubergine and misty purple (about 70 %), amber pumpkins, windows and lanterns (about 20 %), pale mint
 * reserved for thin route lights and a few magical accents (about 10 %), clear glass around a readable, cream-lit character.
 */

export interface GlassLook {
    /** Rim / edge highlight colour (cool white, a touch of mint). */
    edge: string;
    /** Faint glow concentrated on the silhouette. */
    glow: string;
    /** Opacity of the glass at the centre (0 = invisible). */
    centre: number;
    /** Strength of the rolling great-circle bands (they make the spin readable). */
    bands: number;
    /** Strength of the view-fixed window highlights. */
    highlights: number;
    /** Opacity of the dark ink ring at the silhouette (the classic comic outline). */
    ink: number;
    /** Ink ring colour. */
    inkColor: string;
}

export interface CharacterLook {
    /** Deep outline around the animal (inverted hull), or null for none. */
    outline: string | null;
    /** Outline thickness in metres at the ball's scale. */
    outlineWidth: number;
    /** Fill light colour: lifts the animal out of shadow without flattening it. */
    fill: string;
    /** Fill amount as a fraction of the albedo (classic: 0.2 white). */
    fillAmount: number;
    /** How far the albedo leans toward warm cream (0 = as painted). */
    cream: number;
    creamColor: string;
    /** Visual scale of the animal inside the glass (collision is the ball, never the animal). */
    scale: number;
    /** 0..1: how far the animal's light loses the scene's colour tint (a strongly coloured night would dye it). Comic shading only. */
    neutral: number;
    /** Saturation of the animal's own colours (1 = as painted; WebGPU only). */
    saturation?: number;
    /**
     * 'comic' (default): banded like the stage. 'smooth': standard lit shading (comic.ts createCharacterSmoothMaterial) on smooth normals: the
     * animals are faceted low-poly meshes, so the normals are averaged per position (BallView) or every facet would still shade, and ink, as a step.
     */
    shading?: 'comic' | 'smooth';
}

export interface GroundLook {
    /** Soft dark disc under the ball (contact / landing position). */
    shadow: number;
    /** Faint light pool under the ball. */
    pool: string;
    poolStrength: number;
}

export interface RouteLightLook {
    color: string;
    /** Emission multiplier (bloom threshold is ~0.9: just above it glows softly). */
    intensity: number;
    /** Strip width and inset from the floor edge (m). */
    width: number;
    inset: number;
    /** Dash and gap lengths along an edge (m): the occasional breaks. */
    dash: number;
    gap: number;
}

export interface WarmLightLook {
    /** Emissive material names that act as warm light sources (lanterns, windows, carved faces). */
    sources: string[];
    color: string;
    /** Added light at the source, as a fraction of the surface albedo. */
    strength: number;
    /** Falloff radius (m). */
    radius: number;
}

export interface StageLook {
    id: string;
    lighting?: Partial<WorldTheme['lighting']>;
    fog?: Partial<WorldTheme['fog']>;
    comic?: Partial<ComicStyleValues>;
    /** Only the fields every world sets, so a stage without the look gets its world's values back. */
    grade?: { saturation?: number; contrast?: number; temperature?: number; tint?: number };
    exposure?: number;
    bloom?: { strength: number; radius: number; threshold: number };
    vignette?: { intensity?: number; radius?: number; softness?: number; color?: string };
    /** Sky panorama for this look (null: the world's). */
    sky?: string;
    /** Stage material name -> albedo. Unlisted materials keep their colour. */
    palette?: Record<string, string>;
    /** Glowing material name -> emissive colour and strength. */
    glow?: Record<string, { color: string; intensity: number }>;
    warmLight?: WarmLightLook;
    routeLights?: RouteLightLook;
    glass?: GlassLook;
    character?: CharacterLook;
    ground?: GroundLook;
    /** Candy: emission multiplier and saturation (1 = as authored). */
    candy?: { emissive: number; saturation: number };
    /** The "+1" of an ordinary candy: smaller, fainter and lifted clear of the ball (the "+10" of a bucket keeps its full badge). */
    candyPop?: { size: number; lift: number; opacity: number };
}

export const NIGHT_PATCH: StageLook = {
    id: 'night',
    lighting: {
        sunElevationDeg: 38, sunAzimuthDeg: 150, sunColor: '#e0a8ff', sunIntensity: 0.34,
        environmentIntensity: 0.38, skyboxIntensity: 1.0, ambientFloor: 0.2, ambientColor: '#6a1f8f',
    },
    fog: { enabled: true, color: '#2e1040', near: 40, far: 230 },
    comic: { shadow: '#4a1270', mid: '#e2b0ff', lit: '#fff0fa', rim: '#c87cff', rimAmount: 0.5, halftone: 0.6, ink: '#0e0418' },
    grade: { saturation: 1.28, contrast: 1.16, temperature: 0.04, tint: 0.06 },
    exposure: 1.1,
    bloom: { strength: 0.5, radius: 0.5, threshold: 0.85 },
    palette: {
        grass: '#38124e', grass_dark: '#260a38', leaf: '#2a2a5e', stem: '#2f6a3c', moss: '#22164a',
        dirt: '#2a1238', rock: '#321442', rock_dark: '#1c0828',
        plank: '#7e3aa6', plank_dark: '#521f78', beam: '#45185c', beam_dark: '#2a0d3c', rope: '#8a5a3a',
        hay: '#c88a2e', hay_dark: '#8f5a1c', corn: '#d49a2a',
        pumpkin: '#ff7a14', cream: '#e8c9a0',
        cloth_orange: '#ff7a14', cloth_purple: '#6a2ac0', cloth_red: '#d02a4a', cloth_black: '#1c0c2c', black: '#120820',
        metal: '#3e3070', stone: '#6a58b0', stone_dark: '#3e2f7a', stone_light: '#8c7ad0',
        sandstone: '#8a5a8a', sandstone_dark: '#5a3460',
        lake: '#1c0e50', lake_hi: '#4a2a9a', mist: '#5a3a9a',
    },
    glow: {
        glow_orange: { color: '#ffa024', intensity: 2.4 },
        glow_yellow: { color: '#ffc23a', intensity: 2.2 },
        glow_green: { color: '#3dffb0', intensity: 2.0 },
        glow_purple: { color: '#b45cff', intensity: 2.2 },
        arrow_glow: { color: '#3dffb0', intensity: 1.3 },
    },
    warmLight: { sources: ['glow_orange', 'glow_yellow'], color: '#ff9a2a', strength: 1.1, radius: 4.5 },
    routeLights: { color: '#3dffb0', intensity: 1.6, width: 0.07, inset: 0.2, dash: 1.5, gap: 0.5 },
    glass: { edge: '#d8fff0', glow: '#3dffb0', centre: 0.015, bands: 0.16, highlights: 0.6, ink: 0.45, inkColor: '#1c0838' },
    character: { outline: '#1c0838', outlineWidth: 0.012, fill: '#ffe6bf', fillAmount: 0.36, cream: 0.14, creamColor: '#ffe2b8', scale: 1.06, neutral: 0.85 },
    ground: { shadow: 0.7, pool: '#3dffb0', poolStrength: 0.18 },
    candy: { emissive: 0.7, saturation: 1.0 },
    candyPop: { size: 0.42, lift: 1.5, opacity: 0.75 },
};

/**
 * `player`: the Pumpkin Patch exactly as its world has it (sky, light, palette, shading, candy) with only the player made easier to follow: clear
 * glass with a contact shadow and a faint pool, the animal smooth-shaded, bolder and a little bigger, mint route lights along the open edges and
 * quieter "+1" pops. (A darker `dusk` background was tried and turned down: darkening the pink sky made it muddy.)
 */
/** The player look on every world: clear glass, contact shadow and pool, the smooth-shaded, bolder animal at 1.10x, quieter "+1" pops. */
export const PLAYER: StageLook = {
    id: 'player',
    glass: { edge: '#f4fff8', glow: '#bfeedd', centre: 0.015, bands: 0.16, highlights: 0.6, ink: 0.45, inkColor: '#2a1240' },
    character: { outline: null, outlineWidth: 0.012, fill: '#ffe6bf', fillAmount: 0.1, cream: 0, creamColor: '#ffe2b8', scale: 1.1, neutral: 0, shading: 'smooth', saturation: 1.45 },
    ground: { shadow: 0.55, pool: '#bfeedd', poolStrength: 0.12 },
    candyPop: { size: 0.42, lift: 1.5, opacity: 0.75 },
};

/** The Pumpkin Patch's player look: PLAYER plus mint route lights along the open edges (the Beginner course only, by the creator's choice). */
export const PLAYER_PATCH: StageLook = {
    ...PLAYER,
    id: 'player-patch',
    routeLights: { color: '#91d7b5', intensity: 1.35, width: 0.07, inset: 0.2, dash: 1.5, gap: 0.5 },
};

/** The look each world's stages get: the player look everywhere, with route lights on the Pumpkin Patch. */
const WORLD_LOOKS: Readonly<Record<string, StageLook>> = { patch: PLAYER_PATCH, graveyard: PLAYER, workshop: PLAYER };

/**
 * The look for a stage, or null for the world's own. `?look=classic` turns every look off (the game as it was before the looks, for comparisons);
 * `?look=night` puts the rejected night look on a Pumpkin Patch stage.
 */
export function lookForStage(stage: string, world: string): StageLook | null {
    void stage;
    let forced: string | null = null;
    try { forced = new URLSearchParams(window.location.search).get('look'); } catch { /* no window */ }
    if (forced === 'classic') return null;
    if (forced === 'night' && world === 'patch') return NIGHT_PATCH;
    return WORLD_LOOKS[world] ?? null;
}
