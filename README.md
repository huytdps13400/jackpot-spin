# Jackpot Spin

A 10×10 "claim the board" slot game for iOS and Android, built with **React Native, Skia, Reanimated 4** and **WebGPU (TypeGPU)**.

Tap **SPIN**. The prize wheel blurs, brakes on a custom easing curve and lands on a random number 1–100. The number is thrown onto its cell on the board, the vault lid flips open and the treasure inside rises under a spotlight. Claim all 100 cells to hit the jackpot.

<p align="center"><img src="docs/demo.gif" width="300" alt="A spin: the wheel blurs and brakes, the house lights go down, the vault opens under a spotlight and the treasure rises. Then the last free cell: JACKPOT sign, confetti and lights-out on the full board."/></p>

**Full demo with sound:** [`docs/demo.mp4`](docs/demo.mp4) (Release build, iPhone 17 Pro simulator, 57 s, 60 fps). It shows two spins, the QA fill (99 cells at once), the jackpot and a new board. The green line under the logo is the in-app perf overlay: UI fps · JS fps · long frames · scene renders.

---

## Run

```bash
npm install
npx expo run:ios          # or: npx expo run:android  (dev build; Expo Go cannot load WebGPU)
npm test                  # reel physics + treasure deal unit tests
npm run typecheck && npm run lint
```

- **Long-press the logo**: toggles the perf overlay.
- **Long-press ROUND**: claims 99 cells and rigs the next spin onto the last one, to see the jackpot in one spin.
- **Tap the logo**: switches skin (Neon Royale / Royal Treasure).

---

## Architecture

```
App ─ GameScreen
       ├─ Stage     one full-screen Skia <Canvas>: the whole game scene
       ├─ GoldDust  one WebGPU <Canvas>: GPU particles + HDR bloom
       └─ Hud       invisible native hit targets + accessibility tree

useSpinEngine (UI thread)           useGameStore (Zustand + AsyncStorage)
  frame loop, wheel state machine,    claimed cells, history, round, settings
  gestures, reveal timeline           written once per spin
        └── shared values ──► sprite systems ──► Skia Atlas draws
```

| Area | Where | What it does |
|---|---|---|
| Game loop | `src/engine/useSpinEngine.ts` | One `useFrameCallback` worklet: wheel state machine, reveal timeline, camera, haptic/sound cues |
| Wheel physics | `src/game/reelMath.ts` (tested) | Cruise + crawl easing joined with matching velocity; result decided at spin start, no fake near-miss |
| Sprite engine | `src/engine/sprites/` | Skia `Atlas` batches fed by flat arrays mutated in place; 100 cells = 5 draws |
| Wheel | `stage/ArcReel.tsx` | Rotational motion blur (ghost copies along the arc), depth of field on the flanks |
| Grid reaction | `stage/Tiles.tsx`, `TreasureReveal.tsx` | Lid flip, ripple, treasure rise, sparks, coins, line chase |
| Room & lights | `stage/Backdrop.tsx` | SkSL shader: haze, moving stage lights, lights-out spotlight on the reward |
| Text | `stage/GlyphShine.tsx`, `ResultPlate.tsx`, `Banner.tsx` | Glyph-masked shine, staggered digit slam, banner write-on |
| GPU particles | `src/gpu/` | 16k-particle compute sim + HDR bloom in WebGPU/TypeGPU |
| State | `src/game/store.ts` | Zustand + persist; the UI thread mirrors what it needs at lock time |

## Skia + Reanimated on the UI thread

- **All motion is driven on the UI thread.** The engine writes shared values in one frame callback; every Skia prop (transforms, opacity, shader uniforms, Atlas buffers) is a derived value of them. Nothing animates through React state.
- **React renders 2× per spin** (spin start, result commit). The Skia scene component does not re-render during a spin. The only JS crossings are fire-and-forget `scheduleOnRN` calls for haptics and sound.
- **Seamless reel → grid.** The wheel lock, the number's flight and the cell's reaction all read one reveal clock, so they cannot drift apart, and the result is committed to the store on the impact frame.
- **Frame-rate independent.** `dt` is clamped, smoothing is exponential in `dt`, timelines are in ms: 60 Hz and 120 Hz devices animate the same.

## Performance

- **Batching:** 100 cells, particles, wheel numbers and glints are Skia Atlas sprites. No per-cell React nodes or shared values.
- **No allocation per frame:** fixed sprite/particle pools mutated in place.
- **Static art baked once:** board frame, panels and the odometer strip are rasterised into textures (`stage/Baked.tsx`). A native profile showed their gold lettering being re-rasterised on the CPU every frame. This was the biggest source of long frames.
- **Bounded offscreen layers:** blur layers are clipped to the strips they cover; the text-shine layer is skipped when idle; dim + stage lights are one shader pass.
- **Warm-up:** the jackpot sign draws once invisibly at launch, so its first real frame is not a shader compile.
- **No layout thrashing:** layout is computed once from the window size.

**Measured** (Release build, iPhone 17 Pro simulator, perf overlay):

| | Result |
|---|---|
| UI / JS thread | **60 / 60 fps** |
| Idle (15 s) | **0** long frames |
| One spin + treasure reveal | **2** long frames (was 22 before the optimisation pass) |
| Scene re-renders per spin | **0** |

A simulator is not a device; treat these as a floor check.

## Haptics & sound (bonus)

`expo-haptics`: detent ticks escalate as the wheel slows (selection → light → medium), rigid on lock, success on a claim, heavy + success on the jackpot. Sounds and music are synthesised by our own scripts (`scripts/generate-sounds.py`, `scripts/make-music.py`). Both toggle from the control bar.

---

## Assets

- **Blender (Cycles, headless scripts):** 3D vault keys and flip frames, chest, coins, light-effect flipbooks, coin rigid-body sims (`scripts/blender/`).
- **Image model + OKLCH re-grade:** painted chrome, treasure symbols, jackpot sign (`scripts/art/`). Original designs; no existing game's art, names or symbols.
- **Skia / WebGPU at runtime:** everything that moves.

## How AI was used

Built with **Claude Code** as a pair programmer, and with **[Native Cook](https://nativecook.dev/)**, a catalog of React Native UI blocks, for proven interaction patterns.

- **Native Cook blocks.** Several interactions start from Native Cook blocks, re-implemented on this Skia/Atlas engine: the rolling-number odometer, coins collected into a counter, the glow-border SPIN button, the depth (press-in) button, sprite orbs, confetti, and the shimmer / staggered text animation.
- **Claude Code.** Drafting the sprite engine, shaders and Blender scripts; deriving the easing maths (backed by Jest tests); checking the installed library versions' APIs; profiling (Instruments) and fixing the long frames.
- **Me.** Design direction, every visual and feel decision, and review on the simulator frame by frame. Performance numbers come from the in-app overlay, not assumptions.
