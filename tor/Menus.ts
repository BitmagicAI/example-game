import { COURSES, type CourseDef, type SaveData } from './session.js';
import { KEY_PROFILES, type KeyProfile } from './Input.js';
import { ROSTER, type CharacterDef } from './roster.js';
import { mountBitmagicBrand } from 'engine/ui/index.js';
import { isMobileRuntime } from 'engine/runtime/isMobileRuntime.js';
import { installSafeArea } from './safeArea.js';

/**
 * Comic-book menus over the live scene: main, course select, practice (stage grid), character select.
 * One focus ring per screen, driven by keyboard / gamepad (via `nav()`), or clicked / tapped directly.
 * The scene behind keeps animating; the character select swaps the animal in the ball behind the panel.
 */
export type { CharacterDef };

export const CHARACTERS: CharacterDef[] = ROSTER.characters;

export interface MenuHandlers {
    startChallenge(course: CourseDef): void;
    startPractice(course: CourseDef, stageIndex: number): void;
    pickCharacter(c: CharacterDef): void;
    /** Keyboard feel and/or mouse tilt changed in the CONTROLS screen (the game applies and saves it). */
    setControls(patch: { keys?: KeyProfile; mouse?: boolean; mouseSpeed?: 'slow' | 'normal' | 'fast'; openAll?: boolean }): void;
    ui(kind: 'move' | 'ok' | 'back'): void;
    /** The Game Exchange's "Up next" tile into `box`; null when the exchange is off in this page. Dispose it to take the tile out. */
    mountAd(box: HTMLElement): { dispose(): void } | null;
    /** Whether a tile can appear in this page at all (a published game, or the dev preview). */
    adAvailable(): boolean;
}

type Screen = 'main' | 'course' | 'practice-course' | 'practice-stage' | 'character' | 'controls';

const STYLE_ID = 'tor-menu-style';
/** Height a narrow window's menu leaves free at the bottom for the "Up next" tile and the credit (CSS px). */
const AD_ROOM = 200;
/** What a narrow window's title menu leaves free below the column for the credit alone (CSS px). */
const FOOT_ROOM = 44;
/** On a narrow window the tile is offered only when the column can keep at least this much of its size next to it. */
const MIN_AD_FIT = 0.85;
/** The menu is scaled down to fit a short window (the inline player on the play page, a phone on its side), but never below this: past it, it scrolls. */
const MIN_FIT = 0.5;
/** The individual `scale` property (Safari 14.1+, Chrome 104+): it scales what is painted and leaves the layout alone, so what is measured is the same in every engine (CSS `zoom` is not: WebKit
 *  leaves viewport-unit sizes unzoomed, so a column fitted to the window by its zoom factor came out 8 to 40 % too tall in the iOS app). */
const CAN_SCALE = typeof window !== 'undefined' && typeof window.CSS?.supports === 'function' && window.CSS.supports('scale', '0.5');   // window.CSS: this module's own `CSS` is the stylesheet text
const CSS = `
#tor-menu { position: fixed; inset: 0; box-sizing: border-box; padding: var(--tor-sai-top) var(--tor-sai-right) var(--tor-sai-bottom) var(--tor-sai-left); z-index: 30; display: none; font-family: 'TOR Lilita', var(--hud-font-family,'Lilita One'), 'Arial Rounded MT Bold', system-ui, sans-serif; color: #fff6dc; user-select: none; -webkit-user-select: none; }
#tor-menu.on { display: flex; }
/* Centred up and down with align-self, not auto margins: a column taller than the window is still centred (and then scaled about its centre), where auto margins would pin its top. */
#tor-menu .wrap { margin: 0 6vw 0 auto; align-self: center; width: min(520px, 88vw); display: flex; flex-direction: column; gap: 14px; }
#tor-menu.left .wrap { margin: 0 auto 0 6vw; }
#tor-menu h1 { margin: 0 0 6px; font-size: clamp(34px, 6vw, 64px); font-weight: 400; color: #ffd27a; text-shadow: 0 6px 0 #1b0e26, 4px 0 0 #1b0e26, -4px 0 0 #1b0e26, 0 -4px 0 #1b0e26; transform: rotate(-2deg); letter-spacing: 1px; }
#tor-menu .sub { font-size: 18px; color: #e8d6ff; margin: -4px 0 6px; text-shadow: 0 2px 0 #1b0e26; }
#tor-menu button.opt { all: unset; box-sizing: border-box; cursor: pointer; display: block; width: 100%; padding: 14px 24px 16px; text-align: left; font: inherit; font-size: clamp(22px, 3.6vw, 34px);
  color: #fff6dc; border: 6px solid #1b0e26; border-radius: 24px; background: linear-gradient(#7a3fb8, #4a2378); box-shadow: 0 8px 0 #1b0e26, 0 0 0 3px rgba(255,255,255,.16) inset, 0 0 0 2px rgba(255,214,120,.0); transition: transform .08s; }
#tor-menu button.opt { position: relative; overflow: hidden; }
#tor-menu button.opt::before { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: .95;
  background: radial-gradient(circle at 50% 50%, rgba(18,6,34,.72) 2.2px, transparent 3px) 0 0 / 7px 7px;   /* Ben-Day dots, like the halftone in the shadows of the world */
  -webkit-mask-image: linear-gradient(to top, #000 0%, #000 22%, transparent 78%); mask-image: linear-gradient(to top, #000 0%, #000 22%, transparent 78%); }
#tor-menu button.opt::after { content: ''; position: absolute; left: 16px; right: 16px; top: 5px; height: 6px; border-radius: 6px; background: rgba(255,255,255,.3); pointer-events: none; }
#tor-menu button.opt.focus::before { background: radial-gradient(circle at 50% 50%, rgba(120,40,0,.5) 1.5px, transparent 2.3px) 0 0 / 8px 8px; }
#tor-menu button.opt > * { position: relative; z-index: 1; }
#tor-menu button.opt .lb { display: block; }
#tor-menu button.opt small { display: block; font-size: 15px; color: #d9c4f5; margin-top: 2px; letter-spacing: .5px; }
#tor-menu button.opt.focus { background: linear-gradient(#ffb03a, #f0701a); color: #2a1240; transform: translateX(-10px) rotate(-1deg) scale(1.03); box-shadow: 0 9px 0 #1b0e26, 0 0 0 3px rgba(255,255,255,.45) inset; }
#tor-menu button.opt.focus small { color: #4a2378; }
#tor-menu button.opt[disabled] { opacity: .45; }
#tor-menu .grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
#tor-menu .grid button.opt { text-align: center; padding: 12px 0 14px; font-size: 30px; }
#tor-menu .grid button.opt small { font-size: 12px; }
#tor-menu .hint { font-size: 15px; color: #d9c4f5; text-shadow: 0 2px 0 #1b0e26; margin-top: 4px; }
#tor-menu .cardrow { display: flex; gap: 14px; }
/* The foot of the title menu: the exchange's "Up next" tile (once the player has been through a stage) above the "Made with Bitmagic" credit.
   On a wide window it sits in the free half on the left, under the ball; on a narrow one it is centred and the menu makes room for the tile. */
/* A column too tall for the window even at the smallest size scrolls (the scrollbar is hidden: wheel, touch and the keyboard focus move it). */
#tor-menu .wrap.scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; padding: 6px 14px 14px; box-sizing: content-box; }
#tor-menu .wrap.scroll::-webkit-scrollbar { display: none; }
#tor-menu-foot { position: absolute; left: var(--tor-sai-left); bottom: max(10px, var(--tor-sai-bottom)); width: calc(100% - var(--tor-sai-left) - var(--tor-sai-right) - 6vw - min(520px, 88vw)); display: none; flex-direction: column; align-items: center; gap: 4px; pointer-events: none; }
#tor-menu.main #tor-menu-foot { display: flex; }
#tor-menu-foot .ad { width: min(280px, calc(100% - 24px)); box-sizing: border-box; padding: 8px 10px 10px; border-radius: 14px; background: rgba(20,20,24,.84); box-shadow: 0 6px 18px rgba(0,0,0,.35); pointer-events: auto; }   /* a plain plate for legibility: the tile is another game's, it must not read as part of this one */
#tor-menu-foot .ad:empty { display: none; }
#tor-menu-foot .ui-modal-brand { --hud-font-scale: 1.4; pointer-events: auto; margin: 0; color: #f3e6ff; opacity: .95; filter: drop-shadow(0 2px 0 #1b0e26); }   /* bigger than on a card (it is the game's first screen); margin 0 because the engine tucks the credit into a card's padding on short windows and there is none here */
@media (max-width: 800px) {
  #tor-menu .wrap, #tor-menu.left .wrap { margin: 0 auto; }
  #tor-menu-foot { width: calc(100% - var(--tor-sai-left) - var(--tor-sai-right)); }
  #tor-menu-foot .ad { width: min(220px, 58vw); }
  #tor-menu.main { padding-bottom: calc(${FOOT_ROOM}px + var(--tor-sai-bottom)); }
  #tor-menu.reserve-ad { padding-bottom: calc(${AD_ROOM}px + var(--tor-sai-bottom)); }
}
/* A window taller than it is wide (a phone held upright): the column sits at the bottom of the screen, so the ball (the menu camera frames it in the band above, TrickOrRoll.menuCamera) is not behind the buttons.
   Scaled to fit, it stays anchored to the bottom. This comes after the narrow rules so it wins over them. */
@media (max-aspect-ratio: 1/1) {
  #tor-menu .wrap, #tor-menu.left .wrap { align-self: flex-end; margin: 0 auto; transform-origin: 50% 100%; }
  #tor-menu-foot { width: calc(100% - var(--tor-sai-left) - var(--tor-sai-right)); }
  #tor-menu { padding-bottom: calc(var(--tor-sai-bottom) + 16px); }
  #tor-menu.main { padding-bottom: calc(${FOOT_ROOM}px + var(--tor-sai-bottom)); }
  #tor-menu.reserve-ad { padding-bottom: calc(${AD_ROOM}px + var(--tor-sai-bottom)); }
}
`;

interface Btn { label: string; sub?: string; disabled?: boolean; act: () => void; onFocus?: () => void }

export class Menus {
    private root: HTMLDivElement;
    private body: HTMLDivElement;
    private screen: Screen = 'main';
    private btns: Btn[] = [];
    private els: HTMLButtonElement[] = [];
    private focus = 0;
    private charIndex = 0;
    private practiceCourse: CourseDef = COURSES[0]!;
    private held = { x: 0, y: 0 };
    private repeatT = 0;
    visible = false;
    /** The foot of the title menu: the "Up next" box and the credit. */
    private foot: HTMLDivElement;
    private adBox: HTMLDivElement;
    private ad: { dispose(): void } | null = null;
    /** The player has started a stage in this visit: only then does the title menu carry the tile. */
    private played = false;
    private top = 0;

    constructor(private save: SaveData, private h: MenuHandlers) {
        installSafeArea();
        if (!document.getElementById(STYLE_ID)) {
            const s = document.createElement('style'); s.id = STYLE_ID; s.textContent = CSS; document.head.appendChild(s);
        }
        this.root = document.createElement('div');
        this.root.id = 'tor-menu';
        this.body = document.createElement('div');
        this.body.className = 'wrap';
        this.root.appendChild(this.body);
        this.foot = document.createElement('div');
        this.foot.id = 'tor-menu-foot';
        this.adBox = document.createElement('div');
        this.adBox.className = 'ad';
        this.foot.appendChild(this.adBox);
        mountBitmagicBrand(this.foot, { placement: 'menu' });   // "Made with Bitmagic", under the tile; nothing in a packaged build
        this.root.appendChild(this.foot);
        document.body.appendChild(this.root);
        this.charIndex = Math.max(0, CHARACTERS.findIndex((c) => c.id === save.character));
        window.addEventListener('resize', this.onResize);
    }

    private onResize = (): void => this.layout();

    /**
     * One pass for everything that depends on the window: which foot the title menu has (the credit, with the "Up next" tile once the player has played) and how big its column may be.
     * The menus are drawn for a tall window; the inline player on the play page is about 440 px high and a phone on its side less, so the last buttons (BACK) fell off the bottom.
     * The column is scaled down to fit what the foot leaves free (never below half size) and scrolls when even that is too tall.
     */
    private layout(): void {
        this.layoutColumn();
        this.top = this.visible ? this.body.getBoundingClientRect().top : 0;
    }

    /** A window taller than it is wide: the column is at the bottom of the screen and the ball is framed above it. */
    get stacked(): boolean { return window.innerHeight > window.innerWidth; }
    /** CSS px from the top of the window to the top of the column (0 while no menu shows): the band above it is where the ball goes. */
    get topEdge(): number { return this.top; }

    private layoutColumn(): void {
        const el = this.body;
        el.style.scale = '';
        el.style.maxHeight = '';
        el.classList.remove('scroll');
        const main = this.visible && this.screen === 'main';
        this.root.classList.toggle('main', main);
        const narrow = window.matchMedia('(max-width: 800px)').matches;
        const natural = this.visible ? el.offsetHeight : 0;   // the column at full size
        let wantAd = main && this.played;
        // On a narrow window the tile sits below the column, which makes room for it (and shrinks a little at most): a window too short for both gets the credit alone
        if (wantAd && narrow) wantAd = (window.innerHeight - AD_ROOM - 20) / Math.max(1, natural) >= MIN_AD_FIT;
        // Room for the tile is made whether or not it has arrived yet, so nothing moves when it does
        this.root.classList.toggle('reserve-ad', wantAd && this.h.adAvailable());
        if (wantAd && !this.ad) this.ad = this.h.mountAd(this.adBox);
        else if (!wantAd && this.ad) { this.ad.dispose(); this.ad = null; }
        if (!this.visible) return;
        const cs = getComputedStyle(this.root);
        const room = this.root.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0) - 20;
        if (natural <= room) return;
        const k = CAN_SCALE ? Math.max(MIN_FIT, room / natural) : 1;
        if (k < 1) el.style.scale = String(+k.toFixed(3));
        if (natural * k > room + 1) {
            el.classList.add('scroll');
            el.style.maxHeight = `${Math.floor(room / k)}px`;   // a scaled element's px are scaled by the factor: this is `room` on screen
        }
    }

    get currentCharacter(): CharacterDef { return CHARACTERS[this.charIndex]!; }
    get onCharacterScreen(): boolean { return this.screen === 'character'; }

    show(screen: Screen = 'main'): void {
        this.visible = true;
        this.root.classList.add('on');
        this.root.classList.toggle('left', screen === 'character');
        this.go(screen);
    }
    hide(): void { this.visible = false; this.root.classList.remove('on'); this.layout(); }

    /** A stage was started: from now on the title menu offers the "Up next" tile. */
    markPlayed(): void { this.played = true; }

    private go(screen: Screen, keepFocus?: number): void {
        this.screen = screen;
        this.root.classList.toggle('left', screen === 'character');
        const b: Btn[] = [];
        // A phone or tablet has no keyboard or mouse to point at: its menus carry no key hints and no keyboard / mouse settings
        const touch = isMobileRuntime();
        let title = '', sub = '', hint = touch ? '' : 'Arrows / stick to choose, SPACE / A to confirm';
        switch (screen) {
            case 'main':
                title = 'TRICK OR ROLL'; sub = 'Tilt the world. Roll home.';
                b.push({ label: 'CHALLENGE', sub: 'Roll through a whole course. 4 lives, 100 candy = 1UP.', act: () => this.go('course') });
                b.push({ label: 'PRACTICE', sub: 'Replay any stage you have reached.', act: () => this.go('practice-course') });
                b.push({ label: 'CHARACTER', sub: `Playing as ${this.currentCharacter.name}`, act: () => this.go('character') });
                // every setting on the CONTROLS screen is a keyboard or mouse one: nothing there for a touch device
                if (!touch) b.push({ label: 'CONTROLS', sub: `Keyboard: ${KEY_PROFILES[this.save.settings.keys ?? 'gentle'].label}  ·  Mouse: ${this.save.settings.mouse ? 'on' : 'off'}`, act: () => this.go('controls') });
                break;
            case 'course':
                title = 'CHOOSE A COURSE'; sub = 'Ten stages each. The lights go out as you go deeper.';
                for (const c of COURSES) {
                    const done = this.save.cleared[c.id] ?? 0;
                    b.push({ label: c.title.toUpperCase(), sub: `${c.blurb}  (${done}/${c.stages.length} cleared)`, act: () => { this.hide(); this.h.startChallenge(c); } });
                }
                b.push({ label: 'BACK', act: () => this.go('main') });
                break;
            case 'practice-course': {
                const all = !!this.save.settings.openAll;
                title = 'PRACTICE'; sub = 'Pick a course';
                for (const c of COURSES) b.push({ label: c.title.toUpperCase(), sub: `${this.openCount(c)} of ${c.stages.length} stages open`, act: () => { this.practiceCourse = c; this.go('practice-stage'); } });
                b.push({ label: `ALL STAGES OPEN: ${all ? 'ON' : 'OFF'}`, sub: 'Skip the progress lock: try any stage straight away (handy for testing on another device)',
                    act: () => { this.h.setControls({ openAll: !all }); this.go('practice-course', COURSES.length); } });
                b.push({ label: 'BACK', act: () => this.go('main') });
                break;
            }
            case 'practice-stage': {
                const c = this.practiceCourse;
                title = c.title.toUpperCase(); sub = 'Pick a stage';
                const open = this.openCount(c);
                c.stages.forEach((name, i) => {
                    const best = this.save.best[name];
                    b.push({ label: String(i + 1), sub: best ? `${best.timeLeft.toFixed(0)}s left` : (i < open ? 'new' : 'locked'), disabled: i >= open, act: () => { this.hide(); this.h.startPractice(c, i); } });
                });
                b.push({ label: 'BACK', act: () => this.go('practice-course') });
                break;
            }
            case 'controls': {
                const keys: KeyProfile = this.save.settings.keys ?? 'gentle';
                const mouse = !!this.save.settings.mouse;
                const order: KeyProfile[] = ['gentle', 'normal', 'quick'];
                title = 'CONTROLS'; sub = 'Make the tilt feel right. In a stage, M switches mouse tilt on or off.';
                b.push({ label: `KEYBOARD: ${KEY_PROFILES[keys].label.toUpperCase()}`, sub: 'How quickly WASD / the arrow keys tilt the stage (Gentle = slow build-up, Quick = instant)',
                    act: () => { this.h.setControls({ keys: order[(order.indexOf(keys) + 1) % order.length]! }); this.go('controls', 0); } });
                b.push({ label: `MOUSE TILT: ${mouse ? 'ON' : 'OFF'}`, sub: 'The mouse moves a pointer that always starts in the middle: the ring shows your tilt. Click to re-centre, Esc to pause',
                    act: () => { this.h.setControls({ mouse: !mouse }); this.go('controls', 1); } });
                const speed = this.save.settings.mouseSpeed ?? 'normal';
                const speeds: Array<'slow' | 'normal' | 'fast'> = ['slow', 'normal', 'fast'];
                b.push({ label: `MOUSE SPEED: ${speed.toUpperCase()}`, sub: 'How far the mouse has to travel for full tilt',
                    act: () => { this.h.setControls({ mouseSpeed: speeds[(speeds.indexOf(speed) + 1) % speeds.length]! }); this.go('controls', 2); } });
                b.push({ label: 'BACK', act: () => this.go('main') });
                break;
            }
            case 'character': {
                const c = this.currentCharacter;
                title = c.name.toUpperCase(); sub = c.blurb; hint = touch ? '' : 'Left / right to change, SPACE / A to choose';
                b.push({ label: '< PREVIOUS', act: () => this.cycle(-1) });
                b.push({ label: 'NEXT >', act: () => this.cycle(1) });
                b.push({ label: 'THAT ONE!', act: () => { this.save.character = c.id; this.h.pickCharacter(c); this.go('main'); } });
                break;
            }
        }
        this.btns = b;
        this.focus = Math.min(this.focus, b.length - 1);
        if (screen === 'character') this.focus = 2;
        else this.focus = keepFocus ?? 0;
        const grid = screen === 'practice-stage';
        this.body.innerHTML = `<h1>${title}</h1><div class="sub">${sub}</div><div class="${grid ? 'grid' : ''}" id="tor-btns"></div>${hint ? `<div class="hint">${hint}</div>` : ''}`;
        const holder = this.body.querySelector('#tor-btns') as HTMLElement;
        this.els = b.map((btn, i) => {
            const el = document.createElement('button');
            el.className = 'opt';
            el.innerHTML = `<span class="lb">${btn.label}</span>` + (btn.sub ? `<small>${btn.sub}</small>` : '');   // children sit above the halftone overlay
            if (btn.disabled) el.disabled = true;
            el.addEventListener('click', () => { if (!btn.disabled) { this.h.ui(btn.label === 'BACK' ? 'back' : 'ok'); btn.act(); } });
            el.addEventListener('pointerenter', () => this.setFocus(i, false));
            holder.appendChild(el);
            return el;
        });
        if (grid) {
            // the BACK button spans the grid row
            const last = this.els[this.els.length - 1]!;
            last.style.gridColumn = '1 / -1';
        }
        this.layout();   // after the screen is built: the foot and the column's size depend on its height
        this.paint();
    }

    /** How many stages of a course the practice menu offers: all of them when the player opened the lock, else cleared + 1. */
    private openCount(c: CourseDef): number {
        return this.save.settings.openAll ? c.stages.length : Math.min(c.stages.length, (this.save.cleared[c.id] ?? 0) + 1);
    }

    private cycle(d: number): void {
        this.charIndex = (this.charIndex + d + CHARACTERS.length) % CHARACTERS.length;
        this.h.pickCharacter(this.currentCharacter);   // live preview: the ball behind the panel swaps animals
        this.go('character');
    }

    private setFocus(i: number, sound = true): void {
        if (i === this.focus) return;
        this.focus = i;
        if (sound) this.h.ui('move');
        this.paint();
    }

    private paint(): void {
        this.els.forEach((e, i) => e.classList.toggle('focus', i === this.focus));
        if (this.body.classList.contains('scroll')) this.els[this.focus]?.scrollIntoView({ block: 'nearest' });
    }

    /** Feed the input state each frame while visible. */
    nav(stick: { x: number; y: number }, take: (a: string) => boolean, dt: number, stickIsKeys = false): void {
        if (!this.visible) return;
        // edge presses (keyboard keydown, gamepad d-pad) move one step per press, so quick taps are never missed
        if (take('nav-left')) this.move(-1, 0);
        if (take('nav-right')) this.move(1, 0);
        if (take('nav-up')) this.move(0, -1);
        if (take('nav-down')) this.move(0, 1);
        if (stickIsKeys) { if (take('confirm')) { const b = this.btns[this.focus]; if (b && !b.disabled) { this.h.ui(b.label === 'BACK' ? 'back' : 'ok'); b.act(); } } if (take('back')) this.back(); return; }
        const th = 0.6;
        const dx = Math.abs(stick.x) > th ? Math.sign(stick.x) : 0;
        const dy = Math.abs(stick.y) > th ? Math.sign(stick.y) : 0;
        this.repeatT -= dt;
        const fresh = dx !== this.held.x || dy !== this.held.y;
        if ((dx || dy) && (fresh || this.repeatT <= 0)) {
            this.repeatT = fresh ? 0.28 : 0.12;
            this.held.x = dx; this.held.y = dy;
            this.move(dx, -dy);   // stick y is "up positive"; menu wants "down positive"
        } else if (!dx && !dy) { this.held.x = 0; this.held.y = 0; }
        if (take('confirm')) { const b = this.btns[this.focus]; if (b && !b.disabled) { this.h.ui(b.label === 'BACK' ? 'back' : 'ok'); b.act(); } }
        if (take('back')) this.back();
    }

    private move(dx: number, dy: number): void {
        if (this.screen === 'character') { if (dx) this.cycle(dx); else if (dy) this.setFocus(Math.max(0, Math.min(2, this.focus + dy))); return; }
        if (this.screen === 'practice-stage') {
            const n = this.btns.length - 1;   // last is BACK
            let f = this.focus;
            if (f === n) { f = dy < 0 ? Math.max(0, n - 5) : n; }
            else { f += dx + dy * 5; if (f >= n) f = n; if (f < 0) f = 0; }
            this.setFocus(f); return;
        }
        const step = dy || dx;
        if (step) this.setFocus(Math.max(0, Math.min(this.btns.length - 1, this.focus + step)));
    }

    private back(): void {
        this.h.ui('back');
        if (this.screen === 'main') return;
        if (this.screen === 'practice-stage') this.go('practice-course');
        else this.go('main');
    }

    dispose(): void { window.removeEventListener('resize', this.onResize); this.ad?.dispose(); this.ad = null; this.root.remove(); document.getElementById(STYLE_ID)?.remove(); }
}
