// Gem Island: run around a small island and collect every gem before the timer runs out.
//
// The game is a small subclass of VoxelGameBase (./VoxelGameBase.ts), which loads the
// world, the player, the camera and the controller, and drives them every frame. This
// file only adds the gems, the HUD and the win / lose rules on top, through the base
// class's protected hooks. The island itself is shaped in WorldGenerator.ts
// (generateVoxelTerrain, look for "Gem Island").
import * as THREE from 'three';
import type { WorldProfileData, EngineLike, GameData } from 'types/game.js';
import { getGameStateManager, GameState } from 'engine/core/GameStateManager.js';
import { gameplayNowMs } from 'engine/core/frame/GameplayTimers.js';
import { getVisualEffects } from 'engine/effects/index.js';
import { VoxelGameBase } from './VoxelGameBase.js';
import { Gem } from './Gems.js';

/** Seconds the player has to collect every gem. */
const TIME_LIMIT_SECONDS = 90;

/** Where the gems are, as (x, z) in metres from the island's centre. Their height comes from the terrain. */
const GEM_SPOTS: ReadonlyArray<readonly [number, number]> = [
    [0, 9], [12, 6], [21, -3], [13, -17], [2, -11],
    [-8, -20], [-12, -8], [-20, 3], [-14, 14], [4, 20],
];

/** The engine constructs the `VoxelGame` export of this file once per load (and again on Play Again). */
export class VoxelGame extends VoxelGameBase {
    private gems: Gem[] = [];
    private collectedCount = 0;
    private startedAtMs: number | null = null;
    private finished = false;
    private stopListeningToGameState: (() => void) | null = null;

    constructor(engine: EngineLike, worldProfileData: WorldProfileData, gameData?: GameData) {
        super(engine, worldProfileData, gameData);
    }

    /** The terrain is in: place the gems on it and build the HUD. */
    protected override onWorldLoaded(): void {
        const { scene, physicsWorld } = this.engine;
        if (!scene || !physicsWorld) throw new Error('[GemIsland] the scene and physics must exist before the gems are placed');
        // Created during load so the engine warms the effect's materials before play starts.
        const effects = getVisualEffects(this.engine);

        GEM_SPOTS.forEach(([x, z], index) => {
            const ground = this.worldGenerator?.findValidVoxelSpawnPosition(x, z) ?? new THREE.Vector3(x, 0, z);
            const gem = new Gem(scene, physicsWorld, ground, index, (collected) => {
                effects.burst('stardust', collected.position, { radius: 1.2 });
                this.onGemCollected();
            });
            this.engine.enableBloomOnObject(gem.root);
            this.gems.push(gem);
        });

        this.hud.createCounter('gems', {
            anchor: 'top-right',
            label: 'Gems',
            icon: '💎',
            initialValue: 0,
            format: (value) => `${value} / ${this.gems.length}`,
        });
        this.hud.createTimer('time-left', {
            anchor: 'top-center',
            label: 'Time Left',
            countDown: true,
            startSeconds: TIME_LIMIT_SECONDS,
            format: 'mm:ss',
            timeBase: 'gameplay', // stops while the pause menu is open
            onComplete: () => this.onTimeUp(),
        });

        // The clock starts when the player presses Play, not when the world finishes loading.
        const stateManager = getGameStateManager();
        this.stopListeningToGameState = stateManager.addListener((state) => {
            if (state === GameState.PLAYING) this.startClock();
        });
        if (stateManager.isState(GameState.PLAYING)) this.startClock();
    }

    protected override updateWorld(deltaTime: number): void {
        super.updateWorld(deltaTime);
        for (const gem of this.gems) gem.update(this.elapsedTime);
    }

    protected override disposeGameplay(): void {
        this.stopListeningToGameState?.();
        this.stopListeningToGameState = null;
        for (const gem of this.gems) gem.dispose();
        this.gems = [];
        super.disposeGameplay();
    }

    private startClock(): void {
        if (this.startedAtMs !== null) return; // PLAYING also fires when the pause menu closes
        this.startedAtMs = gameplayNowMs();
        this.hud.startTimer('time-left');
    }

    private onGemCollected(): void {
        if (this.finished) return;
        this.collectedCount++;
        this.hud.updateCounter('gems', this.collectedCount);
        this.engine.logGameEvent({ type: 'score', data: { gems: this.collectedCount } });

        if (this.collectedCount === this.gems.length) {
            this.finished = true;
            this.hud.pauseTimer('time-left');
            const seconds = (gameplayNowMs() - (this.startedAtMs ?? gameplayNowMs())) / 1000;
            this.engine.endGame({
                outcome: 'win',
                title: 'All gems found!',
                stats: [
                    { label: 'Gems', value: `${this.collectedCount} / ${this.gems.length}` },
                    { label: 'Time', value: formatTime(seconds) },
                ],
            });
        }
    }

    private onTimeUp(): void {
        if (this.finished) return;
        this.finished = true;
        this.engine.endGame({
            outcome: 'lose',
            title: "Time's up!",
            message: 'The island kept some of its gems this time.',
            stats: [{ label: 'Gems', value: `${this.collectedCount} / ${this.gems.length}` }],
        });
    }
}

/** 73.4 → "1:13" */
function formatTime(seconds: number): string {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
