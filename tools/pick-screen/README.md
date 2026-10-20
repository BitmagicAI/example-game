# Pick your roller: the first screen (and the game's Play button)

The first thing a visitor sees: four portraits with a name each, a short funny line about the selected one, a progress bar and a big LET'S ROLL button.
It **replaces the engine's start screen: there is no engine Play button, the ROLL button is the play action.** A card only SELECTS a roller (it hops, and its line pops into
the description panel), so people click through and read while the game loads; ROLL (or Enter / Space / gamepad A) starts the game by calling the engine's own start function,
`engine.startGame()`, the function the engine's Play button calls. When the game is loaded ROLL starts it at once (inside the press, so fullscreen and audio unlock get their user
gesture); ROLL pressed earlier locks the choice ("GET READY") and the game starts by itself the moment it is ready. The player lands in the main menu with the stage already rolling
behind it and the chosen animal already in the ball.

```
node tools/pick-screen/build.mjs            # (re)build tor/PickScreenMarkup.ts; idempotent
node tools/pick-screen/build.mjs --check    # exit 1 when tor/PickScreenMarkup.ts is not what the tool would write
```

**Run `build.mjs` after a portrait, roster or overlay change, and after changing the URL of the menu stage or the first stage in `world.json`** (those two URLs are baked in). The game
logs a console warning (`[CharacterSelect] the pick screen is out of date ...`) when the baked URLs differ from `world.json`.

## How it gets on the page

The engine's page holds nothing of the game's, so the game puts the screen there itself: `CharacterSelectFlow.install()` (`tor/CharacterSelect.ts`, called from the `Game`
constructor) inserts the styles and the font into `<head>` and the markup and scripts into `<body>`. The screen's own script runs as it is inserted, publishes `window.__torRS`
(the contract with `CharacterSelect.ts`) and from then on needs nothing of the engine. A page that already carries the screen (`#tor-font-style`) is left as it is.

## The descriptions

`tor/roster.ts` holds each roller's `name`, glass `tint` and `blurb`: the short, funny line shown under the cards (and under the animal in the in-game CHARACTER menu).
Keep them to about 60 characters. Example: *Biscuit: Runs on seeds and pure vibes. Brakes: optional.* Change the text, run `build.mjs`.

## Files

| | |
|---|---|
| `overlay.src.html` | the screen: CSS, markup and one inline classic script (no dependencies). Edit THIS, never `tor/PickScreenMarkup.ts` |
| `build.mjs` | builds the screen from the source + `tor/roster.ts` + `portraits/` + `fonts/` + the asset URLs in `world.json` into `tor/PickScreenMarkup.ts` |
| `portraits/<id>.webp` | 420x560 WebP per animal, ~17 KB each, inlined as base64 |
| `fonts/lilita-one.woff2` | the game's font, Lilita One (latin subset, 10 KB, SIL Open Font License 1.1), inlined; the menus and the HUD use it too |
| `../../tor/roster.ts` | who is on the screen (id, name, blurb, glass tint) and the stage names the boot flow cares about; also used by `Menus.ts` |
| `../../tor/CharacterSelect.ts` | the game side: puts the screen on the page, applies the pick, waits for the engine to finish loading, calls `engine.startGame()` |

## How it works

- **Inline**: markup, CSS, portraits and font are one string; the backdrop animates with transforms only, so it keeps moving while the main thread is busy building the stage.
- **What is downloaded when**: the screen fetches the menu stage (b06) when the engine reports progress, and once the game is ready (the player is looking at the cards) the first
  stage of the first course (b01) at low priority. Both go to the game through `window.__torPre[url]` (`StageView.stageBytes`), so each is ONE download. The game does the rest
  itself: the sky at load, the animal the moment the stage's
  bytes are in (`whenStageBytes` -> `TrickOrRoll.warmAnimal` in `Game.load`; the selected one, also while you browse: `whenPicked` previews it), the first song once the animal has
  landed (`TrickOrRoll.warmMusic`). **Do not prefetch what the game loads through its own loaders** (sky, animals): a second request for a file that is still in flight downloads it
  a second time.
- **Progress** = half the bytes of the prefetched stage (decoded bytes over the file's own length, read from the GLB header: the stages are served `Content-Encoding: br`, so
  `Content-Length` is the smaller wire size and must not be the total), half the engine's own phase progress (`window.__bmBoot.set`, which the screen wraps); never goes backwards.
- **Select vs roll**: a card, the arrows / A D and the d-pad only SELECT. The mouse hovering over a card does NOT select (its way to the ROLL button would cross other cards); hover only
  lifts the card. ROLL (the button, Enter / Space, gamepad A / Start) confirms. The saved animal is selected when the screen opens; the pick is saved (`trickorroll:v1`.character)
  when the game starts.
- **Preview**: the ball's animal and glass tint follow the pick once it has rested for 0.45 s (`whenPicked` in `CharacterSelect.ts`); ROLL applies the last pick at once.
- **Safety nets**: the screen steps aside for the engine's own start screen (and its Play button) if the engine finished loading but the game never attached (3 s); `?select=0`,
  `?stage=` and desktop `?autostart=1` take it off the page before it paints.

## URL parameters

| | |
|---|---|
| `?select=0` | no screen: the engine's own start screen with its Play button |
| `?select=1` | keep the screen and press nothing automatically (for a test that presses ROLL itself) |
| `?pick=<id>` | select that animal and press ROLL the moment the game is ready |
| (none, under automation) | `navigator.webdriver` (Playwright and the like): ROLL is pressed 3 s after the game is ready |
| `?stage=<name>` | drops the screen (practice / test URLs) |

## Pitfalls

- The pulsing ROLL button is never "stable" for Playwright: click it with `{ force: true }`.
- On phones, the fullscreen request must happen inside the press: ROLL after loading calls `engine.startGame()` synchronously in the click handler; ROLL while loading requests
  fullscreen at the press (the page does it) and the game calls `engine.startGame()` later, outside a gesture (the engine then continues without asking again).
- Edit `overlay.src.html` with anchors that occur once (`.tor-blurb {` also matches the media query), and let `build.mjs`'s brace check catch the rest.
