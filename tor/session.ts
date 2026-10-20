/**
 * Run state (lives, candy, score) and persistence for Trick or Roll.
 *
 * Rules follow the arcade original: 4 lives, every 100 candies is a 1-UP, falling out or running
 * out of time costs a life AND takes back the candy collected during that attempt.
 */
export interface CourseDef {
    id: 'beginner' | 'advanced' | 'expert';
    title: string;
    world: string;
    blurb: string;
    /** Stage asset names, in play order. */
    stages: string[];
}

export const COURSES: CourseDef[] = [
    { id: 'beginner', title: 'Beginner', world: 'patch', blurb: 'Pumpkin Patch: ten friendly stages at golden hour.', stages: ['b01', 'b02', 'b03', 'b04', 'b05', 'b06', 'b07', 'b08', 'b09', 'b10'] },
    { id: 'advanced', title: 'Advanced', world: 'graveyard', blurb: 'Moonlit Graveyard: narrow paths, rails only where they matter.', stages: ['a01', 'a02', 'a03', 'a04', 'a05', 'a06', 'a07', 'a08', 'a09', 'a10'] },
    { id: 'expert', title: 'Expert', world: 'workshop', blurb: "Witch's Workshop: slim rune walks, moving parts, hardly a rail in sight.", stages: ['e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10'] },
];

export const START_LIVES = 4;
export const CANDY_PER_LIFE = 100;
export const CANDY_POINTS = 100;
export const TIME_POINTS = 100;

const KEY = 'trickorroll:v1';

export interface SaveData {
    /** Best clear per stage: seconds left at the goal (higher is better) and candy. */
    best: Record<string, { timeLeft: number; candy: number }>;
    /** Highest stage index cleared per course (count of cleared stages in a row). */
    cleared: Record<string, number>;
    highScore: number;
    character: string;
    settings: { tiltSensitivity: number; keys?: 'gentle' | 'normal' | 'quick'; mouse?: boolean; mouseSpeed?: 'slow' | 'normal' | 'fast'; openAll?: boolean };
    /** The first-run control hint has been shown. */
    hinted?: boolean;
}

const DEFAULT_SAVE: SaveData = { best: {}, cleared: {}, highScore: 0, character: 'hamster', settings: { tiltSensitivity: 1 } };

export function loadSave(): SaveData {
    try {
        const raw = localStorage.getItem(KEY);
        if (raw) return { ...DEFAULT_SAVE, ...JSON.parse(raw) } as SaveData;
    } catch { /* private mode / blocked storage: play without saves */ }
    return { ...DEFAULT_SAVE, best: {}, cleared: {}, settings: { ...DEFAULT_SAVE.settings } };
}

export function writeSave(s: SaveData): void {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export class Session {
    lives = START_LIVES;
    score = 0;
    /** Candy across the run (drives the 1-UP counter). */
    candy = 0;
    stageIndex = 0;
    private candyAtStageStart = 0;
    private scoreAtStageStart = 0;
    /** Practice sessions (a single stage picked from the menu) never run out of lives. */
    practice = false;

    constructor(public course: CourseDef) {}

    get stageName(): string { return this.course.stages[this.stageIndex]!; }
    get stageNumber(): number { return this.stageIndex + 1; }
    get isLastStage(): boolean { return this.stageIndex >= this.course.stages.length - 1; }

    beginStage(): void {
        this.candyAtStageStart = this.candy;
        this.scoreAtStageStart = this.score;
    }

    /** Add candy; returns how many 1-UPs it earned. */
    addCandy(n: number): number {
        const before = Math.floor(this.candy / CANDY_PER_LIFE);
        this.candy += n;
        this.score += n * CANDY_POINTS;
        const ups = Math.floor(this.candy / CANDY_PER_LIFE) - before;
        if (ups > 0) this.lives += ups;
        return ups;
    }

    /** Lost a life: candy and score from this attempt are taken back. Returns true if the run continues. */
    loseLife(): boolean {
        this.candy = this.candyAtStageStart;
        this.score = this.scoreAtStageStart;
        if (!this.practice) this.lives -= 1;
        return this.lives > 0;
    }

    /** Stage cleared: award the time bonus, advance. */
    clearStage(timeLeft: number): { timeBonus: number; stageCandy: number } {
        const timeBonus = Math.floor(timeLeft) * TIME_POINTS;
        this.score += timeBonus;
        const stageCandy = this.candy - this.candyAtStageStart;
        this.stageIndex += 1;
        return { timeBonus, stageCandy };
    }

    reset(): void {
        this.lives = START_LIVES; this.score = 0; this.candy = 0; this.stageIndex = 0;
        this.candyAtStageStart = 0; this.scoreAtStageStart = 0;
    }
}
