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
| `package.json`, `tsconfig.json` | The engine as an npm package, and the TypeScript setup it provides |

Everything else a game needs (loading, the player, the camera, the per-frame loop) comes from the
engine's baseline game in the package: this folder holds only what Gem Island changes. To change
another baseline file, copy it from `node_modules/@bitmagicai/aitopia/game/src/baseline/` here.

## Run it

You need Node 24.

```bash
npm install
npx aitopia dev          # play it on http://localhost:3001/, reloading as you edit
npx aitopia check        # type-check it the way your editor sees it
```

The engine is the npm package `@bitmagicai/aitopia`, and its own files (the character, the
animation clips, the fonts and the template content `world.json` names by `engine-asset:` URL)
are `@bitmagicai/engine-assets`, installed under the name the engine looks for,
`@bitmagic/engine-assets`. The runtime modules (three.js, Rapier, …) come from their own npm
packages. While both are in testing they live on GitHub Packages, so `.npmrc` points the
`@bitmagicai` scope there, and installing needs a GitHub token with `read:packages` in your user
`~/.npmrc` (`//npm.pkg.github.com/:_authToken=<token>`). Once they are public on npm as
`@bitmagic/aitopia` and `@bitmagic/engine-assets`, `.npmrc` goes away.

## Build and host it

```bash
npx aitopia build site
```

`site/` is a static site: `index.html` plus the engine's files beside it. It talks to no other
host, so any static host serves it, GitHub Pages included.

`.github/workflows/pages.yml` does the same on GitHub and deploys the result to
<https://bitmagicai.github.io/example-game/>. It runs by hand for now (Actions → "Deploy to GitHub
Pages" → Run workflow): the repository is private, and GitHub Pages serves a free organization's
public repositories only.
