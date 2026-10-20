/**
 * Safe areas. The iOS app shows the game in a full-bleed web view: the Dynamic Island, the rounded corners and the home indicator are drawn over the page, so every piece of UI
 * keeps clear of them through four CSS variables, `--tor-sai-top|right|bottom|left`. They are the browser's `env(safe-area-inset-*)` wherever the page may draw under those areas
 * (the app: `viewport-fit=cover`) and 0 everywhere else (a desktop window, a phone's browser tab, which keeps clear of them by itself), so the same CSS serves both.
 *
 * `?sai=top,right,bottom,left` pins the four to fixed pixels instead: a desktop browser can then show what an iPhone's insets do to a screen
 * (landscape on an iPhone 17 Pro Max is `?sai=0,62,21,62`, portrait `?sai=62,0,34,0`).
 */
const STYLE_ID = 'tor-sai-style';
const SIDES = ['top', 'right', 'bottom', 'left'] as const;

export interface Insets { top: number; right: number; bottom: number; left: number }

function pinned(): number[] | null {
    try {
        const raw = new URLSearchParams(window.location.search).get('sai');
        if (!raw) return null;
        const v = raw.split(',').map((x) => Math.max(0, Number(x) || 0));
        return v.length === 4 ? v : null;
    } catch { return null; }
}

/** The app's page is served from its own scheme (`bmapp://`): there the page is told to draw under the unsafe areas so that `env()` reports them. */
function coverViewport(): void {
    if (window.location.protocol !== 'bmapp:') return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta && !/viewport-fit/.test(meta.content)) meta.content += ', viewport-fit=cover';
}

/** Define the four variables (once). Safe to call from every module that draws UI. */
export function installSafeArea(): void {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
    coverViewport();
    const fixed = pinned();
    const value = (i: number): string => (fixed ? `${fixed[i]}px` : `env(safe-area-inset-${SIDES[i]}, 0px)`);
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `:root { ${SIDES.map((s, i) => `--tor-sai-${s}: ${value(i)};`).join(' ')} }`;
    document.head.appendChild(style);
}

let probe: HTMLDivElement | null = null;

/** The insets in CSS px right now (read through an element, because `env()` has no JavaScript API). */
export function safeInsets(): Insets {
    installSafeArea();
    if (!probe) {
        probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;'
            + 'padding:var(--tor-sai-top) var(--tor-sai-right) var(--tor-sai-bottom) var(--tor-sai-left)';
        document.body.appendChild(probe);
    }
    const cs = getComputedStyle(probe);
    return {
        top: parseFloat(cs.paddingTop) || 0,
        right: parseFloat(cs.paddingRight) || 0,
        bottom: parseFloat(cs.paddingBottom) || 0,
        left: parseFloat(cs.paddingLeft) || 0,
    };
}
