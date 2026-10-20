import type { EngineLike } from 'types/game.js';

/**
 * Procedural sound effects (Web Audio), routed through the engine's shared AudioContext and master
 * gain so the pause-menu mute / M key silence them. Every effect is a few oscillators and envelopes:
 * bright, toy-like and short. `roll()` drives a continuous rumble from the ball's speed.
 * Music is separate (generated tracks played through engine.playMusic).
 */
export class Sfx {
    private ctx: AudioContext | null = null;
    private out: GainNode | null = null;
    private rollGain: GainNode | null = null;
    private rollFilter: BiquadFilterNode | null = null;
    private rollSrc: AudioBufferSourceNode | null = null;
    private noiseBuf: AudioBuffer | null = null;
    private lastTick = -1;
    private combo = 0;
    private comboT = 0;
    volume = 0.55;

    constructor(private engine: EngineLike) {}

    /** Call from a user gesture (the Play press): builds the graph on first use. */
    init(): void {
        if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
        try {
            const ctx = this.engine.getAudioContext?.() ?? new AudioContext();
            this.ctx = ctx;
            this.out = ctx.createGain();
            this.out.gain.value = this.volume;
            this.out.connect(this.engine.getAudioDestination?.() ?? ctx.destination);
            // one second of white noise, reused by every noisy effect
            const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
            this.noiseBuf = buf;
            // rolling rumble: looped noise -> lowpass -> gain (silent until roll() feeds it)
            this.rollSrc = ctx.createBufferSource();
            this.rollSrc.buffer = buf; this.rollSrc.loop = true;
            this.rollFilter = ctx.createBiquadFilter(); this.rollFilter.type = 'lowpass'; this.rollFilter.frequency.value = 300;
            this.rollGain = ctx.createGain(); this.rollGain.gain.value = 0;
            this.rollSrc.connect(this.rollFilter).connect(this.rollGain).connect(this.out);
            this.rollSrc.start();
        } catch { this.ctx = null; }
    }

    private ok(): boolean { return !!this.ctx && this.ctx.state === 'running' && !!this.out; }

    private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, when = 0, attack = 0.005): void {
        if (!this.ok()) return;
        const ctx = this.ctx!, t = ctx.currentTime + when;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.out!);
        o.start(t); o.stop(t + dur + 0.05);
    }

    private noise(dur: number, gain: number, f0: number, f1: number, q = 1, when = 0, type: BiquadFilterType = 'bandpass'): void {
        if (!this.ok()) return;
        const ctx = this.ctx!, t = ctx.currentTime + when;
        const s = ctx.createBufferSource(); s.buffer = this.noiseBuf!;
        const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
        f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        s.connect(f).connect(g).connect(this.out!);
        s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
    }

    // ---- UI
    uiMove(): void { this.tone('triangle', 620, 760, 0.07, 0.12); }
    uiOk(): void { this.tone('triangle', 660, 660, 0.09, 0.16); this.tone('triangle', 990, 990, 0.12, 0.16, 0.07); }
    uiBack(): void { this.tone('triangle', 520, 380, 0.11, 0.14); }

    // ---- stage flow
    ready(): void { this.tone('square', 440, 440, 0.16, 0.10); this.tone('square', 440, 440, 0.16, 0.10, 0.24); }
    go(): void { this.tone('square', 660, 660, 0.22, 0.12); this.tone('square', 880, 880, 0.3, 0.12, 0.02); this.tone('triangle', 1320, 1320, 0.4, 0.10, 0.02); }
    tick(secondsLeft: number): void {
        const s = Math.ceil(secondsLeft);
        if (s === this.lastTick) return;
        this.lastTick = s;
        if (s <= 10 && s > 0) this.tone('square', s <= 3 ? 1250 : 880, s <= 3 ? 1250 : 880, 0.06, s <= 3 ? 0.14 : 0.09);
    }
    resetTick(): void { this.lastTick = -1; }

    goal(): void {
        const seq = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1567.98];
        seq.forEach((f, i) => { this.tone('triangle', f, f, 0.5, 0.14, i * 0.09); this.tone('sine', f * 2, f * 2, 0.4, 0.05, i * 0.09); });
        this.noise(0.9, 0.06, 6000, 9000, 0.5, 0.3, 'highpass');
        this.squeak(0.25); this.squeak(0.55);
    }
    oneUp(): void { [659, 784, 1319, 1047, 1175, 1568].forEach((f, i) => this.tone('square', f, f, 0.09, 0.09, i * 0.075)); }
    fall(): void { this.tone('triangle', 980, 110, 1.05, 0.16); this.tone('sine', 1300, 160, 0.9, 0.06, 0.05); }
    timeUp(): void { this.tone('sawtooth', 150, 140, 0.32, 0.14); this.tone('sawtooth', 150, 140, 0.32, 0.14, 0.42); this.tone('sawtooth', 110, 90, 0.6, 0.14, 0.84); }
    squeak(when = 0): void { this.tone('sine', 900, 1500, 0.07, 0.11, when); this.tone('sine', 1500, 1050, 0.09, 0.10, when + 0.07); }

    // ---- gameplay
    candy(value: number, dt = 0): void {
        void dt;
        const now = performance.now();
        this.combo = now - this.comboT < 700 ? Math.min(12, this.combo + 1) : 0;
        this.comboT = now;
        if (value >= 10) { [1046, 1318, 1568, 2093].forEach((f, i) => this.tone('triangle', f, f, 0.32, 0.13, i * 0.05)); return; }
        const semis = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28][this.combo] ?? 28;
        const f = 1318.5 * Math.pow(2, semis / 12) / 2;
        this.tone('triangle', f, f, 0.16, 0.13); this.tone('triangle', f * 1.5, f * 1.5, 0.2, 0.09, 0.05);
    }
    bump(strength: number): void {
        const k = Math.min(1, strength / 16);
        this.tone('sine', 260, 900, 0.09, 0.2); this.tone('sine', 900, 320, 0.3, 0.2 * (0.6 + k * 0.4), 0.09);
        this.tone('sine', 40, 40, 0.5, 0.0001);
    }
    impact(speed: number): void {
        const k = Math.min(1, speed / 20);
        this.tone('sine', 150 + 60 * k, 55, 0.16 + 0.1 * k, 0.16 + 0.18 * k);
        this.noise(0.08 + 0.05 * k, 0.09 + 0.08 * k, 1800, 500, 0.7);
    }
    warp(): void { this.tone('sine', 180, 1500, 0.5, 0.14); this.noise(0.55, 0.09, 400, 4200, 1.2); this.tone('triangle', 1500, 400, 0.4, 0.09, 0.4); }

    /** Continuous rolling rumble; call every frame. */
    roll(speed: number, grounded: boolean): void {
        if (!this.ok() || !this.rollGain || !this.rollFilter) return;
        const t = this.ctx!.currentTime;
        const g = grounded ? Math.min(0.22, speed * 0.016) : 0;
        this.rollGain.gain.setTargetAtTime(g, t, 0.06);
        this.rollFilter.frequency.setTargetAtTime(180 + speed * 55, t, 0.08);
    }
    silenceRoll(): void { if (this.rollGain && this.ctx) this.rollGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); }

    dispose(): void {
        try { this.rollSrc?.stop(); } catch { /* already stopped */ }
        this.out?.disconnect();
        this.ctx = null;
    }
}
