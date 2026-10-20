import { clamp } from '../sim/math3.js';

/** How a key sweeps the stick: seconds from 0 to full (rise) and back (fall), and a curve exponent that makes small deflections finer. */
export type KeyProfile = 'gentle' | 'normal' | 'quick';
export const KEY_PROFILES: Record<KeyProfile, { rise: number; fall: number; exp: number; label: string }> = {
    gentle: { rise: 0.65, fall: 0.30, exp: 1.4, label: 'Gentle' },
    normal: { rise: 0.38, fall: 0.20, exp: 1.2, label: 'Normal' },
    quick: { rise: 0.16, fall: 0.11, exp: 1.0, label: 'Quick' },
};

/**
 * Trick or Roll input: one analog "tilt" stick (x right, y forward, both -1..1) plus a camera
 * stick and a few buttons, merged from keyboard, gamepad, mouse and touch.
 *
 *  - Keyboard: WASD / arrows sweep the stick toward full deflection over KEY_PROFILES[profile].rise (0.65 s by
 *    default: a tap is a nudge, holding builds up) and ease back, so keys feel analog like a stick. Q/E orbit
 *    the camera. Space / Enter confirm, Esc / P pause, R retry, M toggles mouse tilt.
 *  - Mouse tilt (opt-in, M or the CONTROLS menu): the mouse is captured (pointer lock, so the OS cursor is hidden) and
 *    moves a VIRTUAL pointer that always starts in the centre (neutral) when a stage begins, whatever the real cursor was
 *    doing; a ring with a dot shows the tilt. A click re-centres it, Esc / losing the capture pauses.
 *  - Gamepad: left stick tilts, right stick orbits the camera, A confirms, Start pauses, Y retries.
 *  - Touch: a floating stick on the left half of the screen, camera drag on the right half.
 *
 * Own listeners are used on purpose (this game has no player controller, so the engine's control
 * layer is absent); touch is provided here so phones are not stranded.
 */
export class Input {
    /** Tilt stick, camera-relative: x right, y forward. */
    readonly stick = { x: 0, y: 0 };
    /** Camera orbit input, -1..1 (positive = camera swings right). */
    camera = 0;
    /** One-shot presses, consumed by `take()`. */
    private pressed = new Set<string>();
    private keys = new Set<string>();
    private kx = 0;
    private ky = 0;
    private touchStick = { x: 0, y: 0, active: false, id: -1, ox: 0, oy: 0 };
    private touchCam = { active: false, id: -1, lastX: 0, dx: 0 };
    private disposers: Array<() => void> = [];
    private padPrev: boolean[] = [];
    /** Set by the game: while true, tilt keys are ignored (menus). */
    locked = false;
    /** Autoplay / tests: when set, replaces the stick each frame. */
    override: { x: number; y: number } | null = null;
    lastDevice: 'keyboard' | 'pad' | 'touch' | 'mouse' = 'keyboard';
    /** Key ramp profile (see KEY_PROFILES). */
    keyProfile: KeyProfile = 'gentle';
    /** The game hears about M toggling mouse tilt (to save it and say so). */
    onMouseToggle: ((on: boolean) => void) | null = null;
    /** Mouse tilt: `vx, vy` is the virtual pointer (unit disc, y up); `captured` = pointer lock is held. */
    private mouse = { on: false, vx: 0, vy: 0, captured: false, speed: 1 };
    private pad: { root: HTMLDivElement; ring: HTMLDivElement; dot: HTMLDivElement; line: HTMLDivElement; label: HTMLDivElement; R: number } | null = null;
    /** The game shows the tilt pad only while playing. */
    showRing = true;
    /** The game sets this while a tap or click means "continue" (intro skip, result and game-over panels): it presses `confirm`. */
    tapConfirm = false;
    /** The game says when a stage is running: only then is the mouse captured (menus need the real cursor). */
    wantCapture = false;
    /** Capture was lost while a stage was running (Esc, alt-tab): the game pauses. */
    onCaptureLost: (() => void) | null = null;
    /** The game says when this must ignore the keyboard and the mouse altogether: while the engine is not playing (paused, loading) the pause card owns both. */
    suspendWhen: (() => boolean) | null = null;
    private suspended(): boolean { return this.suspendWhen?.() === true; }
    /** A click on a button, link or menu belongs to that control: it must never be taken for "capture the mouse". */
    private onUi(target: EventTarget | null): boolean {
        return target instanceof Element && target.closest('button, a, input, select, textarea, label, [role="button"], .ui-modal-overlay, #tor-menu') !== null;
    }
    /** True when the current stick value comes from the keyboard ramp (menus use the edge presses instead). */
    stickFromKeys = false;
    /** Extra px radius of the touch stick travel. */
    touchRadius = 84;
    private overlay: HTMLDivElement | null = null;
    private knob: HTMLDivElement | null = null;
    private base: HTMLDivElement | null = null;

    constructor(private surface: HTMLElement) {
        const on = <K extends keyof WindowEventMap>(t: Window, e: K, f: (ev: WindowEventMap[K]) => void, o?: AddEventListenerOptions) => {
            t.addEventListener(e, f as EventListener, o);
            this.disposers.push(() => t.removeEventListener(e, f as EventListener, o));
        };
        on(window, 'keydown', (e) => {
            if (this.suspended()) return;   // the pause card has the keyboard: nothing here may queue up for the next screen, and no key may grab the mouse
            if (e.repeat) { this.keys.add(e.code); return; }
            this.keys.add(e.code);
            this.lastDevice = 'keyboard';
            const map: Record<string, string> = {
                Space: 'confirm', Enter: 'confirm', KeyP: 'pause', KeyR: 'retry', KeyC: 'camreset', Backspace: 'back',
            };
            const a = map[e.code];
            if (a) this.pressed.add(a);
            if (e.code === 'KeyM') { this.setMouseMode(!this.mouse.on); this.capture(); this.onMouseToggle?.(this.mouse.on); }
            else if (this.mouse.on && this.wantCapture && !this.mouse.captured && e.code !== 'Escape') this.capture();   // any key press is a gesture
            const nav: Record<string, string> = { ArrowLeft: 'nav-left', KeyA: 'nav-left', ArrowRight: 'nav-right', KeyD: 'nav-right', ArrowUp: 'nav-up', KeyW: 'nav-up', ArrowDown: 'nav-down', KeyS: 'nav-down' };
            if (nav[e.code]) this.pressed.add(nav[e.code]!);
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
        });
        on(window, 'keyup', (e) => { this.keys.delete(e.code); });
        on(window, 'blur', () => { this.keys.clear(); });
        on(window, 'pointerdown', () => { if (this.tapConfirm && !this.suspended()) this.pressed.add('confirm'); });   // a tap on a phone, a click with the mouse
        on(window, 'mousemove', (e) => {
            if (!this.mouse.on || !this.mouse.captured || this.locked || this.suspended()) return;
            this.moveVirtual(e.movementX, e.movementY);
            this.lastDevice = 'mouse';
        });
        on(window, 'mousedown', (e) => {
            if (!this.mouse.on || this.suspended() || this.onUi(e.target)) return;
            if (!this.mouse.captured) { if (this.wantCapture) this.capture(); } else this.recenterMouse();   // a click is the panic button
        });
        const lockChange = (): void => {
            const was = this.mouse.captured;
            this.mouse.captured = !!document.pointerLockElement;
            if (this.mouse.captured) this.recenterMouse();
            else if (was && this.mouse.on && this.wantCapture) this.onCaptureLost?.();
        };
        document.addEventListener('pointerlockchange', lockChange);
        this.disposers.push(() => document.removeEventListener('pointerlockchange', lockChange));
        this.installTouch();
    }

    private installTouch(): void {
        const s = this.surface;
        const isTouchCapable = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        if (!isTouchCapable) return;
        const mkOverlay = () => {
            const o = document.createElement('div');
            o.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:20;';
            const base = document.createElement('div');
            base.style.cssText = 'position:absolute;width:150px;height:150px;margin:-75px 0 0 -75px;border-radius:50%;border:4px solid rgba(20,10,30,.85);background:rgba(255,190,90,.22);display:none;box-shadow:0 0 0 3px rgba(255,255,255,.35) inset;';
            const knob = document.createElement('div');
            knob.style.cssText = 'position:absolute;width:64px;height:64px;margin:-32px 0 0 -32px;border-radius:50%;border:4px solid #1b0e26;background:#ffab2e;display:none;box-shadow:0 4px 0 #b3560a;';
            o.appendChild(base); o.appendChild(knob);
            document.body.appendChild(o);
            this.overlay = o; this.base = base; this.knob = knob;
            this.disposers.push(() => o.remove());
        };
        mkOverlay();
        const down = (e: PointerEvent) => {
            if (e.pointerType === 'mouse') return;
            this.lastDevice = 'touch';
            const half = window.innerWidth / 2;
            if (e.clientX < half && !this.touchStick.active) {
                this.touchStick = { x: 0, y: 0, active: true, id: e.pointerId, ox: e.clientX, oy: e.clientY };
                if (this.base && this.knob) {
                    this.base.style.display = this.knob.style.display = 'block';
                    this.base.style.left = e.clientX + 'px'; this.base.style.top = e.clientY + 'px';
                    this.knob.style.left = e.clientX + 'px'; this.knob.style.top = e.clientY + 'px';
                }
            } else if (e.clientX >= half && !this.touchCam.active) {
                this.touchCam = { active: true, id: e.pointerId, lastX: e.clientX, dx: 0 };
            }
        };
        const move = (e: PointerEvent) => {
            if (this.touchStick.active && e.pointerId === this.touchStick.id) {
                let dx = e.clientX - this.touchStick.ox, dy = e.clientY - this.touchStick.oy;
                const m = Math.hypot(dx, dy);
                const R = this.touchRadius;
                if (m > R) { dx *= R / m; dy *= R / m; }
                this.touchStick.x = dx / R; this.touchStick.y = -dy / R;
                if (this.knob) { this.knob.style.left = this.touchStick.ox + dx + 'px'; this.knob.style.top = this.touchStick.oy + dy + 'px'; }
            } else if (this.touchCam.active && e.pointerId === this.touchCam.id) {
                this.touchCam.dx += (e.clientX - this.touchCam.lastX);
                this.touchCam.lastX = e.clientX;
            }
        };
        const up = (e: PointerEvent) => {
            if (e.pointerId === this.touchStick.id) {
                this.touchStick = { x: 0, y: 0, active: false, id: -1, ox: 0, oy: 0 };
                if (this.base && this.knob) this.base.style.display = this.knob.style.display = 'none';
            }
            if (e.pointerId === this.touchCam.id) this.touchCam = { active: false, id: -1, lastX: 0, dx: 0 };
        };
        s.addEventListener('pointerdown', down);
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        this.disposers.push(() => {
            s.removeEventListener('pointerdown', down);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
        });
    }

    setKeyProfile(p: KeyProfile): void { this.keyProfile = p; }

    /** Switch mouse tilt on or off. The virtual pointer always restarts in the centre. */
    setMouseMode(on: boolean): void {
        this.mouse.on = on;
        this.recenterMouse();
        if (!on) this.release();
    }
    /** Mouse speed multiplier: 1 = full tilt after moving about 30 % of the window height. */
    setMouseSpeed(mult: number): void { this.mouse.speed = mult; }

    /** Put the virtual pointer back in the middle (neutral tilt). */
    recenterMouse(): void { this.mouse.vx = this.mouse.vy = 0; }

    /** Capture the mouse (pointer lock: hides the OS cursor, gives unlimited relative movement). Needs a user gesture. */
    capture(): void {
        if (!this.mouse.on || this.mouse.captured || this.suspended()) return;
        const el = this.surface as HTMLElement & { requestPointerLock?: () => Promise<void> | void };
        try {
            const r = el.requestPointerLock?.();
            if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => { /* no gesture yet: the pad asks for a click */ });
        } catch { /* unsupported */ }
    }
    release(): void { if (document.pointerLockElement) document.exitPointerLock(); }

    private moveVirtual(dx: number, dy: number): void {
        const R = (0.3 * Math.min(window.innerWidth, window.innerHeight)) / this.mouse.speed;
        this.mouse.vx += dx / R;
        this.mouse.vy -= dy / R;
        const m = Math.hypot(this.mouse.vx, this.mouse.vy);
        if (m > 1) { this.mouse.vx /= m; this.mouse.vy /= m; }
    }

    /** The tilt pad: a ring around the middle of the screen with a dot at the current tilt (and a prompt when not captured). */
    private updatePad(): void {
        const show = this.mouse.on && this.showRing && !this.locked;
        if (!this.pad) {
            if (!show) return;
            const root = document.createElement('div');
            root.style.cssText = 'position:fixed;left:50%;top:50%;width:0;height:0;pointer-events:none;z-index:19;display:none;';
            const ring = document.createElement('div');
            ring.style.cssText = 'position:absolute;border:3px solid rgba(255,255,255,.4);border-radius:50%;box-sizing:border-box;box-shadow:0 0 0 2px rgba(20,10,30,.4), inset 0 0 0 2px rgba(20,10,30,.22);';
            const tick = document.createElement('div');
            tick.style.cssText = 'position:absolute;left:-1px;top:-1px;width:2px;height:2px;';
            const line = document.createElement('div');
            line.style.cssText = 'position:absolute;left:0;top:-2px;height:4px;transform-origin:0 50%;border-radius:2px;background:rgba(255,232,170,.75);box-shadow:0 0 0 1.5px rgba(20,10,30,.55);';
            const dot = document.createElement('div');
            dot.style.cssText = 'position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;border:3px solid #1b0e26;box-sizing:border-box;';
            const label = document.createElement('div');
            label.textContent = 'CLICK to capture the mouse';
            label.style.cssText = "position:absolute;left:-150px;width:300px;text-align:center;font:22px 'Lilita One','Arial Rounded MT Bold',sans-serif;color:#fff6dc;text-shadow:0 2px 0 #1b0e26,2px 0 0 #1b0e26,-2px 0 0 #1b0e26,0 -2px 0 #1b0e26;";
            root.append(ring, tick, line, dot, label);
            document.body.appendChild(root);
            this.pad = { root, ring, dot, line, label, R: 0 };
            this.disposers.push(() => root.remove());
        }
        const p = this.pad;
        p.root.style.display = show ? 'block' : 'none';
        if (!show) return;
        const R = Math.round(0.15 * Math.min(window.innerWidth, window.innerHeight));
        if (R !== p.R) {
            p.R = R;
            p.ring.style.cssText += `width:${2 * R}px;height:${2 * R}px;left:${-R}px;top:${-R}px;`;
            p.label.style.top = `${R + 14}px`;
        }
        const cap = this.mouse.captured;
        p.label.style.display = cap ? 'none' : 'block';
        p.ring.style.borderStyle = cap ? 'solid' : 'dashed';
        p.dot.style.display = p.line.style.display = cap ? 'block' : 'none';
        if (!cap) return;
        const m = Math.hypot(this.mouse.vx, this.mouse.vy);
        const sc = m > 0 ? Math.pow(m, 0.3) : 0;                                   // the same shaping as the tilt itself
        const tx = this.mouse.vx * sc * R, ty = -this.mouse.vy * sc * R;
        const len = Math.hypot(tx, ty);
        p.dot.style.transform = `translate(${tx}px, ${ty}px)`;
        p.dot.style.background = `radial-gradient(circle at 40% 35%, #fff, hsl(${Math.round(48 - 40 * Math.min(1, len / R))}, 100%, 62%))`;
        p.line.style.width = `${len}px`;
        p.line.style.transform = `rotate(${Math.atan2(ty, tx)}rad)`;
    }
    get mouseMode(): boolean { return this.mouse.on; }

    /** Consume a one-shot press ("confirm" | "pause" | "retry" | "camreset" | "back"). */
    take(action: string): boolean {
        const had = this.pressed.has(action);
        this.pressed.delete(action);
        return had;
    }

    /** Forget presses nobody consumed (arrow keys or Enter hit while a pause card or a panel had no use for them), so they do not fire in the next screen. */
    clearPresses(): void { this.pressed.clear(); }

    /** Programmatic press (touch UI buttons, tests). */
    press(action: string): void { this.pressed.add(action); }

    /** Poll all devices once per frame. */
    update(dt: number): void {
        // keyboard ramp
        const kx = (this.keys.has('ArrowRight') || this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('ArrowLeft') || this.keys.has('KeyA') ? 1 : 0);
        const ky = (this.keys.has('ArrowUp') || this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('ArrowDown') || this.keys.has('KeyS') ? 1 : 0);
        const P = KEY_PROFILES[this.keyProfile];
        const up = dt / P.rise, down = dt / P.fall;
        const ease = (cur: number, dir: number): number => {
            if (dir === 0) return cur > 0 ? Math.max(0, cur - down) : Math.min(0, cur + down);
            if (cur * dir < 0) return cur + dir * Math.max(up, down);      // reversing: cross zero at the quicker rate
            return clamp(cur + dir * up, -1, 1);
        };
        this.kx = ease(this.kx, kx);
        this.ky = ease(this.ky, ky);
        const shape = (k: number): number => Math.sign(k) * Math.pow(Math.abs(k), P.exp);   // finer near zero
        let x = shape(this.kx), y = shape(this.ky);
        let cam = (this.keys.has('KeyE') ? 1 : 0) - (this.keys.has('KeyQ') ? 1 : 0);

        // mouse tilt: the virtual pointer is the stick (finer near the middle); the real cursor never matters
        if (this.mouse.on && !this.wantCapture && this.mouse.captured) this.release();
        this.updatePad();
        if (this.mouse.on && this.mouse.captured && !this.locked) {
            const m = Math.hypot(this.mouse.vx, this.mouse.vy);
            if (m > 1e-4) {
                const sc = Math.pow(m, 0.3);
                const mx = this.mouse.vx * sc, my = this.mouse.vy * sc;
                if (Math.abs(mx) > Math.abs(x)) x = mx;
                if (Math.abs(my) > Math.abs(y)) y = my;
            }
        }

        // gamepad
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const p of pads) {
            if (!p) continue;
            const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
            const gx = dz(p.axes[0] ?? 0), gy = -dz(p.axes[1] ?? 0);
            const dpx = (p.buttons[15]?.pressed ? 1 : 0) - (p.buttons[14]?.pressed ? 1 : 0);
            const dpy = (p.buttons[12]?.pressed ? 1 : 0) - (p.buttons[13]?.pressed ? 1 : 0);
            if (Math.abs(gx) + Math.abs(gy) + Math.abs(dpx) + Math.abs(dpy) > 0.01) {
                x = Math.abs(gx) > Math.abs(x) ? gx : (dpx || x);
                y = Math.abs(gy) > Math.abs(y) ? gy : (dpy || y);
                this.lastDevice = 'pad';
            }
            const cx = dz(p.axes[2] ?? 0);
            if (Math.abs(cx) > Math.abs(cam)) cam = cx;
            const btn = (i: number, name: string) => {
                const now = !!p.buttons[i]?.pressed;
                if (now && !this.padPrev[i]) { this.pressed.add(name); this.lastDevice = 'pad'; }
                this.padPrev[i] = now;
            };
            btn(0, 'confirm'); btn(9, 'pause'); btn(3, 'retry'); btn(1, 'back'); btn(10, 'camreset');
            btn(12, 'nav-up'); btn(13, 'nav-down'); btn(14, 'nav-left'); btn(15, 'nav-right');
            break;
        }
        // touch
        this.stickFromKeys = this.lastDevice === 'keyboard';
        if (this.touchStick.active) {   // finer near the middle, like the gentle keys and the mouse: a small drag is a small tilt
            const sh = (v: number): number => Math.sign(v) * Math.pow(Math.abs(v), 1.3);
            x = sh(this.touchStick.x); y = sh(this.touchStick.y);
        }
        if (this.touchCam.active || this.touchCam.dx !== 0) {
            cam = clamp(this.touchCam.dx / 40, -1.5, 1.5);
            this.touchCam.dx *= 0.5;
        }
        if (this.locked) { x = 0; y = 0; }
        if (this.override) { x = this.override.x; y = this.override.y; }
        this.stick.x = clamp(x, -1, 1);
        this.stick.y = clamp(y, -1, 1);
        this.camera = cam;
    }

    dispose(): void {
        this.release();
        for (const d of this.disposers) d();
        this.disposers = [];
    }
}
