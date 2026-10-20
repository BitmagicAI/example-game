import { installSafeArea, safeInsets } from './safeArea.js';

/**
 * Two extra buttons on the engine's pause card: "Retry stage" and "Quit to menu". The engine's card only offers Resume / Mute /
 * Quality, so on a phone there would be no way out of a run except failing it. The card is engine-owned DOM, so this watches for it
 * and adds two buttons in the engine's own styling; if the card's markup ever changes the buttons simply do not appear.
 */
export class PauseExtras {
    private observer: MutationObserver | null = null;

    constructor(private handlers: { canAct: () => boolean; retry: () => void; quit: () => void }) {}

    install(): void {
        if (this.observer || typeof MutationObserver === 'undefined') return;
        installSafeArea();
        this.observer = new MutationObserver(() => this.inject());
        this.observer.observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', this.onResize);
    }

    private onResize = (): void => {
        const card = document.querySelector('.pause-screen-resume')?.closest<HTMLElement>('.ui-modal-card');
        if (card) this.fit(card);
    };

    /**
     * With the two extra buttons the engine's card is taller than the inline player on the play page (about 440 px) and than a phone on its side:
     * its top and bottom ran off the screen. Scale it down to fit (never below half size), clear of the Dynamic Island and the home indicator.
     * The `scale` property, not `zoom`: it leaves the layout height alone, so what is measured is the same in every engine, and the engine's own enter animation (a transform) does not touch it.
     */
    private fit(card: HTMLElement): void {
        card.style.scale = '';
        if (typeof CSS === 'undefined' || !CSS.supports?.('scale', '0.5')) return;
        const { top, bottom } = safeInsets();
        const room = window.innerHeight - 16 - 2 * Math.max(top, bottom);   // the overlay centres the card: keep both ends inside the safe area
        const height = card.offsetHeight;
        if (height > room) card.style.scale = String(+Math.max(0.5, room / height).toFixed(3));
    }

    private inject(): void {
        const resume = document.querySelector<HTMLButtonElement>('.pause-screen-resume');
        const stack = resume?.parentElement;
        if (!resume || !stack || stack.dataset.torExtras === '1' || !this.handlers.canAct()) return;
        stack.dataset.torExtras = '1';
        const make = (label: string, act: () => void): HTMLButtonElement => {
            const b = document.createElement('button');
            b.className = 'ui-modal-button';
            b.type = 'button';
            b.dataset.variant = 'secondary';
            b.textContent = label;
            b.addEventListener('click', () => {
                resume.click();                              // leave the pause state first (the engine's own Resume)
                window.setTimeout(act, 80);
            });
            return b;
        };
        const quit = make('Quit to menu', this.handlers.quit);
        const retry = make('Retry stage', this.handlers.retry);
        resume.after(retry, quit);
        const card = resume.closest<HTMLElement>('.ui-modal-card');
        if (card) this.fit(card);
    }

    dispose(): void {
        this.observer?.disconnect();
        this.observer = null;
        window.removeEventListener('resize', this.onResize);
    }
}
