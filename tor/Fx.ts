import * as THREE from 'three';

/**
 * Feedback effects: pooled camera-facing particles (one InstancedMesh per glyph) and comic
 * sound-effect lettering ("BONK!", "+10") as DOM starbursts projected from world positions.
 * Particles live in WORLD space (they are short-lived, so the tilting stage doesn't matter).
 */
type Glyph = 'dot' | 'star' | 'puff' | 'spark';

function glyphTexture(kind: Glyph): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.translate(32, 32);
    if (kind === 'dot') {
        const r = g.createRadialGradient(0, 0, 0, 0, 0, 30);
        r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.55, 'rgba(255,255,255,0.95)'); r.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = r; g.beginPath(); g.arc(0, 0, 30, 0, 7); g.fill();
    } else if (kind === 'puff') {
        const r = g.createRadialGradient(0, 0, 4, 0, 0, 30);
        r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = r; g.beginPath(); g.arc(0, 0, 30, 0, 7); g.fill();
    } else if (kind === 'spark') {
        g.fillStyle = '#fff';
        g.beginPath(); g.moveTo(0, -30); g.lineTo(4, 0); g.lineTo(0, 30); g.lineTo(-4, 0); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(-30, 0); g.lineTo(0, 4); g.lineTo(30, 0); g.lineTo(0, -4); g.closePath(); g.fill();
    } else {
        g.fillStyle = '#fff'; g.beginPath();
        for (let i = 0; i < 10; i++) {
            const a = (i * Math.PI) / 5 - Math.PI / 2, r = i % 2 ? 12 : 29;
            g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        g.closePath(); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

interface P { alive: boolean; pos: THREE.Vector3; vel: THREE.Vector3; life: number; maxLife: number; size: number; grow: number; spin: number; roll: number; gravity: number; drag: number; color: THREE.Color; fade: number }

class Emitter {
    readonly mesh: THREE.InstancedMesh;
    private ps: P[] = [];
    private cursor = 0;
    private dummy = new THREE.Object3D();
    constructor(scene: THREE.Scene, kind: Glyph, private max: number, additive: boolean) {
        const mat = new THREE.MeshBasicMaterial({
            map: glyphTexture(kind), transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        });
        this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
        this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 6;
        this.mesh.count = max;
        for (let i = 0; i < max; i++) {
            this.ps.push({ alive: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, maxLife: 1, size: 0, grow: 0, spin: 0, roll: 0, gravity: 0, drag: 0, color: new THREE.Color(), fade: 1 });
            this.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
            this.dummy.scale.setScalar(0);
            this.dummy.updateMatrix();
            this.mesh.setMatrixAt(i, this.dummy.matrix);
        }
        scene.add(this.mesh);
    }
    spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: THREE.ColorRepresentation, size: number, life: number, o: { grow?: number; spin?: number; gravity?: number; drag?: number; fade?: number } = {}): void {
        this.mesh.visible = true;
        const p = this.ps[this.cursor]!;
        this.cursor = (this.cursor + 1) % this.max;
        p.alive = true; p.pos.copy(pos); p.vel.copy(vel); p.life = 0; p.maxLife = life; p.size = size; p.grow = o.grow ?? 0;
        p.spin = o.spin ?? 0; p.roll = Math.random() * 6.28; p.gravity = o.gravity ?? 0; p.drag = o.drag ?? 0; p.color.set(color); p.fade = o.fade ?? 1;
    }
    update(dt: number, cam: THREE.Camera): void {
        let any = false;
        for (let i = 0; i < this.max; i++) {
            const p = this.ps[i]!;
            if (!p.alive) continue;
            any = true;
            p.life += dt;
            if (p.life >= p.maxLife) {
                p.alive = false;
                this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix);
                continue;
            }
            p.vel.y -= p.gravity * dt;
            if (p.drag) p.vel.multiplyScalar(Math.exp(-p.drag * dt));
            p.pos.addScaledVector(p.vel, dt);
            p.roll += p.spin * dt;
            const k = p.life / p.maxLife;
            const s = p.size * (1 + p.grow * k) * (1 - Math.pow(k, p.fade * 3));
            this.dummy.position.copy(p.pos);
            this.dummy.quaternion.copy(cam.quaternion);
            this.dummy.rotateZ(p.roll);
            this.dummy.scale.setScalar(Math.max(0, s));
            this.dummy.updateMatrix();
            this.mesh.setMatrixAt(i, this.dummy.matrix);
            this.mesh.setColorAt(i, p.color);
        }
        if (any || this.dirty) { this.mesh.instanceMatrix.needsUpdate = true; if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true; }
        this.dirty = any;
        // an idle emitter is hidden: it was one draw call and one render object per frame for nothing. It stays visible for its first
        // seconds so its shader is compiled during the load/READY frames and not on the first candy pickup.
        if (this.warm > 0) this.warm--; else this.mesh.visible = any;
    }
    private dirty = false;
    private warm = 240;
    dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

const v0 = new THREE.Vector3();
const v1 = new THREE.Vector3();

export class Fx {
    private sparks: Emitter;
    private stars: Emitter;
    private dots: Emitter;
    private puffs: Emitter;
    private popRoot: HTMLDivElement;
    private lines: HTMLCanvasElement;
    private lineCtx: CanvasRenderingContext2D;
    private lineAlpha = 0;
    private lineClock = 0;
    private lineSeed = 1;
    /** Canvas size, kept by a ResizeObserver: reading clientWidth every frame forced a synchronous layout (0.2-0.3 ms per frame, the biggest item of the game's own CPU). */
    private lw = 0;
    private lh = 0;
    private ro: ResizeObserver | null = null;
    private pops: { el: HTMLElement; life: number; max: number; wp: THREE.Vector3; off: number }[] = [];

    constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera) {
        this.sparks = new Emitter(scene, 'spark', 160, true);
        this.stars = new Emitter(scene, 'star', 160, true);
        this.dots = new Emitter(scene, 'dot', 400, false);
        this.puffs = new Emitter(scene, 'puff', 200, false);
        this.popRoot = document.createElement('div');
        this.popRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:15;overflow:hidden;';
        document.body.appendChild(this.popRoot);
        this.lines = document.createElement('canvas');
        this.lines.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:14;';
        document.body.appendChild(this.lines);
        this.lineCtx = this.lines.getContext('2d')!;
        this.lw = window.innerWidth; this.lh = window.innerHeight;
        this.lines.width = this.lw; this.lines.height = this.lh;
        if (typeof ResizeObserver !== 'undefined') {
            this.ro = new ResizeObserver((es) => {
                const r = es[0]?.contentRect;
                if (!r) return;
                this.lw = Math.round(r.width); this.lh = Math.round(r.height);
            });
            this.ro.observe(this.lines);
        }
        if (!document.getElementById('tor-pop-style')) {
            const s = document.createElement('style');
            s.id = 'tor-pop-style';
            s.textContent = `
.tor-pop { position:absolute; left:0; top:0; will-change: transform, opacity; filter: drop-shadow(3px 0 0 #1b0e26) drop-shadow(-3px 0 0 #1b0e26) drop-shadow(0 3px 0 #1b0e26) drop-shadow(0 -3px 0 #1b0e26); }
.tor-pop > div { font-family: 'TOR Lilita', var(--hud-font-family,'Lilita One'), 'Arial Rounded MT Bold', sans-serif; color:#fff; font-size: 38px; line-height:1; padding: 30px 34px; text-align:center; letter-spacing:1px;
  background: radial-gradient(circle at 50% 40%, #fff27a, #ffb21f 70%, #ff7a12); color:#3a1010; text-shadow: 0 2px 0 rgba(255,255,255,.6);
  clip-path: polygon(50% 0%, 61% 24%, 88% 10%, 76% 38%, 100% 50%, 76% 62%, 88% 90%, 61% 76%, 50% 100%, 39% 76%, 12% 90%, 24% 62%, 0% 50%, 24% 38%, 12% 10%, 39% 24%); }
.tor-pop.pink > div { background: radial-gradient(circle at 50% 40%, #ffd1ec, #ff6bb5 70%, #d93a93); }
.tor-pop.blue > div { background: radial-gradient(circle at 50% 40%, #c9f4ff, #47c8ff 70%, #1f8fd6); }
.tor-pop.green > div { background: radial-gradient(circle at 50% 40%, #e2ffb8, #9bf03c 70%, #5cb81f); }`;
            document.head.appendChild(s);
        }
    }

    update(dt: number): void {
        this.sparks.update(dt, this.camera); this.stars.update(dt, this.camera); this.dots.update(dt, this.camera); this.puffs.update(dt, this.camera);
        const w = window.innerWidth, h = window.innerHeight;
        for (let i = this.pops.length - 1; i >= 0; i--) {
            const p = this.pops[i]!;
            p.life += dt;
            if (p.life >= p.max) { p.el.remove(); this.pops.splice(i, 1); continue; }
            const k = p.life / p.max;
            v0.copy(p.wp).project(this.camera);
            const x = (v0.x * 0.5 + 0.5) * w, y = (-v0.y * 0.5 + 0.5) * h - k * 60 - p.off;
            const pop = (k < 0.15 ? 0.4 + (k / 0.15) * 0.8 : 1.2 - (k - 0.15) * 0.25) * Math.max(0.5, Math.min(1, w / 1000));   // smaller lettering on phones
            const rot = -8 + Math.sin(p.life * 22) * (k < 0.3 ? 3 : 0);
            p.el.style.transform = `translate(${x}px, ${y}px) translate(-50%,-50%) rotate(${rot}deg) scale(${pop})`;
            p.el.style.opacity = k > 0.75 ? String(1 - (k - 0.75) / 0.25) : '1';
            if (v0.z > 1) p.el.style.opacity = '0';
        }
    }

    /** Comic speed lines rushing in from the screen edges; alpha follows speed (m/s). Flickers at ~20 Hz like inked frames. */
    speedLines(speed: number, dt: number): void {
        const target = Math.max(0, Math.min(1, (speed - 12) / 12)) * 0.6;
        this.lineAlpha += (target - this.lineAlpha) * Math.min(1, dt * 6);
        const w = this.lw, h = this.lh;
        if (this.lines.width !== w || this.lines.height !== h) { this.lines.width = w; this.lines.height = h; }
        const g = this.lineCtx;
        this.lineClock += dt;
        if (this.lineAlpha < 0.02) { if (this.lineClock > 0.2) { g.clearRect(0, 0, w, h); this.lineClock = 0; } return; }
        if (this.lineClock < 0.05) return;
        this.lineClock = 0;
        this.lineSeed = (this.lineSeed * 16807) % 2147483647;
        let r = this.lineSeed;
        const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
        g.clearRect(0, 0, w, h);
        const cx = w / 2, cy = h * 0.55, R = Math.hypot(w, h) / 2;
        g.lineCap = 'round';
        const n = 34;
        for (let i = 0; i < n; i++) {
            const a = rnd() * Math.PI * 2;
            const r0 = R * (0.62 + rnd() * 0.22), r1 = R * (0.95 + rnd() * 0.1);
            const x0 = cx + Math.cos(a) * r0, y0 = cy + Math.sin(a) * r0, x1 = cx + Math.cos(a) * r1, y1 = cy + Math.sin(a) * r1;
            const wd = 1.5 + rnd() * 3.5;
            g.globalAlpha = this.lineAlpha * 0.9;
            g.strokeStyle = '#1b0e26'; g.lineWidth = wd + 3;
            g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
            g.strokeStyle = '#ffffff'; g.lineWidth = wd;
            g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        }
        g.globalAlpha = 1;
    }

    /**
     * Comic lettering popping at a world position. `quiet` (a stage look's candy pops): the badge's padding shrinks with its text and it is drawn at
     * `quiet` opacity, so a stream of "+1"s no longer covers the ball.
     */
    pop(text: string, world: THREE.Vector3, tone: '' | 'pink' | 'blue' | 'green' = '', life = 0.9, size = 1, quiet: number | null = null): void {
        const el = document.createElement('div');
        el.className = `tor-pop ${tone}`;
        if (quiet !== null) el.style.opacity = String(quiet);
        el.innerHTML = quiet !== null
            ? `<div style="font-size:${Math.round(34 * size)}px;padding:${Math.round(30 * size)}px ${Math.round(34 * size)}px">${text}</div>`
            : `<div style="font-size:${Math.round(34 * size)}px">${text}</div>`;
        this.popRoot.appendChild(el);
        this.pops.push({ el, life: 0, max: life, wp: world.clone(), off: 0 });
        if (this.pops.length > 6) { const o = this.pops.shift()!; o.el.remove(); }
    }

    /** Sparkle burst when collecting candy. */
    candy(world: THREE.Vector3, color: THREE.ColorRepresentation, big = false): void {
        const n = big ? 26 : 12;
        for (let i = 0; i < n; i++) {
            v1.set(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize().multiplyScalar(1.6 + Math.random() * (big ? 4.5 : 2.6));
            (i % 3 === 0 ? this.stars : this.sparks).spawn(world, v1, color, 0.13 + Math.random() * 0.13, 0.5 + Math.random() * 0.35, { gravity: 4, drag: 2, spin: 6, fade: 1 });
        }
        for (let i = 0; i < 6; i++) this.dots.spawn(world, v1.set((Math.random() - 0.5) * 3, 1 + Math.random() * 2, (Math.random() - 0.5) * 3), '#fff6b0', 0.09, 0.4, { gravity: 3, drag: 1.5 });
    }

    /** Dust puff where the ball lands or hits a wall. */
    impact(world: THREE.Vector3, normal: THREE.Vector3, strength: number): void {
        const n = Math.min(14, 4 + Math.floor(strength));
        for (let i = 0; i < n; i++) {
            v1.set(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5).addScaledVector(normal, 0.7).normalize().multiplyScalar(0.6 + Math.random() * Math.min(3, strength * 0.25));
            this.puffs.spawn(world, v1, '#fbe8cc', 0.32 + Math.random() * 0.2, 0.55 + Math.random() * 0.3, { grow: 1.6, drag: 3, gravity: -0.2, fade: 0.8 });
        }
        if (strength > 8) for (let i = 0; i < 5; i++) this.stars.spawn(world, v1.set((Math.random() - 0.5) * 6, 1 + Math.random() * 3, (Math.random() - 0.5) * 6), '#ffe27a', 0.2, 0.4, { gravity: 6, spin: 8 });
    }

    /** Big confetti fountain at the goal. */
    confetti(world: THREE.Vector3, intensity = 1): void {
        const cols = ['#ff5fa8', '#37d0ff', '#9cff4a', '#ffd534', '#ff8a2a', '#b47cff', '#ffffff'];
        for (let i = 0; i < 70 * intensity; i++) {
            v1.set((Math.random() - 0.5) * 5, 5 + Math.random() * 7, (Math.random() - 0.5) * 5);
            this.dots.spawn(world, v1, cols[i % cols.length]!, 0.13 + Math.random() * 0.1, 1.6 + Math.random() * 1.2, { gravity: 9, drag: 0.6, spin: 5 + Math.random() * 8 });
        }
        for (let i = 0; i < 30 * intensity; i++) {
            v1.set((Math.random() - 0.5) * 4, 4 + Math.random() * 5, (Math.random() - 0.5) * 4);
            this.stars.spawn(world, v1, cols[i % cols.length]!, 0.28, 1.2 + Math.random(), { gravity: 5, drag: 0.8, spin: 6 });
        }
    }

    /** Wormhole / spawn swirl. */
    swirl(world: THREE.Vector3, color: THREE.ColorRepresentation): void {
        for (let i = 0; i < 30; i++) {
            const a = (i / 30) * 6.28;
            v1.set(Math.cos(a) * 2.2, 0.4 + Math.random(), Math.sin(a) * 2.2);
            this.sparks.spawn(world, v1, color, 0.16, 0.6, { drag: 3, spin: 10 });
        }
    }

    dispose(): void {
        this.sparks.dispose(); this.stars.dispose(); this.dots.dispose(); this.puffs.dispose();
        this.popRoot.remove();
        this.ro?.disconnect();
        this.lines.remove();
    }
}
