/**
 * The animals you can roll as, and the stage names the boot flow cares about. ONE source for the in-game menu (Menus.ts), the pre-bundle pick screen in
 * pick screen (tools/pick-screen/build.mjs reads this file with Node's type stripping, so keep it pure data: no imports, no enums, no parameter
 * properties) and the boot prefetch. Portraits live in tools/pick-screen/portraits/<id>.webp.
 */
/** `blurb` = the short, funny line shown under the cards on the pick screen and under the animal in the in-game character menu (keep it to about 60 characters). */
export interface CharacterDef { id: string; name: string; blurb: string; tint: string }

export const ROSTER: { menuStage: string; firstStage: string; characters: CharacterDef[] } = {
    /** The stage that plays behind the menus (loaded before the game can start). */
    menuStage: 'b06',
    /** First stage of the first course: most players start there, so the pick screen fetches it once the game is ready. CharacterSelect.ts warns when this disagrees with COURSES. */
    firstStage: 'b01',
    characters: [
        { id: 'hamster', name: 'Biscuit', blurb: 'Runs on seeds and pure vibes. Brakes: optional.', tint: '#ffd58a' },
        { id: 'redpanda', name: 'Maple', blurb: 'Rolls first, asks questions never. Fluffy menace, 10/10.', tint: '#ff9a5a' },
        { id: 'hedgehog', name: 'Pip', blurb: 'Small, spiky, and deadly serious about candy. Do not pat.', tint: '#b8ffb0' },
        { id: 'raccoon', name: 'Bandit', blurb: 'Here for the candy, not the rules. Mask on, snacks out.', tint: '#c9b8ff' },
    ],
};
