import * as THREE from 'three';
import type { WorldProfileData, EngineLike, GameData } from 'types/game.js';
import type { GameModule } from 'engine/api/GameModule.js';
import { SkyboxLoader } from 'engine/sky/SkyboxLoader.js';
import { AmbientLighting } from 'engine/lighting/AmbientLighting.js';
import { GameHUD } from 'engine/ui/hud/GameHUD.js';
import { TrickOrRoll, MENU_STAGE } from './tor/TrickOrRoll.js';
import { prefetchStageBytes, whenStageBytes } from './tor/StageView.js';
import { CharacterSelectFlow } from './tor/CharacterSelect.js';

/**
 * Trick or Roll: a Super Monkey Ball style tilt-the-stage game.
 *
 * The game class keeps the engine happy (skybox, ambient lighting, HUD layer, shadow focus) and hands
 * everything else to `TrickOrRoll` (tor/). There is no voxel world and no player controller:
 * the sim, camera and input are the game's own. See GAME-DESIGN.md.
 */
/** The engine constructs the `Game` export of this file once per load. */
export class Game implements GameModule {
    private engine: EngineLike;
    private worldProfileData: WorldProfileData;
    private skyboxLoader: SkyboxLoader;
    private ambientLighting: AmbientLighting;
    public hud: GameHUD;
    private gameData: GameData | null;
    private tor: TrickOrRoll | null = null;
    /** The pick-your-roller screen (null in the editor, with ?select=0, ?stage=, desktop ?autostart=1). */
    private select: CharacterSelectFlow | null = null;

    constructor(engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        this.engine = engine;
        this.worldProfileData = worldProfileData;
        this.gameData = gameData || null;
        if (worldProfileData.worldSeed === undefined) {
            throw new Error('worldSeed is required in worldProfileData for consistent world generation');
        }
        if (!this.gameData?.gameName) {
            throw new Error('[TrickOrRoll] gameName is required in gameData but was not provided.');
        }
        this.skyboxLoader = new SkyboxLoader(engine, worldProfileData);
        this.ambientLighting = new AmbientLighting(engine, this.skyboxLoader);
        this.hud = new GameHUD();
        this.select = CharacterSelectFlow.install();
    }

    async load(_gameId: string): Promise<void> {
        // the first stage (3 MB) used to start downloading only after the skybox had; both are needed before the game can start, so let them share the wait
        const firstStage = new URLSearchParams(window.location.search).get('stage') ?? MENU_STAGE;
        prefetchStageBytes(this.gameData, firstStage);
        // the moment the stage's bytes are in, its CPU-bound setup (parse, batching, GPU warm-up) leaves the link idle for a while: the animal downloads then
        let stageIn = false;
        void whenStageBytes(this.gameData, firstStage).then(() => { stageIn = true; this.tor?.warmAnimal(); });
        const skyboxPromise = this.skyboxLoader.loadSkybox();
        void skyboxPromise.catch(() => {});
        await skyboxPromise;
        this.ambientLighting.updateFromScene();

        this.tor = new TrickOrRoll(this.engine, this.gameData, this.hud, {
            setSky: async (url: string) => {
                await this.skyboxLoader.loadSkybox({ ...this.worldProfileData, skyboxUrl: url });
                this.ambientLighting.updateFromScene();
            },
        });
        // the pick screen may have been used already (the page is interactive long before this runs): the first stage load builds the picked animal itself
        this.select?.whenPicked((id) => { void this.tor?.selectCharacter(id); });
        if (stageIn) this.tor.warmAnimal();   // the stage was faster than the skybox: nothing else has started the animal yet
        await this.tor.load();
        this.tor.warmMusic();   // the stage, sky and animal are in: now the link may carry the first song

        this.engine.setPlayButtonVisible?.(true);
        this.hud.show();
        // ROLL on the pick screen (pressed before or after this point) IS the play action: once the engine has finished loading, the pick is applied and engine.startGame() is called
        // (what the engine's Play button calls). Without the screen the engine's own start screen and Play button run as usual.
        this.select?.attach({
            apply: (id) => this.tor?.selectCharacter(id, true),
            start: () => { if (typeof this.engine.startGame !== 'function') return false; this.engine.startGame(); return true; },
        }, this.gameData);
    }

    update(deltaTime: number): void {
        this.tor?.update(deltaTime);
    }

    dispose(): void {
        this.select?.dispose();
        this.tor?.dispose();
        this.ambientLighting.dispose();
        this.hud.dispose();
    }

    onWindowResize(): void {
        // three handles the projection; the camera rig reads the engine camera each frame
    }

    getCurrentPlayer(): { player: THREE.Object3D } | null {
        return this.tor ? { player: this.tor.playerProxy } : null;
    }
}

