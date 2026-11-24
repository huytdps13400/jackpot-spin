import { memo, useEffect, useMemo, useState } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated';
import { Canvas, useCanvasRef, type RNCanvasContext } from 'react-native-webgpu';

import { useCamera } from '../components/stage/camera';
import { ResultKindCode } from '../engine/timeline';
import type { SpinEngine } from '../engine/useSpinEngine';
import type { StageLayout } from '../theme/layout';
import { makeDustState, stepDirector, type DustState } from './dustDirector';
import {
  createDustGpu,
  createDustTargets,
  destroyDustGpu,
  destroyDustTargets,
  encodeClear,
  encodeFrame,
  type DustGpu,
  type DustTargets,
} from './dustGpu';

/**
 * GPU light layer ("gold dust") — WebGPU + TypeGPU, driven from the Reanimated UI thread.
 *
 * - **One particle system, 16,384 particles, all on the GPU.** 512 are ambient motes that join
 *   a celebration and fade out after it; the rest is a ring pool for bursts. A compute shader spawns and integrates them
 *   (drag, gravity / buoyancy, a divergence-free curl-noise flow, exact ballistics for firework
 *   shells, Bézier paths for the stream into the counter). Spawning is a uniform-buffer emitter
 *   list: the CPU never writes or reads particle data.
 * - **Analytic sprites, no textures.** Instanced quads; the fragment shader draws a capsule
 *   stretched along the velocity (white-hot core, tinted halo, tapered tail) or a 4-point star
 *   glint that twinkles. Colour over life: white → pale gold #FFE9B0 → gold #F7C948 → amber
 *   #FF9A3C (rose #FF7A9C / ice #E6EAFF / lavender ramps for fireworks and repeats); every particle
 *   fades in from zero over its first ~70–100 ms.
 * - **Real bloom.** Bursts accumulate in an HDR (rgba16float) core target, a dual-Kawase pyramid
 *   (4 down + 3 progressive up passes) blurs it, and one composite pass tone-maps core + bloom
 *   together (mostly hue-preserving, so dense cores stay gold-white, never a flat white plate) and
 *   writes premultiplied alpha onto the transparent canvas over the Skia scene. Motes are drawn
 *   straight onto the canvas.
 * - **Behaviours** follow the engine's reveal clock: while a burst lives, motes drift up the
 *   backdrop, swept sideways near the wheel by its velocity; a new cell gets a fine
 *   spark ring + gold dust + glitter at the hit-stop end, then a stream of motes pours along a
 *   curve into the counter (first arrival at CountStart, last at CollectEnd); a repeat gets a
 *   small lavender puff; the board jackpot launches firework shells from the board (gold / rose /
 *   ice rings) and ~3 s of glitter rain. Reduce Motion: no motes, tiny bursts only.
 * - **Camera-locked.** A second `useCamera` instance reproduces the Skia world camera (zoom, punch,
 *   shake, roll) and the vertex shader applies it, so dust stays glued to the cell it bursts from.
 * - **Idle at rest.** While a burst lives: one 1.2 KB uniform write, one compute dispatch, the
 *   HDR core pass, 7 small blur passes, the composite and the mote pass. Once the motes have faded
 *   (idle board, the spin itself, Reduce Motion): one clear, then no GPU work and no presents at
 *   all (battery; a Metal layer presenting non-stop also starves the simulator's screen capture).
 * - If WebGPU is unavailable or any shader / pipeline fails validation, it renders nothing (with a
 *   `[GoldDust]` warning in the Metro log) and the Skia effects carry the scene alone.
 *
 * QA (dev): `globalThis.__gpu.burst('new' | 'repeat' | 'complete', cellIndex)` replays the same
 * beats without spinning; `globalThis.__goldDust` is the init status.
 */

type Props = { layout: StageLayout; sv: SpinEngine['sv'] };
type Ready = { gpu: DustGpu; context: RNCanvasContext };
type QaRequest = { seq: number; kind: number; cell: number };
type GpuQa = { burst: (kind: 'new' | 'repeat' | 'complete', cellIndex: number) => void };
type World = SharedValue<unknown>;

const warn = (message: string) => console.warn(message);

/** Old GPU objects are released only after the UI thread has moved on from them. */
const RELEASE_DELAY_MS = 500;

export const GoldDust = memo(function GoldDust({ layout, sv }: Props) {
  const ref = useCanvasRef();
  const [ready, setReady] = useState<Ready | null>(null);
  // the same camera director the Skia world uses (pure function of the engine state)
  const cam = useCamera(layout, sv);
  const qa = useSharedValue<QaRequest>({ seq: 0, kind: 0, cell: 0 });
  const coreScale = Math.min(PixelRatio.get(), 2);

  useEffect(() => {
    let cancelled = false;
    // Exposes the init outcome for QA (`globalThis.__goldDust` → 'ready' | reason it fell back).
    const status = (v: string) => {
      if (__DEV__) (globalThis as { __goldDust?: string }).__goldDust = v;
    };
    (async () => {
      try {
        status('init');
        if (typeof navigator === 'undefined' || !navigator.gpu) return status('no navigator.gpu');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter || cancelled) return status('no adapter');
        const device = await adapter.requestDevice();
        device.addEventListener('uncapturederror', (e) => {
          const err = (e as GPUUncapturedErrorEvent).error;
          warn(`[GoldDust] uncaptured GPU error: ${err?.message ?? String(err)}`);
        });
        const context = ref.current?.getContext('webgpu');
        if (!context || cancelled) return status('no context');
        const format = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format, alphaMode: 'premultiplied' });
        const gpu = await createDustGpu(device, format, warn);
        if (!gpu) return status('pipeline error (see [GoldDust] warnings)');
        if (cancelled) return;
        status('ready');
        setReady({ gpu, context });
      } catch (e) {
        status(`failed: ${String(e)}`);
        warn(`[GoldDust] WebGPU unavailable, using Skia effects only: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ref]);

  const targets = useMemo(
    () => (ready ? createDustTargets(ready.gpu, layout.width, layout.height, coreScale, warn) : null),
    [ready, layout.width, layout.height, coreScale],
  );
  useEffect(
    () => () => {
      if (targets) setTimeout(() => destroyDustTargets(targets), RELEASE_DELAY_MS);
    },
    [targets],
  );
  useEffect(
    () => () => {
      if (ready) setTimeout(() => destroyDustGpu(ready.gpu), RELEASE_DELAY_MS);
    },
    [ready],
  );

  // Dev QA hook: fire the same effects without spinning, e.g. `__gpu.burst('complete', 44)`.
  useEffect(() => {
    if (!__DEV__) return;
    const g = globalThis as { __gpu?: GpuQa };
    let seq = 0;
    const api: GpuQa = {
      burst: (kind, cellIndex) => {
        seq += 1;
        const code =
          kind === 'repeat' ? ResultKindCode.Repeat : kind === 'complete' ? ResultKindCode.Complete : ResultKindCode.New;
        const cell = Math.max(0, Math.min(99, Math.round(Number(cellIndex) || 0)));
        qa.set({ seq, kind: code, cell });
      },
    };
    g.__gpu = api;
    return () => {
      if (g.__gpu === api) delete g.__gpu;
    };
  }, [qa]);

  return (
    <>
      <Canvas ref={ref} style={StyleSheet.absoluteFill} pointerEvents="none" />
      {ready && targets ? (
        <DustLoop
          gpu={ready.gpu}
          context={ready.context}
          targets={targets}
          layout={layout}
          sv={sv}
          qa={qa}
          world={cam.world as World}
        />
      ) : null}
    </>
  );
});

type LoopProps = Ready & {
  targets: DustTargets;
  layout: StageLayout;
  sv: SpinEngine['sv'];
  qa: SharedValue<QaRequest>;
  world: World;
};

function DustLoop({ gpu, context, targets, layout, sv, qa, world }: LoopProps) {
  const state = useSharedValue<DustState | null>(null);

  useFrameCallback(() => {
    'worklet';
    let st = state.value;
    if (st === null) {
      st = makeDustState();
      state.value = st;
    }

    // camera: [T(pivot + shake), R(roll), S(zoom), T(-pivot)] as the Skia world applies it;
    // falls back to identity if its shape ever changes
    let camX = layout.width / 2;
    let camY = layout.height / 2;
    let rot = 0;
    let zoom = 1;
    let pivX = camX;
    let pivY = camY;
    const w = world.value as Record<string, number>[] | null | undefined;
    if (w && w.length >= 6) {
      const a = w[0].translateX;
      const b = w[1].translateY;
      const c = w[2].rotate;
      const s = w[3].scale;
      const e = w[4].translateX;
      const f = w[5].translateY;
      if (
        typeof a === 'number' &&
        typeof b === 'number' &&
        typeof c === 'number' &&
        typeof s === 'number' &&
        typeof e === 'number' &&
        typeof f === 'number'
      ) {
        camX = a;
        camY = b;
        rot = c;
        zoom = s;
        pivX = -e;
        pivY = -f;
      }
    }

    const q = qa.value;
    stepDirector(
      st,
      layout,
      sv.clock.value,
      sv.reveal.value,
      sv.kind.value,
      sv.winIdx.value,
      sv.tension.value,
      sv.vel.value,
      sv.reduceMotion.value,
      q.seq,
      q.kind,
      q.cell,
      camX,
      camY,
      rot,
      zoom,
      pivX,
      pivY,
      sv.winIdx.value >= 0 ? sv.treasure.value[sv.winIdx.value] : -1,
    );

    if (!st.bursts && !st.motes) {
      if (st.armed) {
        // one last pass to clear the canvas, then go fully idle
        encodeClear(gpu, st.scratch, context.getCurrentTexture().createView());
        context.present();
        st.armed = false;
      }
      return;
    }
    encodeFrame(gpu, targets, st.scratch, st.f, context.getCurrentTexture().createView(), st.bursts, st.motes, st.hw);
    context.present();
    st.armed = true;
  });

  return null;
}
