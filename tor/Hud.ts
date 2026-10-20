import type { GameHUD } from 'engine/ui/hud/GameHUD.js';
import { mountBitmagicBrand } from 'engine/ui/index.js';
import { installSafeArea } from './safeArea.js';

/**
 * Comic-book HUD on the engine's HUD layer (custom elements, so anchors, mobile safe areas and the
 * start-screen layering are the engine's). Styled with a head-injected <style id> as the engine docs
 * ask; fonts come from the active HUD theme (lilita-one, set in world.json hud.theme).
 */
const STYLE_ID = 'tor-hud-style';

const CSS = `
/* 'TOR Lilita' is the face the pick screen embeds (tools/pick-screen): first in every stack so the game never waits for, or depends on, the Google Fonts request. The engine's own HUD UI gets it too. */
.hud-root { --hud-font-family: 'TOR Lilita', 'Lilita One', 'Helvetica Neue', Helvetica, Arial, system-ui, sans-serif !important; }
.tor-font { font-family: 'TOR Lilita', var(--hud-font-family, 'Lilita One'), 'Arial Rounded MT Bold', system-ui, sans-serif; }
#hud-custom-tor-time, #hud-custom-tor-candy, #hud-custom-tor-lives, #hud-custom-tor-stage, #hud-custom-tor-banner, #hud-custom-tor-panel { pointer-events: none; }
/* The engine's HUD anchors take taps over their whole box, and a box is as big as what is inside it even when that is invisible (the 96 px banner, the faded hint). They sat on top of
   the title menu's buttons, its credit and its Up next tile, and swallowed taps on a phone. Everything TOR puts in the anchors is there to be looked at; the engine's own interactive
   elements (the pause card, the touch pause button) carry their own pointer-events. */
.hud-root > .hud-anchor-top-left, .hud-root > .hud-anchor-top-center, .hud-root > .hud-anchor-top-right,
.hud-root > .hud-anchor-middle-left, .hud-root > .hud-anchor-middle-center, .hud-root > .hud-anchor-middle-right,
.hud-root > .hud-anchor-bottom-left, .hud-root > .hud-anchor-bottom-center, .hud-root > .hud-anchor-bottom-right { pointer-events: none; }
/* Keep the HUD clear of the Dynamic Island, the rounded corners and the home indicator (the --tor-sai-* variables, see safeArea.ts; 0 where the page is not drawn under them): the engine offsets
   its anchors from the window edge by --hud-pad alone. The touch pause button sits in an anchor too and moves with it. */
.hud-root > .hud-anchor-top-left, .hud-root > .hud-anchor-top-center, .hud-root > .hud-anchor-top-right { margin-top: var(--tor-sai-top); }
.hud-root > .hud-anchor-bottom-left, .hud-root > .hud-anchor-bottom-center, .hud-root > .hud-anchor-bottom-right { margin-bottom: var(--tor-sai-bottom); }
.hud-root > .hud-anchor-top-left, .hud-root > .hud-anchor-middle-left, .hud-root > .hud-anchor-bottom-left { margin-left: var(--tor-sai-left); }
.hud-root > .hud-anchor-top-right, .hud-root > .hud-anchor-middle-right, .hud-root > .hud-anchor-bottom-right { margin-right: var(--tor-sai-right); }
.tor-chip { display: flex; align-items: center; gap: 10px; padding: 6px 18px 8px; border: 4px solid #1b0e26; border-radius: 22px;
  background: linear-gradient(#5a2f86, #3b1d5e); color: #fff6dc; box-shadow: 0 5px 0 #1b0e26, 0 0 0 3px rgba(255,255,255,.18) inset; transform: rotate(-1.2deg); }
.tor-chip .lbl { font-size: 15px; letter-spacing: 1px; color: #ffd27a; text-transform: uppercase; }
.tor-chip .val { font-size: 38px; line-height: 1; text-shadow: 0 3px 0 #1b0e26, 2px 0 0 #1b0e26, -2px 0 0 #1b0e26, 0 -2px 0 #1b0e26; }
.tor-time .val { font-size: 64px; min-width: 150px; text-align: center; font-variant-numeric: tabular-nums; }
#hud-custom-tor-speed { pointer-events: none; }
.tor-speed { min-width: 150px; flex-direction: column; align-items: stretch; gap: 4px; padding: 4px 14px 8px; }
.tor-speed .row { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.tor-speed .val { font-size: 30px; }
.tor-speed .bar { height: 10px; border: 3px solid #1b0e26; border-radius: 8px; background: #2a1140; overflow: hidden; }
.tor-speed .fill { height: 100%; width: 0%; background: linear-gradient(90deg, #7bff6b, #ffe14a 60%, #ff5a2a); transition: width .08s linear; }
@media (max-width: 520px), (max-height: 520px) {
  .tor-chip { padding: 3px 10px 6px; gap: 6px; border-width: 3px; border-radius: 18px; }
  .tor-chip .lbl { font-size: 11px; letter-spacing: .5px; }
  .tor-chip .val { font-size: 27px; }
  .tor-time .val { font-size: 46px; min-width: 104px; }
  .tor-speed { min-width: 96px; padding: 3px 9px 6px; }
  .tor-speed .row { gap: 5px; }
  .tor-speed .val { font-size: 21px; }
  .tor-speed .bar { height: 7px; border-width: 2px; }
}
#hud-custom-tor-hint { pointer-events: none; }
.tor-hint { transform: translateY(-124px) rotate(-1deg); padding: 6px 20px 8px; border: 3px solid #1b0e26; border-radius: 18px; background: rgba(43,20,68,.9);
  color: #fff6dc; font-size: 22px; text-align: center; box-shadow: 0 4px 0 #1b0e26; transition: opacity .5s; opacity: 0; max-width: 92vw; }
.tor-hint b { color: #ffd27a; font-weight: normal; }
.tor-time.low { background: linear-gradient(#c8321c, #8d1c10); animation: tor-pulse .5s infinite alternate; }
.tor-time.low .val { color: #fff; }
@keyframes tor-pulse { from { transform: rotate(-1.2deg) scale(1); } to { transform: rotate(1.4deg) scale(1.07); } }
.tor-banner { text-align: center; color: #fff2c8; text-shadow: 0 6px 0 #1b0e26, 4px 0 0 #1b0e26, -4px 0 0 #1b0e26, 0 -4px 0 #1b0e26, 3px 3px 0 #1b0e26, -3px 3px 0 #1b0e26, 3px -3px 0 #1b0e26, -3px -3px 0 #1b0e26;
  font-size: 96px; line-height: 1; letter-spacing: 2px; transform-origin: 50% 60%; }
.tor-banner .sub { display: block; font-size: 30px; color: #ffd27a; margin-top: 10px; }
.tor-banner.pop { animation: tor-pop .5s cubic-bezier(.2,1.6,.4,1) both; }
@keyframes tor-pop { from { transform: scale(.2) rotate(-12deg); opacity: 0; } to { transform: scale(1) rotate(-3deg); opacity: 1; } }

.tor-panel { min-width: 360px; padding: 18px 34px 22px; border: 6px solid #1b0e26; border-radius: 30px; text-align: center;
  background: linear-gradient(#6a35a0, #3a1c5c); color: #fff6dc; box-shadow: 0 10px 0 #1b0e26, 0 0 0 4px rgba(255,255,255,.2) inset; transform: rotate(-1.5deg);
  animation: tor-pop .45s cubic-bezier(.2,1.5,.4,1) both; }
.tor-panel h2 { margin: 0 0 8px; font-size: 54px; font-weight: 400; color: #ffd27a; text-shadow: 0 5px 0 #1b0e26, 3px 0 0 #1b0e26, -3px 0 0 #1b0e26, 0 -3px 0 #1b0e26; }
.tor-panel table { width: 100%; font-size: 28px; border-collapse: collapse; }
.tor-panel td { padding: 4px 10px; text-align: right; } .tor-panel td:first-child { text-align: left; color: #ffd27a; }
.tor-panel .total { font-size: 44px; margin-top: 10px; text-shadow: 0 4px 0 #1b0e26; }
.tor-panel .hint { margin-top: 12px; font-size: 18px; color: #d9c4f5; letter-spacing: 1px; }
.tor-panel .ui-modal-brand { margin-top: 4px; pointer-events: auto; }   /* the panel's wrapper ignores pointer events: the credit is a link anyway */   /* the engine's "Made with Bitmagic" link on the end-of-run panels */
@media (max-width: 700px) { .tor-time .val { font-size: 46px; min-width: 100px; } .tor-chip .val { font-size: 28px; } .tor-banner { font-size: 56px; } }
/* The result panels fit the window they are shown in. The engine keeps its middle-centre anchor to 72 % of the width and the panel had a 360 px minimum, so on a phone held upright it ran out of the
   right edge. These sit after the base rules above on purpose (the same-specificity overrides that came before them never applied). */
.hud-root > .hud-anchor-middle-center { max-width: min(640px, calc(100vw - 24px - var(--tor-sai-left) - var(--tor-sai-right))); }
.tor-panel { box-sizing: border-box; min-width: min(360px, calc(100vw - 48px - var(--tor-sai-left) - var(--tor-sai-right))); max-width: calc(100vw - 24px - var(--tor-sai-left) - var(--tor-sai-right)); }
@media (max-width: 520px), (max-height: 520px) { .tor-banner { font-size: 60px; } .tor-panel { padding: 12px 18px 16px; } }
@media (max-width: 520px) { .tor-panel h2 { font-size: 42px; } .tor-panel table { font-size: 23px; } .tor-panel .total { font-size: 36px; } .tor-panel .hint { font-size: 16px; } }
/* On a phone held upright the control hint wrapped to three lines and sat on the speed chip: smaller type, a narrower box, and lifted a little higher. */
@media (max-width: 520px) { .tor-hint { font-size: 17px; max-width: min(86vw, 340px); padding: 5px 14px 7px; transform: translateY(-150px) rotate(-1deg); } }
`;

export type BannerKind = 'ready' | 'go' | 'goal' | 'fall' | 'time' | 'info';

export class Hud {
    private timeEl: HTMLElement | null = null;
    private timeBox: HTMLElement | null = null;
    private candyEl: HTMLElement | null = null;
    private livesEl: HTMLElement | null = null;
    private stageEl: HTMLElement | null = null;
    private speedEl: HTMLElement | null = null;
    private speedBar: HTMLElement | null = null;
    private hintEl: HTMLElement | null = null;
    private hintTimer = 0;
    private bannerEl: HTMLElement | null = null;
    private panelEl: HTMLElement | null = null;
    private bannerTimer = 0;
    private created = false;

    constructor(private hud: GameHUD) {}

    private ensureStyle(): void {
        installSafeArea();
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    /** Build the elements (call on the first play transition, not before). */
    create(): void {
        if (this.created) return;
        this.created = true;
        this.ensureStyle();
        this.hud.createCustomElement('tor-time', {
            anchor: 'top-center',
            html: '<div class="tor-chip tor-time tor-font"><div class="val">60.00</div></div>',
            onCreate: (c: HTMLElement) => { this.timeEl = c.querySelector('.val'); this.timeBox = c.querySelector('.tor-time'); },
        });
        this.hud.createCustomElement('tor-candy', {
            anchor: 'top-left',
            html: '<div class="tor-chip tor-font"><span class="lbl">Candy</span><div class="val">0</div></div>',
            onCreate: (c: HTMLElement) => { this.candyEl = c.querySelector('.val'); },
        });
        this.hud.createCustomElement('tor-lives', {
            anchor: 'bottom-left',
            html: '<div class="tor-chip tor-font"><span class="lbl">Lives</span><div class="val">4</div></div>',
            onCreate: (c: HTMLElement) => { this.livesEl = c.querySelector('.val'); },
        });
        this.hud.createCustomElement('tor-stage', {
            anchor: 'bottom-right',
            html: '<div class="tor-chip tor-font"><span class="lbl">Stage</span><div class="val">1</div></div>',
            onCreate: (c: HTMLElement) => { this.stageEl = c.querySelector('.val'); },
        });
        this.hud.createCustomElement('tor-speed', {
            anchor: 'bottom-center',
            html: '<div class="tor-chip tor-speed tor-font"><div class="row"><span class="lbl">Speed</span><div class="val">0</div><span class="lbl">km/h</span></div><div class="bar"><div class="fill"></div></div></div>',
            onCreate: (c: HTMLElement) => { this.speedEl = c.querySelector('.val'); this.speedBar = c.querySelector('.fill'); },
        });
        this.hud.createCustomElement('tor-hint', {
            anchor: 'bottom-center',
            html: '<div class="tor-hint tor-font"></div>',
            onCreate: (c: HTMLElement) => { this.hintEl = c.querySelector('.tor-hint'); },
        });
        this.hud.createCustomElement('tor-panel', {
            anchor: 'middle-center',
            html: '<div class="tor-panel tor-font" style="display:none"></div>',
            onCreate: (c: HTMLElement) => { this.panelEl = c.querySelector('.tor-panel'); },
        });
        this.hud.createCustomElement('tor-banner', {
            anchor: 'middle-center',
            html: '<div class="tor-banner tor-font" style="opacity:0"></div>',
            onCreate: (c: HTMLElement) => { this.bannerEl = c.querySelector('.tor-banner'); },
        });
    }

    setTime(seconds: number): void {
        if (!this.timeEl) return;
        const s = Math.max(0, seconds);
        const txt = s.toFixed(2).padStart(5, '0');
        if (this.timeEl.textContent !== txt) this.timeEl.textContent = txt;
        this.timeBox?.classList.toggle('low', s <= 10 && s > 0);
    }
    setSpeed(ms: number): void {
        if (!this.speedEl) return;
        const kmh = Math.round(ms * 3.6);
        const txt = String(kmh);
        if (this.speedEl.textContent !== txt) this.speedEl.textContent = txt;
        if (this.speedBar) this.speedBar.style.width = Math.min(100, (ms / 26) * 100).toFixed(0) + '%';
    }
    setCandy(n: number): void { if (this.candyEl) this.candyEl.textContent = String(n); }
    setLives(n: number): void { if (this.livesEl) this.livesEl.textContent = String(n); }
    setStage(text: string): void { if (this.stageEl) this.stageEl.textContent = text; }

    banner(text: string, sub = '', ms = 1400, kind: BannerKind = 'info'): void {
        const el = this.bannerEl;
        if (!el) return;
        window.clearTimeout(this.bannerTimer);
        el.classList.remove('pop');
        void el.offsetWidth;
        el.innerHTML = text + (sub ? `<span class="sub">${sub}</span>` : '');
        el.dataset.kind = kind;
        el.style.opacity = '1';
        el.classList.add('pop');
        if (ms > 0) this.bannerTimer = window.setTimeout(() => { el.classList.remove('pop'); el.style.opacity = '0'; }, ms);
    }
    /** A small control hint above the speed chip; fades out by itself. */
    hint(html: string, ms = 7000): void {
        const el = this.hintEl;
        if (!el) return;
        window.clearTimeout(this.hintTimer);
        el.innerHTML = html;
        el.style.opacity = '1';
        this.hintTimer = window.setTimeout(() => { el.style.opacity = '0'; }, ms);
    }
    /** Take the control hint away at once (it is meant for a stage, not for the menu a player quits to). */
    clearHint(): void { window.clearTimeout(this.hintTimer); if (this.hintEl) this.hintEl.style.opacity = '0'; }
    /** Show / hide the time, candy, lives and stage chips (menus hide them). */
    setVisible(v: boolean): void {
        for (const id of ['tor-time', 'tor-candy', 'tor-lives', 'tor-stage', 'tor-speed']) {
            if (v) this.hud.showElement(id); else this.hud.hideElement(id);
        }
    }
    /** `credit`: the panel ends with the engine's "Made with Bitmagic" link (nothing in a packaged build). */
    panel(html: string, credit = false): void {
        if (!this.panelEl) return;
        this.panelEl.innerHTML = html;
        if (credit) {
            // a tap anywhere continues (Input.tapConfirm), but a tap on the credit must only open bitmagic.ai
            mountBitmagicBrand(this.panelEl, { placement: 'result' })?.addEventListener('pointerdown', (e) => e.stopPropagation());
        }
        this.panelEl.style.display = 'block';
        this.panelEl.style.animation = 'none';
        void this.panelEl.offsetWidth;
        this.panelEl.style.animation = '';
    }
    hidePanel(): void { if (this.panelEl) this.panelEl.style.display = 'none'; }
    clearBanner(): void { window.clearTimeout(this.bannerTimer); if (this.bannerEl) { this.bannerEl.classList.remove('pop'); this.bannerEl.style.opacity = '0'; } }
}
