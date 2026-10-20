import type { ComicStyleValues } from './comic.js';
import type { SkyShape } from './sky.js';

/**
 * The three moods of one Halloween night. A stage names its world in its Blender STAGE props
 * (`world`); the controller applies the theme when a stage loads: sun/ambient/fog, the comic
 * shading palette, post grade, and the sky (image + how the painted horizon is placed).
 */
export interface WorldTheme {
    id: string;
    title: string;
    lighting: {
        preset?: 'stylized-day' | 'golden-hour' | 'overcast-forest' | 'moonlit-street';
        sunElevationDeg: number; sunAzimuthDeg: number; sunColor: string; sunIntensity: number;
        environmentIntensity: number; skyboxIntensity: number; ambientFloor: number; ambientColor: string;
    };
    fog: { enabled: boolean; color: string; near: number; far: number };
    comic: Partial<ComicStyleValues>;
    grade: { saturation: number; contrast: number; temperature: number; tint: number };
    exposure: number;
    bloom: { strength: number; radius: number; threshold: number };
    sky: { url: string | null; shape: SkyShape };
    /** Asset id of the world's music loop (played through engine.playMusic). */
    music?: string;
}

/**
 * The sun is fixed in the world while the stage tilts under it (sim/physics.ts tiltMaxDeg, 24 degrees in any direction: the camera turns, so a
 * full tilt can face straight away from the sun). Every world's sun therefore stands well above that: at 14 degrees the Pumpkin Patch sun sank
 * below the deck at full tilt and the whole platform fell into its own shadow. 32 degrees leaves it 8 above the deck at the worst tilt.
 */
export const WORLDS: Record<string, WorldTheme> = {
    patch: {
        id: 'patch', title: 'Pumpkin Patch',
        lighting: {
            sunElevationDeg: 32, sunAzimuthDeg: 135, sunColor: '#ffcf94', sunIntensity: 0.3,
            environmentIntensity: 0.45, skyboxIntensity: 0.65, ambientFloor: 0.25, ambientColor: '#7a5cf0',
        },
        fog: { enabled: true, color: '#c2649a', near: 60, far: 320 },
        comic: { shadow: '#7a55b8', mid: '#f0c9d0', lit: '#ffffff', rim: '#ffb070', rimAmount: 0.5, halftone: 0.7, ink: '#2a1240' },
        grade: { saturation: 1.15, contrast: 1.08, temperature: 0.06, tint: 0.04 },
        exposure: 1.15,
        bloom: { strength: 0.4, radius: 0.5, threshold: 0.95 },
        sky: { url: null, shape: { paintedHorizon: 0.78, horizonDeg: 14, yaw: 0 } },
        music: 'music-patch',
    },
    graveyard: {
        id: 'graveyard', title: 'Moonlit Graveyard',
        lighting: {
            sunElevationDeg: 32, sunAzimuthDeg: 135, sunColor: '#a9b9ff', sunIntensity: 0.34,
            environmentIntensity: 0.5, skyboxIntensity: 0.7, ambientFloor: 0.3, ambientColor: '#5a70ff',
        },
        fog: { enabled: true, color: '#4a4a8a', near: 40, far: 240 },
        comic: { shadow: '#4b3fa0', mid: '#c8c8f0', lit: '#ffffff', rim: '#7fe0ff', rimAmount: 0.6, halftone: 0.75, ink: '#120a28' },
        grade: { saturation: 1.1, contrast: 1.12, temperature: -0.12, tint: 0.02 },
        exposure: 1.15,
        bloom: { strength: 0.45, radius: 0.55, threshold: 0.92 },
        sky: { url: 'https://forged-assets.bitmagic.ai/images/580057a8-9028-45f1-bba4-37eeb9043fd4/image.webp', shape: { paintedHorizon: 0.78, horizonDeg: 16, yaw: 0 } },
        music: 'music-graveyard',
    },
    workshop: {
        id: 'workshop', title: "Witch's Workshop",
        lighting: {
            sunElevationDeg: 34, sunAzimuthDeg: 135, sunColor: '#c9a3ff', sunIntensity: 0.3,
            environmentIntensity: 0.5, skyboxIntensity: 0.7, ambientFloor: 0.32, ambientColor: '#7a3cff',
        },
        fog: { enabled: true, color: '#2a1a4a', near: 35, far: 200 },
        comic: { shadow: '#3a2a8a', mid: '#d8c0f0', lit: '#ffffff', rim: '#ff6ee0', rimAmount: 0.7, halftone: 0.8, ink: '#0e0620' },
        grade: { saturation: 1.18, contrast: 1.15, temperature: -0.05, tint: 0.08 },
        exposure: 1.2,
        bloom: { strength: 0.55, radius: 0.6, threshold: 0.88 },
        sky: { url: 'https://forged-assets.bitmagic.ai/images/062def2e-897d-4694-9098-1de0c5d4dd70/image.webp', shape: { paintedHorizon: 0.78, horizonDeg: 16, yaw: 0 } },
        music: 'music-workshop',
    },
};

export function worldTheme(id: string): WorldTheme {
    return WORLDS[id] ?? WORLDS.patch!;
}
