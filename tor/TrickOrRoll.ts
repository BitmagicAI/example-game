import * as THREE from 'three';
import type { EngineLike, GameData } from 'types/game.js';
import type { GameHUD } from 'engine/ui/hud/GameHUD.js';
import { GameState, getGameStateManager } from 'engine/core/GameStateManager.js';
import { StageSim } from '../sim/physics.js';
import { RouteBot } from '../sim/bot.js';
import { Vec3 } from '../sim/math3.js';
import type { IntroKey } from '../sim/stageData.js';
import { Input } from './Input.js';
import { CameraRig } from './CameraRig.js';
import { Hud } from './Hud.js';
import { StageView, loadStageAsset, prefetchStageBytes } from './StageView.js';
import { setComicStyle, type ComicStyleValues } from './comic.js';
import { shapeSky, type SkyShape } from './sky.js';
import { BallView } from './BallView.js';
import { COURSES, Session, loadSave, writeSave, type CourseDef, type SaveData } from './session.js';
import { COURSE_CLEARED, PHOTO_FINISH_SECONDS, unlock } from './achievements.js';
import { worldTheme } from './worlds.js';
import type { StageLook } from './looks.js';
import { setCandyLook } from './Items.js';
import { ItemsView } from './Items.js';
import { Fx } from './Fx.js';
import { Sfx } from './Sfx.js';
import { CHARACTERS, Menus, type CharacterDef } from './Menus.js';
import { ROSTER } from './roster.js';
import { PauseExtras } from './PauseExtras.js';
import { PerfProbe } from './PerfProbe.js';
import { RenderTune } from './RenderTune.js';
import { isMobileRuntime } from 'engine/runtime/isMobileRuntime.js';
import { resolveGameAssetUrl } from 'engine/runtime/hosting.js';
import { safeInsets } from './safeArea.js';

/**
 * Game flow controller: owns the sim, the views, the camera, input, HUD, menus, sound and the run
 * (lives, candy, score), and plays the arcade stage loop:
 *
 *   attract -> menu -> intro fly-through -> READY -> GO -> play -> goal -> result -> next stage
 *                                                              \-> fall | time over -> retry / game over
 */
type Phase =
    | 'attract' | 'menu' | 'loading' | 'intro' | 'ready' | 'play'
    | 'goal' | 'result' | 'fall' | 'timeover' | 'gameover' | 'courseclear';

const STEP = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpLook = new THREE.Vector3();
const tmpW = new Vec3();
const tmpQ = new THREE.Quaternion();

/** GameEngine methods the stage looks call that EngineLike does not declare. */
interface EnginePost {
    getRenderConfig?: () => Record<string, unknown> | null;
    applyRenderConfig?: (c: Record<string, unknown>) => void;
    setupBloom?: (c: { enabled: boolean; strength: number; radius: number; threshold: number }) => void;
    setVignette?: (c: Record<string, unknown>) => void;
}

export interface TorHooks {
    /** Swap the sky image (worlds with their own panorama). */
    setSky?: (url: string) => Promise<void>;
}

/** The stage that rolls behind the title menu: a spinning scarecrow wheel within a few seconds of the start shows off the game better than a plain walkway. */
export const MENU_STAGE = ROSTER.menuStage;

/** Mouse speed presets: multiplier on how far the mouse travels for full tilt (bigger = more sensitive). */
const MOUSE_SPEEDS = { slow: 0.7, normal: 1, fast: 1.5 } as const;

export class TrickOrRoll {
    private sim!: StageSim;
    private view!: StageView;
    private cam: CameraRig;
    private tune: RenderTune;
    /** Debug: a fixed cosmetic clock (candy bob/spin stand still) so two frames can be compared pixel by pixel. */
    private debugTime: number | null = null;
    private debugFaceYaw: number | null = null;
    private input: Input;
    private hud: Hud;
    private ball = new BallView();
    private ballLoaded = false;
    /** Settles when the animal that was asked for last is on the ball (or its load failed). */
    private animalReady: Promise<void> = Promise.resolve();
    private items: ItemsView | null = null;
    private fx: Fx;
    private sfx: Sfx;
    private menus: Menus;
    private phase: Phase = 'attract';
    private phaseT = 0;
    private acc = 0;
    private pauseExtras: PauseExtras;
    private lastReal = performance.now() / 1000;
    private timeLeft = 60;
    private stageCandy = 0;
    private save: SaveData = loadSave();
    private session: Session;
    private practiceMode = false;
    /** A life was lost in this Challenge run (falls, time-outs and retries all count): "Not a Scratch" needs none. */
    private runLostLife = false;
    private currentWorld = '';
    /** World + stage look currently applied (applyStageLook). */
    private lookKey = '';
    /** The sky panorama on screen now (null: the one loaded at boot, world.json's). */
    private skyUrl: string | null = null;
    /** world.json's exposure / bloom, restored when a look that changed them is left. */
    private basePost: { render: { exposure: unknown; vignette: object | undefined } | null; bloom: { enabled: boolean; strength: number; radius: number; threshold: number } | null } | null = null;
    private postFromLook = false;
    /** ?stage=name plays one stage in practice mode straight away (tools and tests). */
    private readonly urlStage: string | null;
    private pendingResult: { timeBonus: number; stageCandy: number; timeLeft: number; tier: string } | null = null;
    /** Object the engine reads for shadow centring (world-space ball position). */
    readonly playerProxy = new THREE.Object3D();
    private started = false;
    private disposed = false;
    private stateListener: ((s: GameState, o: GameState) => void) | null = null;
    private debugCam: { p: [number, number, number]; l: [number, number, number]; fov?: number } | null = null;
    private debugFreeze = false;
    private debugFollow: { side: number; up: number; back: number; fov: number } | null = null;
    private bot: RouteBot | null = null;
    private botStick = { x: 0, y: 0 };
    /** Menu demo: a slow route bot rolls the ball along the loaded stage behind the menu (the tilt, the candy, the mechanic on the title screen). */
    private demoBot: RouteBot | null = null;
    private demoFor: unknown = null;
    private demoStick = { x: 0, y: 0 };
    private demoT = 0;
    private demoEnd = 0;
    private demoHeading = 0;
    private demoWasOn = false;
    /** The stage could not be downloaded (twice): a tap goes back to the menu instead of leaving the player stuck. */
    private loadFailed = false;
    private fovKick = 0;

    constructor(private engine: EngineLike, private gameData: GameData | null, hud: GameHUD, private hooks: TorHooks = {}) {
        this.cam = new CameraRig(engine.getDefaultCamera());
        this.tune = new RenderTune(engine);
        this.input = new Input(engine.renderer!.domElement);
        this.input.suspendWhen = () => !getGameStateManager().isState(GameState.PLAYING);   // paused / loading: the pause card owns the keys and the mouse
        this.engine.setMuteHotkeyEnabled?.(false);   // M is mouse tilt here (the pause card still has Mute)
        this.pauseExtras = new PauseExtras({
            canAct: () => this.phase !== 'menu' && this.phase !== 'loading',
            retry: () => { if (this.phase === 'play') this.input.press('retry'); },
            quit: () => { this.bot = null; this.showMenu('main'); },
        });
        this.pauseExtras.install();
        this.input.setKeyProfile(this.save.settings.keys ?? 'gentle');
        this.input.setMouseSpeed(MOUSE_SPEEDS[this.save.settings.mouseSpeed ?? 'normal']);
        this.input.setMouseMode(!!this.save.settings.mouse);
        this.input.onCaptureLost = () => {   // Esc or alt-tab released the mouse in the middle of a stage: pause, never leave it running blind
            const gsm = getGameStateManager();
            if (gsm.isState(GameState.PLAYING) && (this.phase === 'play' || this.phase === 'ready')) gsm.setPaused(true, 'manual');
        };
        this.input.onMouseToggle = (on) => {   // the M key
            this.save.settings.mouse = on; writeSave(this.save);
            this.hud.hint(on ? '<b>MOUSE TILT ON</b>  ·  the ring shows your tilt  ·  <b>click</b> re-centres  ·  <b>M</b> switches off' : '<b>MOUSE TILT OFF</b>  ·  keyboard again', 4500);
        };
        this.hud = new Hud(hud);
        this.fx = new Fx(engine.scene!, engine.getDefaultCamera());
        this.sfx = new Sfx(engine);
        const q = new URLSearchParams(window.location.search);
        this.urlStage = q.get('stage');
        const course: CourseDef = COURSES.find((c) => c.id === q.get('course')) ?? COURSES[0]!;
        this.session = new Session(course);
        this.menus = new Menus(this.save, {
            startChallenge: (c) => this.startRun(c, 0, false),
            startPractice: (c, i) => this.startRun(c, i, true),
            pickCharacter: (c) => this.pickCharacter(c),
            setControls: (patch) => {
                if (patch.keys) { this.save.settings.keys = patch.keys; this.input.setKeyProfile(patch.keys); }
                if (patch.mouse !== undefined) { this.save.settings.mouse = patch.mouse; this.input.setMouseMode(patch.mouse); }
                if (patch.mouseSpeed) { this.save.settings.mouseSpeed = patch.mouseSpeed; this.input.setMouseSpeed(MOUSE_SPEEDS[patch.mouseSpeed]); }
                if (patch.openAll !== undefined) this.save.settings.openAll = patch.openAll;
                writeSave(this.save);
            },
            ui: (k) => (k === 'move' ? this.sfx.uiMove() : k === 'back' ? this.sfx.uiBack() : this.sfx.uiOk()),
            mountAd: (box) => this.engine.gameExchange?.mount(box) ?? null,
            adAvailable: () => this.engine.gameExchange?.isAvailable() === true,
        });
    }

    // ------------------------------------------------------------------ loading

    async load(): Promise<void> {
        this.deferMusicPreload();
        const first = this.urlStage ?? MENU_STAGE;
        await this.loadStageByName(first);
        this.installStateListener();
        this.exposeDebug();
    }

    // ------------------------------------------------------------------ music: one loop at a time

    private musicUrls = new Map<string, string>();   // world id -> loop url
    private musicCache: Map<string, unknown> | null = null;
    private audioPreload: ((url: string) => Promise<void>) | null = null;

    /**
     * Before the Play button the engine downloads AND DECODES every audio asset of world.json: our three 60 s loops are 2.7 MB of download (a third of
     * the wait on 4G, after the stage GLB) and 3 x 23 MB of decoded PCM held for the whole session, but a run only ever plays the current world's loop.
     * Skip that preload, warm just the first world's loop once the game is ready (`warmMusic`, called by Game.load: at load start it fought the stage, the sky and
     * the animal for the link, and on a slow connection those decide when the game can start; the song is only needed when Play / ROLL has been pressed) and let the
     * others load when their world is first entered (engine.playMusic fetches on demand). Anything unexpected (a renamed engine field) leaves the engine's behaviour as it was.
     */
    private deferMusicPreload(): void {
        try {
            const ap = (this.engine as unknown as { audioPlayer?: { preload?: (u: string) => Promise<void>; bufferCache?: Map<string, unknown> } }).audioPlayer;
            const assets = (this.gameData as unknown as { assets?: { id: string; url?: string }[] } | null)?.assets;
            if (!ap?.preload || !ap.bufferCache || !assets) return;
            for (const id of ['patch', 'graveyard', 'workshop']) {
                const music = worldTheme(id).music;
                const url = assets.find((a) => a.id === music)?.url;
                if (url) this.musicUrls.set(id, url);
            }
            const skip = new Set(this.musicUrls.values());
            const orig = ap.preload.bind(ap);
            ap.preload = (u: string) => (skip.has(u) ? Promise.resolve() : orig(u));
            this.audioPreload = orig;
            this.musicCache = ap.bufferCache;
            const first = this.musicUrls.get('patch');
            if (first) this.musicWarmer = () => { void orig(first).catch(() => { /* played on demand instead */ }); };
        } catch (e) { console.warn('[tor] music preload left as the engine does it:', e); }
    }

    private musicWarmer: (() => void) | null = null;

    /**
     * Start fetching + decoding the first world's loop (once), as soon as the animal has landed (it is 0.45 MB, the song 0.93: together on a slow link the animal took twice as
     * long and Play / ROLL had to wait for it), or after 2.5 s whatever the animal is doing. Harmless when the loop is not held back or already warm.
     */
    warmMusic(): void {
        const w = this.musicWarmer;
        this.musicWarmer = null;
        if (!w) return;
        const cap = new Promise<void>((r) => window.setTimeout(r, 2500));
        void Promise.race([this.animalReady, cap]).then(w);
    }

    /** A decoded loop is ~23 MB: keep only the one that is playing (a world change fetches the next one). */
    private evictOtherMusic(keepWorld: string): void {
        if (!this.musicCache) return;
        const keep = this.musicUrls.get(keepWorld);
        for (const url of this.musicUrls.values()) if (url !== keep) this.musicCache.delete(url);
    }

    private async loadStageByName(name: string): Promise<void> {
        const scene = this.engine.scene!;
        const loaded = await loadStageAsset(this.engine, this.gameData, name);
        this.ball.root.removeFromParent();
        this.retireStage();   // the old stage stays in memory (hidden) for a few frames, see retireStage()
        this.view = new StageView(loaded);
        this.sim = new StageSim(loaded.data);
        this.items = new ItemsView(this.view, this.sim);
        scene.add(this.view.root);
        if (!this.playerProxy.parent) scene.add(this.playerProxy);
        this.view.content.add(this.ball.root);
        if (!this.ballLoaded) {
            this.ballLoaded = true;
            const c = CHARACTERS.find((x) => x.id === this.save.character) ?? CHARACTERS[0]!;
            this.ball.setTint(c.tint);
            this.animalReady = this.ball.setAnimal(this.engine, this.gameData, c.id).catch((e) => console.warn('[tor] animal failed', e));
        }
        this.applyStageLook(loaded.data.world, loaded.look);
        this.timeLeft = loaded.data.time;
        this.cam.startIntro(this.introKeys());
        this.cam.mode = 'intro';
        this.syncViews(0);
        console.log('[tor] stage loaded', loaded.data.name, 'tris', loaded.data.groups.reduce((n, g) => n + g.meshes.reduce((m, x) => m + x.triCount, 0), 0));
    }

    /** Stages taken out of play; their GPU resources are released a few frames after the next stage first rendered (see retireStage). */
    private retired: { view: StageView; items: ItemsView | null; frames: number }[] = [];

    /**
     * Hide the current stage and queue it for disposal. three.js deletes a pipeline / shader when the last render object using it is disposed, so
     * disposing the old stage BEFORE the new one had rendered threw away every compiled comic-material pipeline and the new stage compiled them all
     * again (25-54 shader modules and 18-46 pipelines per swap: a 100-470 ms hitch). Kept alive until the new stage has drawn, the shared pipelines
     * are simply reused and only genuinely new material variants compile.
     */
    private retireStage(): void {
        const view = this.view;
        if (!view) return;
        view.root.visible = false;
        this.retired.push({ view, items: this.items ?? null, frames: 4 });
    }

    private flushRetired(force = false): void {
        for (let i = this.retired.length - 1; i >= 0; i--) {
            const r = this.retired[i]!;
            if (!force && --r.frames > 0) continue;
            r.items?.dispose();
            r.view.dispose();
            this.retired.splice(i, 1);
        }
    }

    /**
     * Theme the scene for a stage: its world (worlds.ts) with the stage's look on top (looks.ts; null = the world as it is). Nothing is re-applied
     * while world and look stay the same; the music follows the world only.
     */
    private applyStageLook(id: string, look: StageLook | null): void {
        const key = `${id}|${look?.id ?? ''}`;
        if (key === this.lookKey) return;
        const worldChanged = id !== this.currentWorld;
        this.lookKey = key;
        this.currentWorld = id;
        this.look = look;
        const w = worldTheme(id);
        const e = this.engine;
        const scene = e.scene!;
        const fogBefore = scene.fog;
        this.capturePostBase();
        e.applyLightingConfig?.({ ...w.lighting, ...look?.lighting });
        e.applyFogConfig?.({ ...w.fog, ...look?.fog });
        this.keepFogObject(scene, fogBefore);
        setComicStyle({ ...w.comic, ...look?.comic });
        e.setColorGrading?.({ enabled: true, ...w.grade, ...look?.grade });
        this.applyLookPost(look);
        // A world without a panorama of its own (the Pumpkin Patch) uses world.json's sky, the one loaded at boot. It must be put BACK when the
        // previous stage swapped in another world's: before this, a Beginner stage played after a Graveyard or Workshop one kept their sky.
        const base = (this.gameData as unknown as { worldProfileData?: { skyboxUrl?: string } } | null)?.worldProfileData?.skyboxUrl ?? null;
        // worlds.ts and looks.ts name their skies by game-asset: URL, and the engine resolves only world.json's
        const named = look?.sky ?? w.sky.url ?? base;
        const sky = named === null ? null : resolveGameAssetUrl(named);
        if (sky && sky !== (this.skyUrl ?? base)) { this.skyUrl = sky; void this.hooks.setSky?.(sky).then(() => shapeSky(this.engine.scene!, w.sky.shape)); }
        else shapeSky(this.engine.scene!, w.sky.shape);
        this.ball.setLook({ glass: look?.glass ?? null, character: look?.character ?? null, ground: look?.ground ?? null });
        setCandyLook(look?.candy ?? null);
        if (worldChanged && w.music && this.started) void this.engine.playMusic(w.music, { volume: 0.55 }).then(() => this.evictOtherMusic(id)).catch(() => { /* asset not added yet */ });
    }
    /** The stage look in force (null: the world as it is). */
    private look: StageLook | null = null;

    /** The engine's post-processing calls the looks use (render config and bloom are not on EngineLike). */
    private get post(): EnginePost { return this.engine as unknown as EnginePost; }

    /** world.json's exposure, vignette and bloom, read once before any stage look has touched them. */
    private capturePostBase(): void {
        if (this.basePost) return;
        const rc = this.post.getRenderConfig?.() ?? null;
        const b = (this.gameData as unknown as { worldProfileData?: { bloomConfig?: { enabled: boolean; strength?: number; radius?: number; threshold?: number } } } | null)?.worldProfileData?.bloomConfig;
        this.basePost = {
            render: rc ? { exposure: rc.exposure, vignette: rc.vignette ? { ...(rc.vignette as object) } : undefined } : null,
            bloom: b ? { enabled: b.enabled, strength: b.strength ?? 0.4, radius: b.radius ?? 0.5, threshold: b.threshold ?? 0.95 } : null,
        };
    }

    /**
     * Exposure, vignette and bloom of a look, and world.json's own back when a look that changed them is left. Exposure is changed on the LIVE render
     * config (it also carries the colour grade the world has just set, which must survive); nothing is touched while no look asks for it.
     */
    private applyLookPost(look: StageLook | null): void {
        const e = this.post;
        const base = this.basePost!;
        const wants = !!look && (look.exposure !== undefined || look.bloom !== undefined || look.vignette !== undefined);
        if (!wants && !this.postFromLook) return;
        this.postFromLook = wants;
        const live = e.getRenderConfig?.() ?? null;
        const exposure = look?.exposure ?? base.render?.exposure;
        if (live && exposure !== undefined && live.exposure !== exposure) e.applyRenderConfig?.({ ...live, exposure });
        e.setVignette?.({ ...((base.render?.vignette ?? {}) as Record<string, unknown>), ...look?.vignette });
        const bloom = look?.bloom ? { enabled: true, ...look.bloom } : base.bloom;
        if (bloom) e.setupBloom?.(bloom);
    }

    /**
     * The engine's applyFogConfig replaces scene.fog with a NEW THREE.Fog every time (and applyLightingConfig calls it too). three.js keys every render
     * object on the fog node, and that node is cached per fog OBJECT, so a new object recompiled every material, the animal and the effects on each
     * world change (17-36 pipelines, 100-350 ms). The values are copied onto the old object, which goes back into the scene: same look, no recompile.
     */
    private keepFogObject(scene: THREE.Scene, before: THREE.Scene['fog']): void {
        const now = scene.fog as THREE.Fog | null;
        const old = before as THREE.Fog | null;
        if (!old || !now || old === now || !old.isFog || !now.isFog) return;
        old.color.copy(now.color);
        old.near = now.near;
        old.far = now.far;
        scene.fog = old;
    }

    private introKeys(): IntroKey[] {
        const d = this.sim.stage;
        if (d.intro.length >= 2) return d.intro;
        const g = this.sim.goals[0]!.pos, s = this.sim.start.pos;
        return [
            { pos: [g.x, g.y + 9, g.z + 12], look: [g.x, g.y, g.z], t: 0 },
            { pos: [(g.x + s.x) / 2, g.y + 14, (g.z + s.z) / 2], look: [(g.x + s.x) / 2, 0, (g.z + s.z) / 2], t: 3 },
            { pos: [s.x, s.y + 6, s.z - 9], look: [s.x, s.y, s.z + 2], t: 6 },
        ];
    }

    private installStateListener(): void {
        const gsm = getGameStateManager();
        const onState = (s: GameState, was: GameState) => {
            this.input.recenterMouse();
            if (s === GameState.PAUSED) this.input.release();   // P or the pad's Start paused with the mouse held: the card needs the real cursor
            // Resume (the click or key press on the card is the gesture the browser wants): take the mouse again, as the stage had it
            else if (s === GameState.PLAYING && was === GameState.PAUSED && (this.phase === 'play' || this.phase === 'ready')) this.input.capture();
            if (s === GameState.PLAYING && !this.started) this.begin();
        };
        this.stateListener = onState;
        gsm.addListener(onState);
        if (gsm.isState(GameState.PLAYING)) this.begin();
    }

    /** First transition into PLAYING (the Play press): audio, HUD, then straight into the menu (or the ?stage= stage). */
    private begin(): void {
        if (this.started) return;
        this.started = true;
        this.engine.setMuteHotkeyEnabled?.(false);
        this.sfx.init();
        this.hud.create();
        const w = worldTheme(this.currentWorld);
        if (w.music) void this.engine.playMusic(w.music, { volume: 0.55 }).catch(() => { /* asset not added yet */ });
        if (this.urlStage) {
            this.practiceMode = true;
            this.session.practice = true;
            this.refreshHud();
            this.startStage(true);
        } else {
            // most players pick the first course: have its first stage on its way while they read the menu
            const firstStage = COURSES[0]?.stages[0];
            if (firstStage && firstStage !== this.sim.stage.name) prefetchStageBytes(this.gameData, firstStage, true);
            this.showMenu('main');
        }
    }

    // ------------------------------------------------------------------ menu + run control

    private showMenu(screen: 'main' | 'course' | 'practice-course' | 'practice-stage' | 'character' = 'main'): void {
        this.setPhase('menu');
        this.hud.setVisible(false);
        this.hud.clearBanner();
        this.hud.clearHint();
        this.hud.hidePanel();
        this.input.locked = false;
        this.input.clearPresses();   // keys pressed in the stage (or on the pause card) must not drive the menu
        this.sim.reset();
        this.acc = 0;
        this.cam.mode = 'hold';
        this.menus.show(screen);
    }

    private pickCharacter(c: CharacterDef): void {
        this.save.character = c.id;
        writeSave(this.save);
        this.ball.setTint(c.tint);
        this.animalReady = this.ball.setAnimal(this.engine, this.gameData, c.id).catch((e) => console.warn('[tor] animal failed', e));
    }

    /**
     * Start fetching and building the animal now, before the first stage has loaded (the first stage load would start it only after that stage's CPU-bound setup): Game.load
     * calls this the moment the stage's bytes are in, so the animal's download overlaps the setup and is there when the game is ready.
     */
    warmAnimal(): void {
        if (this.ballLoaded) return;
        const c = CHARACTERS.find((x) => x.id === this.save.character) ?? CHARACTERS[0]!;
        this.animalReady = this.ball.setAnimal(this.engine, this.gameData, c.id).catch((e) => console.warn('[tor] animal failed', e));
    }

    /**
     * The pick screen (CharacterSelect.ts) chose `id`: the ball's animal and glass tint follow, even before the first stage has loaded (that load then builds
     * this animal itself). Returns nothing when the animal is already on the ball, else a promise that settles when it is (or when its load failed: the ball keeps
     * the animal it has). `persist` (ROLL was pressed: the game starts) writes the choice to the save; selecting cards only previews it.
     */
    selectCharacter(id: string, persist = false): Promise<void> | void {
        const c = CHARACTERS.find((x) => x.id === id);
        if (!c) return;
        this.save.character = c.id;
        if (persist) writeSave(this.save);
        this.ball.setTint(c.tint);
        if (!this.ballLoaded || this.ball.animalName === c.id) return;
        const p = this.ball.setAnimal(this.engine, this.gameData, c.id).catch((e) => console.warn('[tor] animal failed', e));
        this.animalReady = p;
        return p;
    }

    private startRun(course: CourseDef, stageIndex: number, practice: boolean): void {
        this.session = new Session(course);
        this.session.stageIndex = stageIndex;
        this.session.practice = practice;
        this.practiceMode = practice;
        this.runLostLife = false;
        this.hud.setVisible(true);
        this.input.capture();   // this runs inside the click / key press that chose the course: the mouse can be captured now
        void this.goToStage(this.session.stageName, true);
    }

    // ------------------------------------------------------------------ stage flow

    private refreshHud(): void {
        this.hud.setLives(this.session.practice ? 99 : this.session.lives);
        this.hud.setCandy(this.session.candy);
        this.hud.setStage(this.urlStage ? '*' : String(this.session.stageNumber));
        this.hud.setTime(this.timeLeft);
    }

    /** Warm the HTTP cache with the next stage's GLB while this one is played, so the wait between stages is short. */
    private prefetchNext(): void {
        const next = this.session.course.stages[this.session.stageIndex + 1];
        const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
        if (!next || this.session.practice || conn?.saveData) return;
        try { prefetchStageBytes(this.gameData, next, true); } catch { /* it loads when needed */ }
    }

    private startStage(withIntro: boolean): void {
        this.menus.markPlayed();   // from now on the title menu carries the exchange's "Up next" tile
        this.input.clearPresses();
        this.input.capture();   // next stage / retry: called from the confirm press that dismissed the result
        this.prefetchNext();
        this.session.beginStage();
        this.sim.reset();
        this.acc = 0;
        this.stageCandy = 0;
        this.timeLeft = this.sim.stage.time;
        this.input.locked = false;
        this.sfx.resetTick();
        this.hud.setVisible(true);
        this.hud.clearBanner();
        this.hud.hidePanel();
        this.refreshHud();
        this.syncViews(0);
        if (withIntro) {
            this.cam.startIntro(this.introKeys());
            this.setPhase('intro');
            this.hud.banner(this.session.practice ? 'PRACTICE' : `STAGE ${this.session.stageNumber}`, this.sim.stage.title, 2600, 'info');
        } else {
            this.snapCamera();
            this.setPhase('ready');
        }
    }

    private async goToStage(name: string, withIntro = true): Promise<void> {
        this.setPhase('loading');
        this.loadFailed = false;
        this.hud.banner('LOADING', '', 0, 'info');
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await this.loadStageByName(name);
                this.startStage(withIntro);
                return;
            } catch (e) {
                console.error(`[tor] stage load failed (attempt ${attempt})`, e);
                if (attempt < 2) await new Promise((r) => window.setTimeout(r, 1200));   // a flaky connection: try once more
            }
        }
        this.loadFailed = true;
        this.hud.banner('OOPS', 'Could not load the stage. Check your connection, then tap to go back', 0, 'fall');
    }

    private snapCamera(): void {
        this.cam.mode = 'chase';
        this.sim.worldBallPos(tmpW);
        const yaw = Number(this.sim.start.extras.yaw ?? 0);
        this.cam.snapTo(tmpV.set(tmpW.x, tmpW.y, tmpW.z), yaw);
    }

    private setPhase(p: Phase): void {
        this.phase = p;
        this.phaseT = 0;
        if (p === 'ready') { this.sim.restartClock(); this.sim.animHold = true; }   // movers wait at their start poses until GO: every attempt begins from the same phase
        if (p === 'play') this.sim.animHold = false;
        if (p === 'ready' || p === 'play') this.input.recenterMouse();   // the virtual mouse pointer always starts a stage in the middle
        if (p === 'ready') { this.hud.banner('READY?', '', 1500, 'ready'); this.sfx.ready(); }
    }

    // ------------------------------------------------------------------ frame

    /** Called every frame by the engine (dt = 0 while paused). */
    update(dt: number): void {
        if (this.disposed || !this.sim) return;
        this.tune.update();
        if (this.retired.length) this.flushRetired();
        const nowReal = this.debugTime ?? performance.now() / 1000;
        const rdt = Math.min(0.05, nowReal - this.lastReal);
        this.lastReal = nowReal;
        const gsm = getGameStateManager();
        const paused = gsm.isState(GameState.PAUSED);
        const playing = gsm.isState(GameState.PLAYING);
        const cdt = paused ? 0 : rdt;                 // cosmetic clock (keeps the menu backdrop alive)
        const sdt = playing ? Math.min(dt, 0.1) : 0;  // gameplay clock

        // camera aspect: give portrait phones a wider vertical view so the path stays visible
        const aspect = window.innerWidth / Math.max(1, window.innerHeight);
        const baseFov = aspect < 1 ? Math.min(84, 58 + (1 - aspect) * 62) : 58;
        const spd = Math.hypot(this.sim.v.x, this.sim.v.z);
        this.fovKick += ((this.phase === 'play' ? Math.max(0, Math.min(1, (spd - 10) / 16)) * 7 : 0) - this.fovKick) * Math.min(1, rdt * 3);
        this.cam.fov = baseFov + this.fovKick;

        if (this.bot && this.phase === 'play') { this.bot.stick(this.sim, this.cam.yaw, this.botStick); this.input.override = this.botStick; }
        this.input.showRing = this.phase === 'play' || this.phase === 'ready';
        this.input.tapConfirm = this.phase === 'intro' || this.phase === 'goal' || this.phase === 'result' || this.phase === 'gameover' || this.phase === 'courseclear' || this.loadFailed;
        this.input.wantCapture = ['intro', 'loading', 'ready', 'play', 'goal', 'fall', 'timeover'].includes(this.phase);
        this.input.update(cdt);
        if (!this.started) { this.attract(cdt); return; }
        if (this.phase === 'loading') {
            if (this.loadFailed && this.input.take('confirm')) { this.loadFailed = false; this.hud.clearBanner(); this.showMenu('main'); }
            return;
        }
        if (this.input.take('pause') && playing && this.phase !== 'menu') gsm.setPaused(true, 'manual');

        this.phaseT += sdt;
        this.acc += sdt;
        const controls = this.phase === 'play';
        const demo = this.menuDemoOn();
        if (demo !== this.demoWasOn) {   // entering / leaving the demo (the character preview stands still at the start): start the ball from rest
            if (this.phase === 'menu') { this.sim.reset(); this.acc = 0; }
            this.demoBot?.reset(); this.demoT = 0; this.demoEnd = 0;
            this.demoWasOn = demo;
        }
        let steps = 0;
        while (!this.debugFreeze && this.acc >= STEP && steps < 6) {
            this.acc -= STEP;
            steps++;
            if (demo) { this.stepDemo(); continue; }
            this.sim.step(STEP, this.input.stick.x, this.input.stick.y, this.cam.yaw, controls);
            this.dispatchFx();
            if (this.phase === 'play') {
                this.timeLeft -= STEP;
                this.handleEvents();
                if (this.timeLeft <= 0 && this.phase === 'play') { this.timeLeft = 0; this.failStage('time'); }
            } else if (this.phase === 'goal' || this.phase === 'result') {
                this.handleEvents();
            }
        }
        if (steps === 6) this.acc = 0;

        if (this.phase === 'menu') this.menus.nav(this.input.stick, (a) => this.input.take(a), cdt, this.input.stickFromKeys);
        this.updatePhase();
        this.syncViews(cdt);
        this.fx.update(cdt);
        this.hud.setTime(this.timeLeft);
        if (this.phase === 'play') { this.sfx.tick(this.timeLeft); this.fx.speedLines(Math.hypot(this.sim.v.x, this.sim.v.z), cdt); } else this.fx.speedLines(0, cdt);
        this.hud.setSpeed(Math.hypot(this.sim.v.x, this.sim.v.y, this.sim.v.z));
        const speed = Math.hypot(this.sim.v.x, this.sim.v.z);
        if (this.phase === 'play' || this.phase === 'goal') this.sfx.roll(speed, this.sim.grounded); else this.sfx.silenceRoll();

        this.sim.worldBallPos(tmpW);
        tmpV.set(tmpW.x, tmpW.y, tmpW.z);
        this.sim.worldBallVel(tmpW);
        tmpV2.set(tmpW.x, tmpW.y, tmpW.z);
        if (this.phase === 'menu') this.menuCamera(cdt, tmpV, nowReal);
        else this.cam.update(cdt, tmpV, tmpV2, this.input.camera, nowReal, this.sim.tiltPitch);
        this.playerProxy.position.copy(tmpV);
        this.applyDebugCam();
    }

    /** The demo runs behind every menu screen except the character preview (that one shows the animal standing still, waving). */
    private menuDemoOn(): boolean {
        return this.phase === 'menu' && !this.menus.onCharacterScreen && !this.debugFreeze && !this.debugCam;
    }

    /** One fixed step of the menu demo: a gentle route bot drives the stage; after the goal or a fall it starts over. Silent (no FX, no sounds). */
    private stepDemo(): void {
        const st = this.sim.stage;
        if (!this.demoBot || this.demoFor !== st) {
            const route = (st.extras.route as number[][] | undefined) ?? [];
            if (route.length < 2) { this.sim.step(STEP, 0, 0, 0, false); return; }
            this.demoBot = new RouteBot(route, { vmax: 4.8, look: 3.6 }, (st.extras.waits as never[]) ?? []);
            this.demoFor = st; this.demoT = 0; this.demoEnd = 0;
            this.demoHeading = Number(this.sim.start.extras.yaw ?? 0);
        }
        this.demoBot.stick(this.sim, 0, this.demoStick);
        this.sim.step(STEP, this.demoStick.x, this.demoStick.y, 0, !this.sim.goalHit);
        this.demoT += STEP;
        if (this.sim.goalHit || this.sim.fallen || this.demoT > 80) {
            this.demoEnd += STEP;
            if (this.demoEnd > 1.4 || this.sim.fallen || this.demoT > 80) { this.sim.reset(); this.demoBot.reset(); this.demoT = 0; this.demoEnd = 0; }
        }
    }

    /**
     * A window taller than it is wide stacks the menu at the bottom of the screen (Menus.ts): the ball is then framed in the band above the column, not beside it. How far the camera pulls back
     * (so the ball is smaller than that band) and how far it tilts down (so the ball sits in the middle of it) come from the band's size and the lens.
     */
    private portraitFrame(): { scale: number; ndcY: number } {
        const H = window.innerHeight;
        const inset = safeInsets().top;
        const top = this.menus.topEdge || H * 0.55;
        const band = Math.max(90, top - inset - 28);
        const centreY = inset + 14 + band / 2;
        const fov = THREE.MathUtils.degToRad(this.cam.fov);
        const need = 0.6 / Math.tan(0.4 * band * fov / H);   // distance at which the ball (radius ~0.6 m) fills 80 % of the band
        return { scale: THREE.MathUtils.clamp(need / 3.85, 1, 2.2), ndcY: 1 - 2 * centreY / H };
    }

    /** Where to aim the camera so that the ball appears `ndcY` above the centre of the screen (NDC units): pitch the view down by the angle that much of the lens spans. */
    private frameLook(ball: THREE.Vector3, ndcY: number, out: THREE.Vector3): THREE.Vector3 {
        const dir = tmpV2.subVectors(ball, this.cam.pos);
        const len = dir.length();
        const right = tmpV3.crossVectors(dir, UP).normalize();
        const theta = Math.atan(ndcY * Math.tan(THREE.MathUtils.degToRad(this.cam.fov) / 2));
        return out.copy(this.cam.pos).addScaledVector(dir.normalize().applyAxisAngle(right, -theta), len);
    }

    /** Slow orbit around the ball (or, while the demo rolls, a chase view); the ball sits on the side of the screen the menu panel leaves free (above the menu, in a window taller than wide). */
    private menuCamera(cdt: number, ball: THREE.Vector3, t: number): void {
        const frame = this.menus.stacked ? this.portraitFrame() : null;
        const k = frame?.scale ?? 1;
        const look = tmpLook;
        if (this.menuDemoOn()) {
            this.sim.worldBallVel(tmpW);
            if (Math.hypot(tmpW.x, tmpW.z) > 1.5) {
                let d = Math.atan2(tmpW.x, tmpW.z) - this.demoHeading;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                this.demoHeading += d * Math.min(1, cdt * 1.6);
            }
            const fx = Math.sin(this.demoHeading), fz = Math.cos(this.demoHeading);
            const rx = -fz, rz = fx;   // screen right of the travel direction
            const follow = Math.min(1, cdt * 5);
            const side = frame ? 0 : 0.3;
            this.cam.pos.lerp(tmpV3.set(ball.x - fx * 3.5 * k - rx * side, ball.y + 1.6 * k, ball.z - fz * 3.5 * k - rz * side), follow);
            this.cam.look.lerp(frame ? this.frameLook(ball, frame.ndcY, look) : tmpV2.set(ball.x + rx * 1.05, ball.y + 0.3, ball.z + rz * 1.05), Math.min(1, cdt * 6));
            this.cam.update(0, ball, tmpV2.set(0, 0, 0), 0, t);
            return;
        }
        const a = t * 0.32;
        this.cam.pos.lerp(tmpV3.set(ball.x + Math.sin(a) * 2.7 * k, ball.y + 1.0 * k, ball.z + Math.cos(a) * 2.7 * k), Math.min(1, cdt * 4));
        if (frame) this.cam.look.lerp(this.frameLook(ball, frame.ndcY, look), Math.min(1, cdt * 5));
        else {
            tmpV2.subVectors(ball, this.cam.pos).normalize();
            tmpV3.crossVectors(tmpV2, UP).normalize();
            const side = this.menus.onCharacterScreen ? -1 : 1;
            this.cam.look.lerp(tmpV2.copy(ball).addScaledVector(tmpV3, side * 0.85).add(UP.clone().multiplyScalar(0.1)), Math.min(1, cdt * 5));
        }
        this.cam.update(0, ball, tmpV2.set(0, 0, 0), 0, t);
    }

    private applyDebugCam(): void {
        if (this.debugFollow) {   // look-dev: ride alongside the ball, every frame
            const f = this.debugFollow, c = this.engine.getDefaultCamera();
            this.sim.worldBallPos(tmpW);
            const yaw = this.cam.yaw, rx = -Math.cos(yaw), rz = Math.sin(yaw);
            c.position.set(tmpW.x + rx * f.side - Math.sin(yaw) * f.back, tmpW.y + f.up, tmpW.z + rz * f.side - Math.cos(yaw) * f.back);
            c.lookAt(tmpW.x, tmpW.y - 0.05, tmpW.z);
            if (c.fov !== f.fov) { c.fov = f.fov; c.updateProjectionMatrix(); }
            return;
        }
        if (!this.debugCam) return;
        const c = this.engine.getDefaultCamera();
        c.position.set(...this.debugCam.p);
        c.lookAt(...this.debugCam.l);
        if (this.debugCam.fov && c.fov !== this.debugCam.fov) { c.fov = this.debugCam.fov; c.updateProjectionMatrix(); }
    }

    private attract(cdt: number): void {
        // behind the start card: the stage keeps animating while a slow camera drifts over the start
        this.sim.step(cdt > 0 ? cdt : 0, 0, 0, 0, false);
        this.syncViews(cdt);
        const t = performance.now() / 1000;
        const s = this.sim.start.pos;
        this.cam.mode = 'hold';
        this.cam.pos.set(s.x + Math.sin(t * 0.2) * 9, s.y + 5.5, s.z - 10 + Math.cos(t * 0.2) * 2);
        this.cam.look.set(s.x, s.y + 1, s.z + 6);
        this.cam.update(cdt, tmpV.set(s.x, s.y, s.z), tmpV2.set(0, 0, 0), 0, t);
        this.playerProxy.position.set(s.x, s.y, s.z + 3);
        this.applyDebugCam();
    }

    // ------------------------------------------------------------------ rules

    private handleEvents(): void {
        for (const ev of this.sim.events) {
            switch (ev.type) {
                case 'candy': {
                    if (this.phase !== 'play') break;
                    this.stageCandy += ev.value;
                    const ups = this.session.addCandy(ev.value);
                    this.hud.setCandy(this.session.candy);
                    if (ups > 0) { this.hud.setLives(this.session.lives); this.hud.banner('1UP!', '', 1100, 'info'); this.sfx.oneUp(); }
                    if (ups > 0 && !this.session.practice) unlock(this.engine, 'sweet_tooth');
                    break;
                }
                case 'goal':
                    if (this.phase === 'play') this.stageClear(ev.tier);
                    break;
                case 'fall':
                    if (this.phase === 'play') this.failStage('fall');
                    break;
                default: break;
            }
        }
    }

    private stageClear(tier: string): void {
        this.setPhase('goal');
        unlock(this.engine, 'first_goal');
        if (this.timeLeft < PHOTO_FINISH_SECONDS) unlock(this.engine, 'photo_finish');
        this.input.locked = true;
        this.sfx.goal();
        const res = this.session.clearStage(this.timeLeft);
        this.pendingResult = { ...res, timeLeft: this.timeLeft, tier };
        this.hud.banner('GOAL!', '', 2600, 'goal');
        this.sim.worldBallPos(tmpW);
        this.cam.startOrbit(tmpV.set(tmpW.x, tmpW.y, tmpW.z));
        const name = this.urlStage ?? this.session.course.stages[this.session.stageIndex - 1] ?? this.sim.stage.name;
        const prev = this.save.best[name];
        if (!prev || this.timeLeft > prev.timeLeft) this.save.best[name] = { timeLeft: +this.timeLeft.toFixed(2), candy: this.stageCandy };
        if (!this.session.practice) {
            const c = this.session.course.id;
            this.save.cleared[c] = Math.max(this.save.cleared[c] ?? 0, this.session.stageIndex);
        }
        this.save.highScore = Math.max(this.save.highScore, this.session.score);
        writeSave(this.save);
    }

    private failStage(kind: 'fall' | 'time' | 'retry'): void {
        this.input.locked = true;
        this.cam.mode = 'hold';
        this.setPhase(kind === 'time' ? 'timeover' : 'fall');
        this.hud.banner(kind === 'time' ? 'TIME OVER' : kind === 'retry' ? 'RETRY' : 'FALL OUT', '', 1700, kind === 'time' ? 'time' : 'fall');
        if (kind === 'time') this.sfx.timeUp(); else { this.sfx.fall(); this.sfx.squeak(0.3); }
    }

    private updatePhase(): void {
        switch (this.phase) {
            case 'intro':
                if (this.cam.introProgress() >= 1 || this.input.take('confirm')) { this.cam.skipIntro(); this.snapCamera(); this.setPhase('ready'); }
                break;
            case 'ready':
                if (this.phaseT > 1.5) {
                    this.setPhase('play'); this.hud.banner('GO!', '', 700, 'go'); this.sfx.go();
                    if (!this.save.hinted) {
                        this.save.hinted = true; writeSave(this.save);
                        this.hud.hint(this.input.lastDevice === 'touch' || matchMedia('(pointer: coarse)').matches
                            ? 'Drag on the <b>LEFT</b> to tilt  ·  on the <b>RIGHT</b> to turn the camera'
                            : '<b>WASD</b> / <b>ARROWS</b> tilt  ·  <b>M</b> mouse tilt  ·  <b>Q / E</b> camera', 8000);
                    }
                }
                break;
            case 'play':
                if (this.input.take('retry')) this.failStage('retry');
                break;
            case 'goal':
                if (this.phaseT > 2.8) this.showResult();
                break;
            case 'result':
                if (this.phaseT > 1.0 && (this.input.take('confirm') || this.phaseT > 6)) this.nextAfterClear();
                break;
            case 'fall':
            case 'timeover':
                if (this.phaseT > 2.0) {
                    if (!this.session.practice) this.runLostLife = true;
                    if (this.session.loseLife()) { this.refreshHud(); this.startStage(false); }
                    else this.showGameOver();
                }
                break;
            case 'gameover':
            case 'courseclear':
                if (this.phaseT > 1.0 && this.input.take('confirm')) {
                    if (this.urlStage) { this.session.reset(); this.session.practice = true; void this.goToStage(this.urlStage, true); }
                    else { this.hud.hidePanel(); this.showMenu('main'); }
                }
                break;
            default: break;
        }
    }

    /** The line under a result panel. A phone has no SPACE to press. */
    private continueHint(): string { return isMobileRuntime() ? 'Tap to continue' : 'Press SPACE or tap to continue'; }

    private showResult(): void {
        const r = this.pendingResult!;
        this.setPhase('result');
        this.hud.setLives(this.session.lives);
        this.hud.panel(
            `<h2>STAGE CLEAR!</h2>
             <table>
               <tr><td>Candy</td><td>${r.stageCandy}</td><td>${(r.stageCandy * 100).toLocaleString()}</td></tr>
               <tr><td>Time bonus</td><td>${Math.floor(r.timeLeft)} s</td><td>${r.timeBonus.toLocaleString()}</td></tr>
             </table>
             <div class="total">SCORE ${this.session.score.toLocaleString()}</div>
             <div class="hint">${this.continueHint()}</div>`,
        );
    }

    private nextAfterClear(): void {
        this.hud.hidePanel();
        if (this.urlStage) { this.session.stageIndex = 0; void this.goToStage(this.urlStage, true); return; }
        if (this.practiceMode) { this.showMenu('practice-stage'); return; }
        if (this.session.stageIndex >= this.session.course.stages.length) { this.showCourseClear(); return; }
        void this.goToStage(this.session.stageName, true);
    }

    private showGameOver(): void {
        this.setPhase('gameover');
        this.hud.panel(`<h2>GAME OVER</h2><div class="total">SCORE ${this.session.score.toLocaleString()}</div><div class="hint">${this.continueHint()}</div>`, true);
    }

    private showCourseClear(): void {
        this.setPhase('courseclear');
        unlock(this.engine, COURSE_CLEARED[this.session.course.id]);
        if (!this.runLostLife) unlock(this.engine, 'not_a_scratch');
        this.hud.panel(`<h2>${this.session.course.title.toUpperCase()} CLEAR!</h2><div class="total">SCORE ${this.session.score.toLocaleString()}</div><div class="hint">${this.continueHint()}</div>`, true);
    }

    // ------------------------------------------------------------------ views + feedback

    private syncViews(cdt: number): void {
        this.view.sync(this.sim);
        this.sim.worldBallVel(tmpW);
        tmpV.set(tmpW.x, tmpW.y, tmpW.z);
        tmpQ.set(this.sim.stageQuat.x, this.sim.stageQuat.y, this.sim.stageQuat.z, this.sim.stageQuat.w);
        let faceYaw: number | null = null;
        if (this.phase === 'menu' && !this.menuDemoOn()) {   // showcase: the animal turns to look at the camera
            this.sim.worldBallPos(tmpW);
            faceYaw = Math.atan2(this.cam.pos.x - tmpW.x, this.cam.pos.z - tmpW.z);
        }
        if (this.debugFaceYaw !== null) faceYaw = this.debugFaceYaw;
        this.ball.mood = this.phase === 'menu' ? (this.menuDemoOn() ? 'run' : 'wave') : this.phase === 'goal' || this.phase === 'result' ? 'cheer' : this.phase === 'fall' || this.phase === 'timeover' ? 'panic' : 'run';
        this.ball.update(this.sim, Math.min(cdt, 0.05), tmpV, tmpQ, this.cam.yaw, faceYaw);
        this.items?.update(this.sim, this.lastReal, this.engine.getDefaultCamera());
    }

    /** Sim events that only need feedback (particles, lettering, sound), in every phase. */
    private dispatchFx(): void {
        for (const ev of this.sim.events) {
            switch (ev.type) {
                case 'candy': {
                    this.sim.toWorld(ev.pos, tmpW);
                    tmpV.set(tmpW.x, tmpW.y, tmpW.z);
                    this.fx.candy(tmpV, this.items?.colorOf(ev.item) ?? '#ffd534', ev.value >= 10);
                    const quiet = ev.value < 10 ? this.look?.candyPop ?? null : null;
                    if (quiet) this.fx.pop('+1', tmpV.clone().add(new THREE.Vector3(0, quiet.lift, 0)), '', 0.7, quiet.size, quiet.opacity);
                    else this.fx.pop(ev.value >= 10 ? '+10' : '+1', tmpV.clone().add(new THREE.Vector3(0, 0.6, 0)), ev.value >= 10 ? 'pink' : '', 0.7, ev.value >= 10 ? 1.1 : 0.7);
                    this.sfx.candy(ev.value);
                    break;
                }
                case 'impact': {
                    this.sim.toWorld(ev.pos, tmpW);
                    tmpV.set(tmpW.x, tmpW.y, tmpW.z);
                    tmpV2.set(ev.normal.x, ev.normal.y, ev.normal.z).applyQuaternion(tmpQ.set(this.sim.stageQuat.x, this.sim.stageQuat.y, this.sim.stageQuat.z, this.sim.stageQuat.w));
                    this.fx.impact(tmpV, tmpV2, ev.speed);
                    if (ev.speed > 11) this.fx.pop(ev.speed > 17 ? 'BAM!' : 'BONK!', tmpV.clone().add(new THREE.Vector3(0, 0.8, 0)), 'blue', 0.65, 0.9);
                    if (ev.speed > 9) this.cam.addShake(Math.min(0.6, ev.speed / 40));
                    this.sfx.impact(ev.speed);
                    break;
                }
                case 'bump': {
                    this.sim.toWorld(ev.pos, tmpW);
                    tmpV.set(tmpW.x, tmpW.y, tmpW.z);
                    this.fx.impact(tmpV, tmpV2.set(0, 1, 0), 10);
                    this.fx.pop('POING!', tmpV.clone().add(new THREE.Vector3(0, 1.0, 0)), 'green', 0.7, 1.0);
                    this.cam.addKick(0.6);
                    this.sfx.bump(ev.strength);
                    break;
                }
                case 'warp': {
                    this.sim.toWorld(ev.to, tmpW);
                    this.fx.swirl(tmpV.set(tmpW.x, tmpW.y, tmpW.z), '#b67cff');
                    this.fx.pop('WHOOSH!', tmpV.clone().add(new THREE.Vector3(0, 1.2, 0)), 'pink', 0.8, 1.0);
                    this.sfx.warp();
                    break;
                }
                case 'goal': {
                    this.sim.worldBallPos(tmpW);
                    this.fx.confetti(tmpV.set(tmpW.x, tmpW.y, tmpW.z), 1);
                    break;
                }
                default: break;
            }
        }
    }

    private exposeDebug(): void {
        // ?debug=1, or localStorage tor:debug=1 (tools/trailer/record.mjs: the dev shell embeds the game on a fixed URL, so a recording session sets the flag instead)
        let on = new URLSearchParams(window.location.search).has('debug');
        try { on = on || window.localStorage.getItem('tor:debug') === '1'; } catch { /* storage blocked */ }
        if (!on) return;
        const self = this;
        (window as unknown as Record<string, unknown>).__tor = {
            state: () => ({
                phase: self.phase, t: self.timeLeft, candies: self.session.candy, lives: self.session.lives, score: self.session.score,
                stage: self.sim.stage.name, p: self.sim.p.toArray(), v: self.sim.v.toArray(), grounded: self.sim.grounded,
                tilt: [self.sim.tiltPitch, self.sim.tiltRoll], yaw: self.cam.yaw, started: self.started, cp: self.cam.pos.toArray(), cl: self.cam.look.toArray(),
                animal: self.ball.animalName, character: self.save.character,
                wp: (() => { const w = new Vec3(); self.sim.worldBallPos(w); return [w.x, w.y, w.z]; })(),
            }),
            pick: (id: string) => { const c = CHARACTERS.find((x) => x.id === id); if (c) self.pickCharacter(c); },
            /** Generated WGSL sizes of a stage material and the ball's materials (Safari/WebKit rejects big var<private> blocks). */
            wgsl: async () => {
                const r = (self.engine as unknown as { renderer?: { debug?: { getShaderAsync?: (s: unknown, c: unknown, o: unknown) => Promise<{ vertexShader: string; fragmentShader: string }> } } }).renderer;
                const out: Record<string, unknown> = {};
                if (!r?.debug?.getShaderAsync) return { error: 'no getShaderAsync (not the WebGPU renderer?)' };
                const pick = (root: THREE.Object3D, filter: (o: THREE.Mesh) => boolean): THREE.Mesh | null => { let m: THREE.Mesh | null = null; root.traverse((o) => { const mm = o as THREE.Mesh; if (!m && mm.isMesh && mm.visible && filter(mm)) m = mm; }); return m; };
                const targets: Record<string, THREE.Mesh | null> = {
                    stage: pick(self.view.content, () => true),
                    animal: pick(self.ball.root, (m) => (m as THREE.SkinnedMesh).isSkinnedMesh === true),
                    glass: pick(self.ball.root, (m) => (m.material as THREE.Material)?.transparent === true),
                };
                for (const [k, o] of Object.entries(targets)) {
                    if (!o) { out[k] = null; continue; }
                    try {
                        const sh = await r.debug.getShaderAsync(self.engine.scene, self.engine.getDefaultCamera(), o);
                        const priv = sh.fragmentShader.match(/var<private>[^;]*;/g) ?? [];
                        out[k] = { fsBytes: sh.fragmentShader.length, vsBytes: sh.vertexShader.length, privateDecls: priv.length, privateBytes: priv.join('').length };
                    } catch (e) { out[k] = { error: String((e as Error).message ?? e) }; }
                }
                return out;
            },
            /** Transforms of the stage root / content / ball root (world) for debugging placement bugs. */
            xf: () => {
                const w = (o: THREE.Object3D) => { const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(); o.updateWorldMatrix(true, false); o.matrixWorld.decompose(p, q, sc); return { pos: p.toArray().map((v) => +v.toFixed(2)), scale: sc.toArray().map((v) => +v.toFixed(3)), visible: o.visible, parent: o.parent?.type ?? null }; };
                return { root: w(self.view.root), content: w(self.view.content), ball: w(self.ball.root), rootPosLocal: self.view.root.position.toArray().map((v) => +v.toFixed(2)), contentPosLocal: self.view.content.position.toArray().map((v) => +v.toFixed(2)), simP: self.sim.p.toArray().map((v) => +v.toFixed(2)) };
            },
            /** What does a ray from the camera toward the ball hit first? (debugging "something hides the ball") */
            ray: () => {
                const cam = self.engine.getDefaultCamera();
                const from = cam.position.clone();
                const target = new THREE.Vector3(); self.sim.worldBallPos(tmpW); target.set(tmpW.x, tmpW.y, tmpW.z);
                const dir = target.clone().sub(from).normalize();
                const rc = new THREE.Raycaster(from, dir, 0.01, 60);
                (rc as unknown as { camera: THREE.Camera }).camera = cam;
                const hits = rc.intersectObjects(self.engine.scene!.children, true).slice(0, 8);
                const nm = (o: THREE.Object3D) => { const a: string[] = []; let x: THREE.Object3D | null = o; while (x && a.length < 5) { a.push(x.name || x.type); x = x.parent; } return a.join(' < '); };
                return { from: from.toArray().map((v) => +v.toFixed(2)), to: target.toArray().map((v) => +v.toFixed(2)), hits: hits.map((h) => ({ d: +h.distance.toFixed(2), obj: nm(h.object), mat: (h.object as THREE.Mesh).material ? ((h.object as THREE.Mesh).material as THREE.Material).type : null, ctor: (h.object as THREE.Mesh).geometry?.type })) };
            },
            /** tools/perf.mjs: per-frame CPU spans (game parts + engine render), renderer.info and scene statistics. */
            probe: new PerfProbe(self, self.engine),
            /** AO resolution scale at runtime (1 = the engine's full-res AO). */
            aoScale: (v: number) => { self.tune.aoScale = v; self.tune.apply(); },
            time: (t: number | null) => { self.debugTime = t; },
            /** Deterministic pose for image comparisons: the ball back on the start pad, movers at their start poses, nothing stepping. */
            hold: () => { self.sim.reset(); self.debugFreeze = true; self.syncViews(0); },
            route: () => (self.sim.stage.extras.route as number[][] | undefined) ?? [],
            /** What lies under a screen pixel (CSS px)? First hits along the ray with distance, normal and the mesh / material behind them. */
            pickAt: (px: number, py: number) => {
                const cam = self.engine.getDefaultCamera();
                cam.updateMatrixWorld(true);
                const rc = new THREE.Raycaster();
                rc.setFromCamera(new THREE.Vector2((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1), cam);
                const hits = rc.intersectObjects(self.engine.scene!.children, true).filter((h) => (h.object as THREE.Mesh).isMesh && (h.object as THREE.Mesh).visible).slice(0, 8);
                return hits.map((h) => ({ d: +h.distance.toFixed(4), mesh: h.object.name || h.object.type, mat: ((h.object as THREE.Mesh).material as THREE.Material)?.name, n: h.face ? [h.face.normal.x, h.face.normal.y, h.face.normal.z].map((v) => +v.toFixed(2)) : null, pt: h.point.toArray().map((v) => +v.toFixed(3)) }));
            },
            candyCheck: (t: number) => self.items?.debugCheck(self.sim, t),
            candyLegacy: (on: boolean, t: number) => self.items?.debugLegacy(on, self.sim, t),
            profile: (k: 'gentle' | 'normal' | 'quick') => self.input.setKeyProfile(k),
            mouse: (on: boolean) => self.input.setMouseMode(on),
            portraitPose: (mood: string | null, t?: number) => self.ball.holdPose(mood as 'run' | 'cheer' | 'panic' | 'wave' | null, t ?? 0),
            /** Portrait renders: the animal faces this yaw (radians) instead of the menu camera. */
            portraitFace: (yaw: number | null) => { self.debugFaceYaw = yaw; },
            animal: () => self.ball.debugAnimal(),
            animalBox: () => self.ball.debugAnimalBox(),
            eyes: (dyn: boolean, body: boolean) => self.ball.debugEyes(dyn, body),
            follow: (o: { side: number; up: number; back: number; fov: number } | null) => { self.debugFollow = o; },
            rig: (o: { dist?: number; height?: number }) => { if (o.dist !== undefined) self.cam.dist = o.dist; if (o.height !== undefined) self.cam.height = o.height; },
            setStick: (x: number, y: number) => { self.input.override = { x, y }; },
            setV: (x: number, y: number, z: number) => { self.sim.v.set(x, y, z); },
            press: (a: string) => self.input.press(a),
            cam: (p: [number, number, number] | null, l?: [number, number, number], fov?: number) => { self.debugCam = p && l ? { p, l, fov } : null; },
            freeze: (f: boolean) => { self.debugFreeze = f; },
            bot: (on: boolean, opts?: object) => { self.bot = on ? new RouteBot((self.sim.stage.extras.route as number[][]) ?? [], opts, (self.sim.stage.extras.waits as never[]) ?? []) : null; },
            skipTo: (phase: string) => { if (phase === 'play') { self.menus.hide(); self.hud.setVisible(true); self.startStage(false); self.phaseT = 99; } },
            menu: (screen?: string) => self.showMenu((screen as never) ?? 'main'),
            goto: (name: string, intro = false) => self.goToStage(name, intro),
            sky: (shape: Partial<SkyShape>) => { shapeSky(self.engine.scene!, { paintedHorizon: 0.78, horizonDeg: 14, yaw: 0, ...shape }); },
            look: (cfg: { style?: Partial<ComicStyleValues>; lighting?: object; fog?: object; render?: object; bloom?: object; ao?: object; dof?: object }) => {
                const e = self.engine as unknown as Record<string, (...a: unknown[]) => unknown>;
                if (cfg.style) setComicStyle(cfg.style);
                if (cfg.lighting) e.applyLightingConfig?.(cfg.lighting);
                if (cfg.fog) e.applyFogConfig?.(cfg.fog);
                if (cfg.render) e.applyRenderConfig?.({ ...(self.engine.getRenderConfig?.() ?? {}), ...cfg.render });
                if (cfg.bloom) e.setupBloom?.(cfg.bloom);
                if (cfg.ao) e.applyAoConfig?.(cfg.ao);
                if (cfg.dof) e.applyDofConfig?.(cfg.dof);
            },
        };
    }

    dispose(): void {
        this.disposed = true;
        if (this.stateListener) getGameStateManager().removeListener(this.stateListener);
        this.input.dispose();
        this.pauseExtras.dispose();
        this.sfx.dispose();
        this.menus.dispose();
        this.fx.dispose();
        this.flushRetired(true);
        this.items?.dispose();
        this.view?.dispose();
        this.ball.root.removeFromParent();
        this.playerProxy.removeFromParent();
    }
}
