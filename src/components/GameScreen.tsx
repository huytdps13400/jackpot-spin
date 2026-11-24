import { useEffect, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSpinEngine } from '../engine/useSpinEngine';
import { initSounds, releaseSounds } from '../feedback/feedback';
import { useGameStore } from '../game/store';
import { GoldDust } from '../gpu/GoldDust';
import { computeLayout } from '../theme/layout';
import { Hud } from './Hud';
import { Stage } from './Stage';

export function GameScreen() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const layout = useMemo(
    () => computeLayout(width, height, { top: insets.top, bottom: insets.bottom }),
    [width, height, insets.top, insets.bottom],
  );
  const engine = useSpinEngine(layout.slot);

  const boardComplete = useGameStore((s) => s.won.length === 100);
  const soundOn = useGameStore((s) => s.soundOn);
  const hapticsOn = useGameStore((s) => s.hapticsOn);
  const skin = useGameStore((s) => s.skin);

  useEffect(() => {
    initSounds();
    return releaseSounds;
  }, []);

  return (
    <>
      <Stage
        layout={layout}
        sv={engine.sv}
        soundOn={soundOn}
        hapticsOn={hapticsOn}
        boardComplete={boardComplete}
        skin={skin}
      />
      <GoldDust layout={layout} sv={engine.sv} />
      <Hud layout={layout} engine={engine} />
    </>
  );
}
