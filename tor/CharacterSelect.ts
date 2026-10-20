import { getLoadProgress } from 'engine/loading/LoadProgress.js';
import { getGameStateManager, GameState } from 'engine/core/GameStateManager.js';
import { getScreenOverlayLayer } from 'engine/ui/screenOverlayLayer.js';
import { isCreatorMode, isAutostartRequested } from 'engine/host/CreatorMode.js';
import { isMobileRuntime } from 'engine/runtime/isMobileRuntime.js';
import type { GameData } from 'types/game.js';
import { getAssetUrlByName } from 'types/game.js';
import { PICK_SCREEN_BODY, PICK_SCREEN_HEAD } from './PickScreenMarkup.js';
import { ROSTER } from './roster.js';
import { COURSES } from './session.js';

/**
 * PICK YOUR ROLLER: the game side of the first screen (#tor-rs). Its source is tools/pick-screen/overlay.src.html (+ roster.ts, the portraits and world.json), built into
 * PickScreenMarkup.ts by `node tools/pick-screen/build.mjs`. The engine's page holds nothing of the game's, so install() puts the screen on the page itself (mountPickScreen),
 * unless a page already carries one. The screen bakes in the asset URLs, so after a stage URL change re-run the tool (`--check` says when that is due; attach() logs a
 * console warning when the baked URLs differ from world.json).
 *
 * This screen REPLACES the engine's start screen and its Play button: its ROLL button (or Enter / Space / gamepad A) is the play action. Cards only SELECT a roller and show a short
 * line about it, so people click through and read while the game loads. It is static markup + an inline classic script that needs nothing of the engine, so it paints the
 * moment the game's constructor runs, while the stage, the sky and the animal load behind it; it fetches the menu stage when the engine starts and the first stage once the game is ready
 * (window.__torPre hands those bytes to StageView, so each is one download). It publishes `window.__torRS` (contract v1, below); this module:
 *   - feeds the selected animal to the game while the player looks around (the ball's animal and glass tint follow; browsing only previews it);
 *   - starts the game when ROLL has been pressed AND the engine has loaded everything: applies the pick and calls `engine.startGame()`, the function the engine's Play button calls
 *     (StartScreen -> GameRuntimeController -> engine.startGame() -> GameTemplate.handleGameStart: fullscreen on phones, analytics, controls, MENU/READY -> PLAYING, then our
 *     begin() and the main menu). The engine's Play button itself is pressed only when this engine has no startGame().
 *     ROLL after loading: all of it synchronously inside the press, so the engine's fullscreen request has the user activation. ROLL during loading: the page does the
 *     gesture-bound part at the press (fullscreen on phones), locks the pick and waits; this module calls startGame() when loading completes.
 * No `__torRS` (the editor, ?select=0, ?stage=, desktop ?autostart=1): install() returns null and the engine's own start screen (with its Play button) runs exactly as before.
 */

/** Pick screen <-> game contract (window.__torRS), v1: a card (or the arrows) selects (`pick`); ROLL (button, Enter / Space, gamepad A) confirms (`confirmed`). */
interface TorRS {
    v: number;
    /** The selected animal (the saved one until the player selects). */
    pick: string;
    /** ROLL has been pressed (the button, Enter / Space, gamepad A, or ?pick= / the automation did it). Never goes back to false. */
    confirmed: boolean;
    attached: boolean;
    /**
     * Set by attach(): the page calls it synchronously inside every ROLL press. True = the game started right there (engine.startGame() was called inside the
     * gesture); false = not yet, and the page does the gesture-bound fullscreen itself.
     */
    start: (() => boolean) | null;
    /** The asset URLs the page baked in and is downloading (checked against world.json at attach). */
    urls: { menuStage?: { u: string }; firstStage?: { u: string } };
    /** Called on every change of pick or confirmation. */
    on(cb: (s: TorRS) => void): void;
    ready(): void;
    going(): void;
    dismiss(): void;
}

/**
 * Put the pick screen on the page: its styles (and the game's font, which the HUD uses even when the screen is skipped) into <head>, its markup and scripts into <body>.
 * Scripts parsed from a string never run, so each one is replaced by a fresh <script> with the same text, which runs as it is inserted: the screen's own script then
 * publishes window.__torRS, or takes the screen off the page again when it is skipped (?select=0, ?stage=, desktop ?autostart=1).
 */
function mountPickScreen(): void {
    const insert = (html: string, parent: HTMLElement): void => {
        const tpl = document.createElement('template');
        tpl.innerHTML = html;
        for (const old of Array.from(tpl.content.querySelectorAll('script'))) {
            const fresh = document.createElement('script');
            for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
            fresh.textContent = old.textContent;
            old.replaceWith(fresh);
        }
        parent.appendChild(tpl.content);
    };
    insert(PICK_SCREEN_HEAD, document.head);
    insert(PICK_SCREEN_BODY, document.body);
}

function screenApi(): TorRS | null {
    if (typeof window === 'undefined') return null;
    const rs = (window as unknown as { __torRS?: TorRS }).__torRS;
    return rs && rs.v === 1 ? rs : null;
}

/** Everything the engine awaits before it shows Play is done, and nobody has pressed it yet. */
function engineLoaded(): boolean {
    const snap = getLoadProgress().getSnapshot();
    if (snap.fraction < 1 || snap.phase !== null) return false;
    const gsm = getGameStateManager();
    if (!gsm || gsm.hasStarted()) return false;
    const st = gsm.getCurrentState();
    return st === GameState.MENU || st === GameState.READY;
}

/**
 * Start the game the way the engine's Play button does: `hooks.start()` calls engine.startGame(), the handler the button's only listener calls (GameRuntimeController wires
 * StartScreen's play click to engine.startGame(); GameTemplate.handleGameStart is what runs). Only an engine without startGame() gets its Play button pressed instead.
 */
function startEngine(hooks: CharacterSelectHooks): 'engine.startGame' | 'play-button' | 'nothing' {
    if (hooks.start()) return 'engine.startGame';
    const btn = getScreenOverlayLayer().querySelector<HTMLButtonElement>('button.hud-play-button');
    if (btn && !btn.disabled) {
        btn.click();
        return 'play-button';
    }
    return 'nothing';
}

/** The screen bakes URLs in at inject time; a stale copy would download files the game then downloads again (or never uses). */
function warnIfStale(rs: TorRS, gameData: GameData | null): void {
    try {
        const bad: string[] = [];
        const check = (name: string, baked: string | undefined): void => {
            const now = getAssetUrlByName(gameData, name);
            if (now && baked !== now) bad.push(name);
        };
        check(ROSTER.menuStage, rs.urls.menuStage?.u);
        check(ROSTER.firstStage, rs.urls.firstStage?.u);
        if (COURSES[0]?.stages[0] !== ROSTER.firstStage) bad.push(`firstStage (${ROSTER.firstStage} is not COURSES[0].stages[0])`);
        if (bad.length) console.warn(`[CharacterSelect] the pick screen is out of date (${bad.join(', ')}): its prefetch downloads the wrong files. Run: node tools/pick-screen/build.mjs`);
    } catch { /* a check must never break the boot */ }
}

export interface CharacterSelectHooks {
    /**
     * Put the animal `id` on the ball and save the choice (TrickOrRoll.selectCharacter). Must never throw. Returns nothing when the animal is already on the ball
     * (the usual case: the screen has been loading it), or a promise that settles when it is.
     */
    apply(id: string): Promise<void> | void;
    /** engine.startGame(): true when this engine has it and it was called. */
    start(): boolean;
}

/**
 * How long the start waits for a not-yet-loaded animal before it plays anyway (the model then swaps in by itself: the engine's own start screen never waited for it either, on a
 * slow link the ball got its animal a moment after the menu appeared). Just long enough to catch one that is landing this instant; the overlay is still fading out over the menu then.
 */
const APPLY_WAIT_MS = 150;
/** Selecting a card only previews the animal on the ball after the pick has rested this long (one download + one model build per animal, not per arrow press). */
const PREVIEW_MS = 450;

export class CharacterSelectFlow {
    private hooks: CharacterSelectHooks | null = null;
    private raf = 0;
    private readyShown = false;
    private done = false;
    private lastPick: string | null = null;
    private previewTimer = 0;

    private constructor(private readonly rs: TorRS) {}

    /** Game constructor: null when the screen is not on the page (editor, ?select=0, ?stage=, desktop ?autostart=1): the engine's own start screen then stays. */
    static install(): CharacterSelectFlow | null {
        if (typeof document !== 'undefined' && !document.getElementById('tor-font-style')) mountPickScreen();
        const rs = screenApi();
        const q = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
        const optedOut = !q || isCreatorMode || q.get('select') === '0' || q.has('stage');
        if (!rs) {
            if (!optedOut && !(isAutostartRequested && !isMobileRuntime())) {
                console.error('[CharacterSelect] the pick screen did not start (tor/PickScreenMarkup.ts): run node tools/pick-screen/build.mjs');
            }
            return null;
        }
        if (optedOut || (isAutostartRequested && !isMobileRuntime())) {
            // the page's own check disagreed with the engine's (desktop autostart starts by itself): step aside
            rs.dismiss();
            return null;
        }
        return new CharacterSelectFlow(rs);
    }

    /**
     * `cb` now with the current pick (the saved one before the player touches the screen), then whenever the pick has rested for a moment, until the game starts.
     * Game.load uses it to put the selected animal on the ball while the player is still looking around.
     */
    whenPicked(cb: (id: string) => void): void {
        const fire = (): void => {
            this.previewTimer = 0;
            if (this.done || this.rs.pick === this.lastPick) return;
            this.lastPick = this.rs.pick;
            cb(this.rs.pick);
        };
        this.rs.on(() => {
            if (this.previewTimer) window.clearTimeout(this.previewTimer);
            if (!this.done) this.previewTimer = window.setTimeout(fire, PREVIEW_MS);
        });
        fire();
    }

    /** End of Game.load (the ball exists, the stage is built): from now on the flow can start the game. */
    attach(hooks: CharacterSelectHooks, gameData: GameData | null): void {
        this.hooks = hooks;
        this.rs.attached = true;
        warnIfStale(this.rs, gameData);
        // ROLL after loading: start inside the press itself (see go()).
        this.rs.start = () => this.go();
        const tick = (): void => {
            this.raf = 0;
            if (this.done) return;
            if (engineLoaded()) {
                if (!this.readyShown) {
                    this.readyShown = true;
                    this.rs.ready();
                }
                // ROLL pressed while loading (or ?pick=, or the automation press): start now
                if (this.rs.confirmed && this.go()) return;
                if (this.done) return;
            }
            this.raf = requestAnimationFrame(tick);
        };
        tick();
    }

    /**
     * ROLL is pressed and the game is loaded: apply the pick, then start the game. All synchronous when the animal is already on the ball (true = engine.startGame()
     * has been called inside this call); an animal still on its way starts the game when it lands, or after APPLY_WAIT_MS (false).
     */
    private go(): boolean {
        if (this.done || !this.hooks || !this.rs.confirmed || !engineLoaded()) return false;
        this.done = true;
        if (this.previewTimer) window.clearTimeout(this.previewTimer);
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.rs.going();
        // The engine's start card sits under our screen; keep it from flashing while the start runs.
        const layer = getScreenOverlayLayer();
        layer.style.visibility = 'hidden';
        const restore = (): void => { layer.style.visibility = ''; };
        const hooks = this.hooks;
        const pick = this.rs.pick;
        let played = false;
        const play = (): void => {
            if (played) return;
            played = true;
            this.rs.dismiss();
            const gsm = getGameStateManager();
            const t0 = performance.now();
            const watch = (): void => {
                const st = gsm?.getCurrentState();
                // PLAYING arrives while the engine's start card is still in its leave animation: showing the layer then flashes that card through our fade-out,
                // so also wait for it to be gone (display:none)
                const card = layer.querySelector<HTMLElement>('button.hud-play-button');
                const cardGone = !card || card.offsetParent === null;
                if ((st === GameState.PLAYING && cardGone) || performance.now() - t0 > 4000) { restore(); return; }
                requestAnimationFrame(watch);
            };
            try {
                const via = startEngine(hooks);
                if (via === 'nothing') throw new Error('this engine has neither startGame() nor a Play button');
                console.info(`[CharacterSelect] ROLL: ${pick}; game started via ${via}`);
            } catch (err) {
                console.error('[CharacterSelect] engine start failed', err);
                restore();
                return;
            }
            requestAnimationFrame(watch);
        };
        let swap: Promise<void> | void = undefined;
        try {
            swap = hooks.apply(pick);
        } catch (err) {
            console.warn('[CharacterSelect] pick not applied, the ball keeps its animal', err);
        }
        if (swap) {
            const wait = new Promise<void>((r) => window.setTimeout(r, APPLY_WAIT_MS));
            void Promise.race([swap.catch((err: unknown) => console.warn('[CharacterSelect] pick not applied, the ball keeps its animal', err)), wait]).then(play);
            return false;
        }
        play();
        return true;
    }

    dispose(): void {
        this.done = true;
        this.rs.start = null;
        if (this.previewTimer) window.clearTimeout(this.previewTimer);
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
    }
}
