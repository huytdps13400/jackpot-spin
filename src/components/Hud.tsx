import { memo, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { scheduleOnUI } from 'react-native-worklets';

import type { SpinEngine } from '../engine/useSpinEngine';
import { feedback } from '../feedback/feedback';
import { useGameStore } from '../game/store';
import { boardTreasures, TREASURES } from '../game/treasure';
import type { Circle, Rect, StageLayout } from '../theme/layout';
import { lux } from '../theme/tokens';
import { renderStats } from './renderStats';
import { LogoShimmer } from './stage/LogoShimmer';
import { Readouts } from './stage/Readouts';

type Props = { layout: StageLayout; engine: SpinEngine };

const abs = (r: Rect) => ({ position: 'absolute' as const, left: r.x, top: r.y, width: r.width, height: r.height });
const absCircle = (c: Circle, grow = 0) => ({
  position: 'absolute' as const,
  left: c.cx - c.r - grow,
  top: c.cy - c.r - grow,
  width: (c.r + grow) * 2,
  height: (c.r + grow) * 2,
  borderRadius: c.r + grow,
});

/**
 * Native layer above the canvas. Everything you see is drawn by Skia; this layer holds the
 * invisible hit targets placed exactly over the drawn controls, the pill read-outs (a small
 * Skia canvas of their own), and the accessibility tree — VoiceOver reads the
 * board state, the last result and every control even though none of them are native views.
 */
export const Hud = memo(function Hud({ layout, engine }: Props) {
  const round = useGameStore((s) => s.round);
  const wonCount = useGameStore((s) => s.won.length);
  const history = useGameStore((s) => s.history);
  const lastKind = useGameStore((s) => s.lastKind);
  const uiPhase = useGameStore((s) => s.uiPhase);
  const soundOn = useGameStore((s) => s.soundOn);
  const hapticsOn = useGameStore((s) => s.hapticsOn);
  const perfHud = useGameStore((s) => s.perfHud);
  const bestStreak = useGameStore((s) => s.bestStreak);
  const boardSeed = useGameStore((s) => s.boardSeed);
  const treasures = useMemo(() => boardTreasures(boardSeed), [boardSeed]);
  const complete = wonCount === 100;
  const last = history.length ? history[history.length - 1] : null;

  const buttonLabel = uiPhase === 'spinning' ? 'Stop the wheel' : complete ? 'Start a new board' : 'Spin';
  const resultText =
    last === null
      ? 'No spins yet'
      : lastKind === 'complete'
        ? `Board complete! ${last} claimed the last cell`
        : lastKind === 'repeat'
          ? `${last}, already claimed`
          : `${last}, new cell claimed: ${TREASURES[treasures[last - 1]].name}`;

  // QA (dev builds only): rig the next spin onto a cell, e.g. to film a legendary reveal
  useEffect(() => {
    if (!__DEV__) return;
    (globalThis as { __qa?: unknown }).__qa = {
      forceNext: (n: number) => engine.forceNext(n - 1),
      slowmo: (k: number) => engine.setTimeScale(k),
      // wipe the persisted game (board, history, round, streaks) back to a fresh first launch
      reset: () => {
        void useGameStore.persist.clearStorage();
        useGameStore.setState({ ...useGameStore.getInitialState(), uiPhase: 'idle' });
      },
      cellsHolding: (id: string) =>
        treasures.flatMap((t, i) => (TREASURES[t].id === id ? [i + 1] : [])),
    };
  }, [engine, treasures]);

  const { pills } = layout;
  const pillText = (r: Rect) => ({ ...abs(r), paddingTop: 2 });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* light running around the logo's outline (pointer-transparent; the Pressable below takes taps) */}
      <LogoShimmer layout={layout} />
      {/* logo — long-press: perf overlay */}
      <Pressable
        style={abs({ ...layout.topBar, width: layout.topBar.width * 0.6 })}
        onPress={() => useGameStore.getState().cycleSkin()}
        onLongPress={() => useGameStore.getState().togglePerfHud()}
        delayLongPress={600}
        accessibilityRole="header"
        accessibilityLabel="Jackpot Spin"
        accessibilityHint="Tap to switch the theme. Long press to toggle the performance overlay"
      />

      {/* wheel: drag / flick / tap */}
      <GestureDetector gesture={engine.reelGesture}>
        <View
          style={abs(layout.reel)}
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Number wheel"
          accessibilityValue={last !== null ? { text: `Showing ${last}` } : undefined}
          accessibilityHint="Flick sideways to spin. Tap to stop."
          accessibilityActions={[{ name: 'activate' }]}
          onAccessibilityAction={() => engine.press()}
        />
      </GestureDetector>

      {/* board, plate, banner and counter are Skia — expose their state to assistive tech */}
      <View
        style={abs(layout.grid)}
        pointerEvents="none"
        accessible
        accessibilityLabel={`Board: ${wonCount} of 100 cells claimed`}
      />
      <View style={abs(layout.banner)} pointerEvents="none" accessible accessibilityLiveRegion="polite" accessibilityLabel={resultText} />
      <View
        style={abs(layout.panel)}
        pointerEvents="none"
        accessible
        accessibilityLabel={`Cells claimed: ${wonCount} of 100`}
      />

      {/* pill read-outs: Skia chrome lettering, with the hit targets / a11y views over it */}
      <Readouts layout={layout} round={round} last={last} best={bestStreak} />
      <Pressable
        style={[styles.pill, pillText(pills.round)]}
        onLongPress={() => {
          const won = new Set(useGameStore.getState().won);
          const free = Array.from({ length: 100 }, (_, i) => i + 1).filter((n) => !won.has(n));
          if (!free.length) return;
          // QA: claim 99 cells and rig the next spin onto the last one → board-complete path
          const pick = free[Math.floor(Math.random() * free.length)];
          useGameStore.getState().debugFillAllBut(pick);
          engine.forceNext(pick - 1);
        }}
        delayLongPress={900}
        accessibilityLabel={`Round ${round}`}
      >
      </Pressable>
      <View style={[styles.pill, pillText(pills.last)]} accessible accessibilityLabel={last !== null ? `Last result ${last}` : 'No result yet'} />
      <View style={[styles.pill, pillText(pills.best)]} accessible accessibilityLabel={`Best streak ${bestStreak} new cells in a row`} />

      {/* toggles */}
      <Pressable
        style={absCircle(layout.sound, 3)}
        onPressIn={() => engine.toggleDown('sound', true)}
        onPressOut={() => engine.toggleDown('sound', false)}
        onPress={() => useGameStore.getState().toggleSound()}
        accessibilityRole="switch"
        accessibilityLabel="Sound"
        accessibilityState={{ checked: soundOn }}
      />
      <Pressable
        style={absCircle(layout.haptics, 3)}
        onPressIn={() => engine.toggleDown('haptics', true)}
        onPressOut={() => engine.toggleDown('haptics', false)}
        onPress={() => {
          useGameStore.getState().toggleHaptics();
          feedback.press();
        }}
        accessibilityRole="switch"
        accessibilityLabel="Haptics"
        accessibilityState={{ checked: hapticsOn }}
      />

      {/* primary action */}
      <Pressable
        style={absCircle(layout.spin, 6)}
        onPressIn={() => {
          engine.pressIn();
          feedback.press();
        }}
        onPressOut={engine.pressOut}
        onPress={engine.press}
        accessibilityRole="button"
        accessibilityLabel={buttonLabel}
      />

      {perfHud ? <PerfHud engine={engine} top={layout.topBar.y + layout.topBar.height + 4} /> : null}
    </View>
  );
});

function PerfHud({ engine, top }: { engine: SpinEngine; top: number }) {
  const [stats, setStats] = useState({ ui: 0, js: 0, long: 0, renders: 0 });
  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = requestAnimationFrame(function loop() {
      frames += 1;
      raf = requestAnimationFrame(loop);
    });
    const id = setInterval(() => {
      const now = performance.now();
      setStats({
        ui: engine.sv.uiFps.value,
        js: (frames * 1000) / (now - last),
        long: engine.sv.dropped.value,
        renders: renderStats.stage,
      });
      frames = 0;
      last = now;
    }, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [engine]);
  const dropped = engine.sv.dropped;
  return (
    <Pressable
      style={[styles.perf, { top }]}
      onPress={() =>
        scheduleOnUI(() => {
          'worklet';
          dropped.value = 0;
        })
      }
      accessibilityLabel="Performance overlay. Tap to reset counters."
    >
      <Text style={styles.perfText}>
        UI {stats.ui.toFixed(0)} fps · JS {stats.js.toFixed(0)} fps · long frames {stats.long} · scene renders{' '}
        {stats.renders}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  perf: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(5,5,24,0.85)',
    borderWidth: 1,
    borderColor: lux.navy700,
  },
  perfText: { fontFamily: 'Inter-Medium', fontSize: 10.5, color: '#9BE7A8', fontVariant: ['tabular-nums'] },
});
