/**
 * Trick or Roll's achievements. The definitions (names, descriptions, XP, the hidden flag) live in
 * world.json's `worldProfileData.achievements`; this file only names the ids the game fires. On the
 * Bitmagic platform they award Bitmagic XP; in a Steam build the engine hands them to Steam instead.
 */
import type { EngineLike } from 'types/game.js';
import type { CourseDef } from './session.js';

export type AchievementId =
    | 'first_goal' | 'sweet_tooth' | 'photo_finish'
    | 'patch_cleared' | 'graveyard_cleared' | 'workshop_cleared' | 'not_a_scratch';

/** Clearing every stage of a course in one Challenge run. */
export const COURSE_CLEARED: Record<CourseDef['id'], AchievementId> = {
    beginner: 'patch_cleared',
    advanced: 'graveyard_cleared',
    expert: 'workshop_cleared',
};

/** Under this many seconds on the clock at the goal is a photo finish. */
export const PHOTO_FINISH_SECONDS = 3;

/** Fire one unlock. The engine dedupes, toasts, and delivers it (Bitmagic XP, or Steam). */
export function unlock(engine: EngineLike, id: AchievementId): void {
    (engine as EngineLike & { unlockAchievement?: (id: string) => void }).unlockAchievement?.(id);
}
