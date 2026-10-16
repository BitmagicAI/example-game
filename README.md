# Gem Island

A small example game built on [AItopia](https://github.com/BitmagicAI/AItopia), the open-source
Bitmagic engine, and hosted on GitHub Pages. Run around a little island and collect every gem
before the 90-second timer runs out.

This repository holds only the game. The engine is not copied in, and no Bitmagic tool or service
is needed to run, build or host it.

## What is here

| File | What it is |
|---|---|
| `Game.ts` | The rules: the gems, the gem counter and the countdown on the HUD, win and lose |
| `Gems.ts` | One gem: a spinning, bobbing crystal that the player collects by touching it |
| `WorldGenerator.ts` | The engine's baseline world generator with one change, marked "Gem Island": the island's shape |
| `world.json`, `game.json` | The world (terrain, objects, sky, start screen) and the game's settings |

Everything else a game needs (loading, the player, the camera, the per-frame loop) comes from the
engine's baseline game: this folder holds only what Gem Island changes. See "Your own game
repository" in AItopia's `game/README.md`.

## Run it

You need Node 24 and pnpm. Clone the engine next to this repository:

```bash
git clone https://github.com/BitmagicAI/AItopia.git
git clone https://github.com/BitmagicAI/example-game.git
cd AItopia/game
pnpm install
pnpm dev:game ../../example-game --engine-assets <dir>
```

Then open <http://localhost:3001/>. Edit the files in `example-game/`; the page reloads.

`--engine-assets` names a folder holding the engine's own files (the character, the animation
clips, fonts, runtime modules and the template content `world.json` names by `engine-asset:` URL).
Bitmagic does not publish that set yet; AItopia's `game/docs/hosting.md` says what it holds.

## Build and host it

```bash
pnpm build:game ../../example-game ../../gem-island-site --engine-assets <dir>
```

`gem-island-site/` is a static site: `index.html` plus the engine's files beside it. It talks to no
other host, so any static host serves it, GitHub Pages included.

`.github/workflows/pages.yml` does the same on GitHub and deploys the result to
<https://bitmagicai.github.io/example-game/>. It runs by hand for now (Actions → "Deploy to GitHub
Pages" → Run workflow), until the engine's files are published.
