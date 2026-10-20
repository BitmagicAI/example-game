# Trick or Roll

*Tilt the world, not the ball.* An example game built on [AItopia](https://github.com/BitmagicAI/AItopia),
the open-source Bitmagic engine, and hosted on GitHub Pages. Guide a hamster (or a red panda, a hedgehog or a
raccoon) in a glass ball across a floating Halloween harvest world: plank walkways, spinning scarecrow discs,
jack-o'-lantern bumpers, conveyor belts and launch ramps. Collect the candy, roll through the glowing goal before
the 60-second timer runs out, and don't fall off the world. Three courses of ten stages each.

This repository holds only the game. The engine is not copied in, and no Bitmagic tool or service is needed to
run, build or host it.

## What is here

| File | What it is |
|---|---|
| `Game.ts` | The `Game` class the engine constructs: the sky and the ambient light, then everything else handed to `TrickOrRoll` |
| `tor/` | The game: `TrickOrRoll.ts` (the flow from menu to stage to result), the stage, ball, camera, input, HUD, menus, items, effects and sound |
| `sim/` | The ball physics: a fixed 60 Hz simulation in the tilting stage's frame, against the stage's triangles. No rigid-body engine |
| `assets/` | The game's own files: the 30 stages, the four animals, the music, the skies, the achievement icons and the cover |
| `tools/pick-screen/` | The "Pick your roller" first screen and the script that builds it into `tor/PickScreenMarkup.ts` ([its README](tools/pick-screen/README.md)) |
| `world.json`, `game.json` | The stages, animals, music and sky as assets (named `game-asset:<path>`, a file in `assets/`), the lighting, the achievements, and the game's settings |
| `GAME-DESIGN.md` | The design: rules, controls, courses, the look |
| `package.json`, `tsconfig.json` | The engine as an npm package, and the TypeScript setup it provides |

The game uses little of the engine's gameplay layer: there is no voxel world and no player controller. It runs on the
engine's renderer, loading, lighting, sky, HUD layer, audio unlock, start flow and achievements, and brings its own
simulation, camera and input. Everything the folder does not hold comes from the engine's baseline game in the
package.

## Run it

You need Node 24.

```bash
npm install
npx aitopia dev          # play it on http://localhost:3001/, reloading as you edit
npx aitopia check        # type-check it the way your editor sees it
```

The engine is the npm package `@bitmagicai/aitopia`, and its own files (fonts, the KTX2 transcoder, the runtime
modules) are `@bitmagicai/engine-assets`, installed under the name the engine looks for, `@bitmagic/engine-assets`.
While both are in testing they live on GitHub Packages, so `.npmrc` points the `@bitmagicai` scope there, and
installing needs a GitHub token with `read:packages` in your user `~/.npmrc`
(`//npm.pkg.github.com/:_authToken=<token>`). Once they are public on npm as `@bitmagic/aitopia` and
`@bitmagic/engine-assets`, `.npmrc` goes away.

Useful URL parameters while you work: `?select=0` skips the pick screen, `?stage=b03` opens one stage straight
away, `?renderer=webgl` or `?renderer=webgpu` picks the renderer.

## Build and host it

```bash
npx aitopia build site
```

`site/` is a static site: `index.html`, the engine's files and a copy of `assets/` beside it. It talks to no
other host, so any static host serves it, GitHub Pages included. `.github/workflows/pages.yml` does the same on GitHub and deploys the result to
<https://bitmagicai.github.io/example-game/> on every push to `main`.

## The game's own files

Everything the game loads besides its code is in `assets/` (34 MB): `world.json` names each file as
`game-asset:<path>`, such as `game-asset:stages/b01.glb` for `assets/stages/b01.glb`. The engine loads them
from beside the page, `npx aitopia dev` serves them there, and `npx aitopia build` copies the folder into the
site, stopping if `world.json` names a file the folder does not hold. Code that fetches a file itself resolves
the URL first with `resolveGameAssetUrl` (`engine/runtime/hosting.js`), as `tor/TrickOrRoll.ts` does for the
skies in `tor/worlds.ts`.

The models are stored as plain `.glb` files, already compressed inside (meshopt). GitHub Pages gzips them on the
way, which brings the 30 stages and four animals to about 15 MB on the wire.
