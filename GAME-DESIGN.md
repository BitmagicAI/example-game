# Trick or Roll

*Tilt the world. Roll home. Collect the candy. Don't fall.*

## Pitch

A faithful **Super Monkey Ball**-style tilt-the-stage ball game with its own identity. You never steer the ball
directly: you tilt the whole floating stage with the stick (or keys, or a finger) and gravity does the rolling.
A golden **hamster** runs inside a glass ball through a spooky-cute, comic-book **Halloween harvest world**:
narrow plank walkways, moving pumpkin-crate platforms, spinning scarecrow discs, jack-o'-lantern bumpers,
conveyor belts, launch ramps and wormholes, all drifting in a violet twilight sky under a giant harvest moon.
Roll through the glowing **jack-o'-lantern goal gate** before the 60-second timer runs out, grab as many wrapped
**candies** as you can, and don't fall off the world.

## Core loop

1. Read the stage from the fly-through camera (goal to start), then "READY? ... GO!".
2. Tilt the stage to roll the hamster ball along the course. Momentum, slopes, bumpers and moving parts do the rest.
3. Collect candy (single = 1, bucket = 10; every 100 candies is a 1-UP).
4. Reach the goal gate to clear the stage (time bonus, next stage). Fall off or run out of time and you lose a life.
5. Clear the whole set (Beginner, then Advanced, then Expert) without losing your last life.

## Rules that stay faithful to the original

- Physics lives in the *stage's* frame: the stage tilts, gravity is rotated into it, the ball is a sliding/rolling
  sphere with restitution and friction against triangle collision. No rigid-body engine, no spin dynamics.
- The tilt follows the input with a slight lag. Controls are relative to the camera heading.
- The chase camera sits behind the ball and swings toward its direction of travel. Fixed 60 Hz simulation.
- 60 s per stage, 4 lives at the start, 100 candies = extra life, "Fall Out" and "Time Over" both cost a life.
- Sets of ten stages: **Beginner**, **Advanced**, **Expert** (a Master set is a possible later addition).

## Stages

Thirty stages in three sets of ten (each set ramps from a gentle first stage to a finale; every stage is one Blender-authored GLB).

- **Beginner, Pumpkin Patch (golden hour):** 1 Welcome to the Patch, 2 Zig-Zag Boardwalk, 3 Pumpkin Bumpers, 4 Rolling Hills,
  5 Corn Conveyor, 6 Scarecrow Spinner, 7 Windmill Sweep, 8 The Big Jump, 9 Sliding Planks, 10 Pumpkin Spiral.
- **Advanced, Moonlit Graveyard (blue dusk):** 1 Lantern Lane, 2 Crypt Crawl, 3 Bone Bridge, 4 Coffin Conveyors, 5 Ghost Wheels,
  6 Bat Swings, 7 Wormhole Mausoleum, 8 Grand Leap, 9 Sliding Sarcophagi, 10 Spiral of Souls.
- **Expert, Witch's Workshop (deep midnight):** 1 Brew Walk, 2 Gear Grinder, 3 Potion Slide, 4 Book Bridge, 5 Cauldron Conveyors,
  6 Crystal Maze, 7 Lightning Rods, 8 Broomstick Run, 9 The Long Fall, 10 Witch's Gate.

Hazards introduced along the way: conveyors (forward, sideways, reverse), rotating wheels, sweeper bars (single, cross), ferry decks,
tilting planks, bumpers, launch ramps and jumps, wormholes. Paths narrow from 4.2 m (Beginner) to 2.0 m (Expert) and rails thin out.

## World & look

**Setting:** a Halloween harvest world floating in a twilight sky: an enormous orange moon, drifting islands,
cornfields, pumpkin patches, hay bales, scarecrows, windmills, lantern-lit boardwalks, crooked fences, gravestones,
candles, cobwebs, crows and bats, spooky but cute (think Hotel Transylvania, not horror).

**The three sets are three moods of one night:**
- **Beginner: Pumpkin Patch.** Late golden hour. Warm amber sky, long soft shadows, ripe pumpkins, cornstalks,
  hay bales. Friendly and bright.
- **Advanced: Moonlit Graveyard.** Blue-violet dusk into night. Gravestones, iron fences, lanterns, fog,
  bats, a full moon behind the stages.
- **Expert: Witch's Workshop.** Deep midnight. Bubbling green cauldrons, purple lightning, glowing runes,
  floating candles, toxic-green and magenta light against black-violet stone.

**The hero:** a golden hamster in a glass ball, with a glowing rim. The rest of the roster (a red panda, a
hedgehog, a raccoon) come from the same low-poly catalog and differ only in ball tint.

**Landmarks a player remembers:** the huge harvest moon; the jack-o'-lantern goal gate with a cobweb ribbon that
tears when you break through; the glowing candy; the glass ball's bright rim.

## Art direction

**Comic book meets next-gen console.** Hand-inked comic-book art rendered with modern shaders (think a
Spider-Verse or Borderlands finish on a Pixar-quality lighting model), not voxels and not flat vector art.

- **Line work:** confident black ink outlines on silhouettes and creases, slightly heavier on the hero and the
  gameplay-critical shapes.
- **Shading:** 2-3 crisp tonal bands per surface with hue-shifted shadows (violet in warm light, teal in cool
  light); a **halftone dot** pattern in the darkest band and in fog; hard specular glints and a moonlit rim.
- **Colour:** saturated complementary palette. Pumpkin orange + candy pink + toxic lime against deep violet and
  midnight blue. Every stage has one dominant hue and one accent; the path is always the lightest, warmest thing.
- **Light:** one strong key (setting sun or moon) with high-resolution shadows, soft ambient occlusion, warm
  emissive lanterns and candles with bloom, volumetric-looking god rays and glow, atmospheric fog in the
  distance. Emissive shapes (candy, goal, lanterns, runes) are the brightest pixels in the frame.
- **Materials:** chunky low-poly geometry with beveled edges catching the light; painterly procedural texture
  (brush noise, wood grain, stone, hay) so nothing reads as a flat colour; polished glass for the ball with
  refraction, fresnel rim and streak reflections.
- **Motion and feedback:** comic sound-effect lettering that pops at impacts ("BONK!", "POING!", "WHOOSH!"),
  speed lines at high speed, candy sparkles, dust puffs, confetti at the goal, squash and stretch on the ball.
- **UI:** chunky rounded comic lettering (Lilita One), thick ink outlines, sticker-like panels, pumpkin-orange
  and violet, big readable numbers.
- **Readability rule:** the walkable surface is always the warmest, lightest value in the frame; hazards and
  the void are darker and cooler.

## First screen

The game opens on **Pick your roller** (static HTML the game puts on the page as it boots, `tools/pick-screen/`): four rendered portraits (Biscuit the hamster, Maple the red panda, Pip the hedgehog, Bandit the
raccoon). It replaces the engine's start screen: there is no engine Play button. **A click or tap on a card only selects that roller and shows a short, funny line about it** (the point:
people click through and read while the game loads in the background); **the LET'S ROLL button (Enter / Space / gamepad A) is the play button** and starts the game as soon as it is ready. The
player lands in the main menu with the stage already rolling and their animal in the ball. The saved animal is selected on a return visit. Illustrated portraits can replace the renders (drop 3:4
WebP files into `tools/pick-screen/portraits/` and run `node tools/pick-screen/build.mjs`); the lines live in `tor/roster.ts`.

## Controls

- **Tilt:** left stick / WASD / arrow keys / mouse / touch stick. Analog on gamepad and touch. Keys build up gently
  (about 0.65 s to full tilt, finer near zero; a tap is a nudge) and the feel is a setting: Gentle (default), Normal or
  Quick, under CONTROLS in the main menu. **Mouse tilt** is opt-in (M in a stage, or CONTROLS): the mouse is captured
  (the OS cursor is hidden) and moves a virtual pointer that ALWAYS starts a stage in the middle (neutral), whatever the real
  cursor was doing; a ring around the middle of the screen with a dot shows the tilt. Click re-centres, Esc or losing the
  capture pauses, and the menus give the real cursor back. Mouse speed is a setting too.
- **Camera:** right stick / Q and E / drag on the right half of the screen (the camera also auto-follows and lifts
  a little while the stage pitches forward).
- **Pause:** Esc / P / Start. **Retry stage:** R (costs a life, like falling).
- Phone: floating stick anywhere on the left half of the screen; works in portrait and landscape.

## Win / lose

- **Win a stage:** roll the ball through the goal gate. Bonus points for time left and candies.
- **Lose a life:** fall below the stage (Fall Out) or let the timer hit zero (Time Over).
- **Game over:** no lives left. **Set clear:** finish stage 10 of a set.
