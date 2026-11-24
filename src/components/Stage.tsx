import {
  Canvas,
  Group,
  Skia,
  useImage,
  usePictureAsTexture,
  useTypeface,
  type SkImage,
} from '@shopify/react-native-skia';
import { memo, useEffect, useMemo } from 'react';
import { PixelRatio, StyleSheet } from 'react-native';
import { useDerivedValue } from 'react-native-reanimated';

import type { SpinEngine } from '../engine/useSpinEngine';
import type { StageLayout } from '../theme/layout';
import { skins, sprites, treasureArt } from '../theme/art';
import type { SkinId } from '../theme/skin';
import { fonts, skinTone } from '../theme/tokens';
import { renderStats } from './renderStats';
import { ArcReel } from './stage/ArcReel';
import { TextShimmer } from './stage/TextShimmer';
import { Backdrop, StageLights } from './stage/Backdrop';
import { Banner } from './stage/Banner';
import { BoardChrome, PanelChrome, type ChromeImages } from './stage/Chrome';
import { ControlBar } from './stage/ControlBar';
import { Counter } from './stage/Counter';
import { FlyNumber } from './stage/FlyNumber';
import { JackpotBanner, Release, Spotlight } from './stage/Fx';
import { LootBeam } from './stage/LootBeam';
import { Particles } from './stage/Particles';
import { PLATE_CAP, ResultPlate } from './stage/ResultPlate';
import { useCamera } from './stage/camera';
import { CoinPhysics } from './stage/CoinPhysics';
import { capHeight } from './stage/gameText';
import { buildTextAtlas } from './stage/textAtlas';
import { buildBoardAtlas, buildFxAtlas, buildReelAtlas } from './stage/textures';
import { Tiles } from './stage/Tiles';
import { TreasureReveal } from './stage/TreasureReveal';

type Props = {
  layout: StageLayout;
  sv: SpinEngine['sv'];
  soundOn: boolean;
  hapticsOn: boolean;
  boardComplete: boolean;
  skin: SkinId;
};

const NO_SIZE = { width: 1, height: 1 };

/** Decoded images, or null until every one of them is. */
function allDecoded<T extends Record<string, SkImage | null>>(imgs: T) {
  return Object.values(imgs).every((v) => v !== null) ? (imgs as { [K in keyof T]: SkImage }) : null;
}

/**
 * Images every skin shares (3D keys, coins, treasures, light effects). Stable identity: the atlases
 * are keyed on this object, and rebuilding them re-rasterises three textures — it must happen once
 * at load, never on a re-render. A decoded image never changes, so "all decoded" flipping true is
 * the only event to track.
 */
function useSharedArt() {
  const imgs = {
    t0: useImage(treasureArt[0]),
    t1: useImage(treasureArt[1]),
    t2: useImage(treasureArt[2]),
    t3: useImage(treasureArt[3]),
    t4: useImage(treasureArt[4]),
    t5: useImage(treasureArt[5]),
    t6: useImage(treasureArt[6]),
    t7: useImage(treasureArt[7]),
    t8: useImage(treasureArt[8]),
    tileIdle: useImage(sprites.tileIdle),
    tileGold: useImage(sprites.tileGold),
    tileFlip: useImage(sprites.tileFlip),
    tileIdleNeon: useImage(sprites.tileIdleNeon),
    tileFlipNeon: useImage(sprites.tileFlipNeon),
    coinSpin: useImage(sprites.coinSpin),
    chestOpen: useImage(sprites.chestOpen),
    fxBurst: useImage(sprites.fxBurst),
    fxGlint: useImage(sprites.fxGlint),
    fxSpark: useImage(sprites.fxSpark),
    fxEmber: useImage(sprites.fxEmber),
    godrays: useImage(sprites.fxGodrays),
    fxPillar: useImage(sprites.fxPillar),
  };
  const all = Object.values(imgs).every((v) => v !== null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => allDecoded(imgs), [all]);
}

/**
 * The skin's painted chrome. Switching skin swaps these one by one as the new ones decode (Skia's
 * useImage keeps the old image until then), so this is keyed on the images themselves; rebuilding
 * it only re-records the cheap chrome Pictures, never the atlases.
 */
function useSkinArt(skin: SkinId) {
  const art = skins[skin];
  const imgs = {
    logo: useImage(art.logo),
    frame: useImage(art.frame),
    plate: useImage(art.plate),
    banner: useImage(art.banner),
    panel: useImage(art.panel),
    pill: useImage(art.pill),
    square: useImage(art.square),
    spinIdle: useImage(art.spinIdle),
    spinStop: useImage(art.spinStop),
    jackpot: useImage(art.jackpot),
    sound: useImage(art.iconSound),
    soundOff: useImage(art.iconSoundOff),
    vibrate: useImage(art.iconVibrate),
    flag: useImage(art.iconFlag),
    coins: useImage(art.iconCoins),
    crownIcon: useImage(art.iconCrown),
    crown: useImage(art.crown),
    ribbon: useImage(art.ribbon),
    star: useImage(art.star),
  };
  const { logo, frame, plate, banner, panel, pill, square, spinIdle, spinStop, jackpot, sound, soundOff, vibrate, flag, coins, crownIcon, crown, ribbon, star } = imgs;
  return useMemo(
    () => allDecoded({ logo, frame, plate, banner, panel, pill, square, spinIdle, spinStop, jackpot, sound, soundOff, vibrate, flag, coins, crownIcon, crown, ribbon, star }),
    [logo, frame, plate, banner, panel, pill, square, spinIdle, spinStop, jackpot, sound, soundOff, vibrate, flag, coins, crownIcon, crown, ribbon, star],
  );
}

/**
 * One full-screen Skia canvas holds the whole game scene, so the wheel → number flight → cell
 * hand-off happens in one coordinate space: nothing to measure across views, nothing to drift.
 *
 * Draw order (back to front): room (live shader) → wheel (its gold lower rim clears the board) → board → painted panels →
 * live plate / banner / counter → suspense spotlight → controls → flying number → particles →
 * release flash → loot beam → treasure → jackpot title. Animated layers are sprite batches (see engine/sprites), so the
 * scene is ~30 draw calls whatever is happening.
 */
export const Stage = memo(function Stage({ layout, sv, soundOn, hapticsOn, boardComplete, skin }: Props) {
  // perf overlay: counts committed scene renders (should stay flat while the wheel spins)
  useEffect(() => {
    renderStats.stage += 1;
  });
  const shared = useSharedArt();
  const skinArt = useSkinArt(skin);
  const img = useMemo(() => (shared && skinArt ? { ...shared, ...skinArt } : null), [shared, skinArt]);
  const face = useTypeface(fonts.arcade);
  const num = useTypeface(fonts.numeric);
  const numIt = useTypeface(fonts.numericItalic);
  const dpr = Math.min(3, PixelRatio.get());

  const f = useMemo(() => {
    if (!face || !num || !numIt) return null;
    const font = (size: number, tf = numIt) => Skia.Font(tf, Math.round(size));
    // cap height per px of font size, to size display type by its caps
    const capK = capHeight(Skia.Font(numIt, 100)) / 100;
    const td = Math.min(3, dpr);
    return {
      plate: font(((layout.plate.height * PLATE_CAP) / capK) * td),
      bannerHi: font((Math.min(layout.banner.height * 0.5, layout.width * 0.062) / capK) * td),
      textDpr: td,
      board: font(layout.cell * 0.5 * dpr, num),
      reel: font(layout.arc.band * 0.6 * 2, num),
      plus: font(64),
      digits: font(layout.panel.height * 0.62),
      small: font(layout.panel.height * 0.27),
      label: font(layout.panel.height * 0.28),
      ribbon: font(Math.min(20, layout.width * 0.048), face),
    };
  }, [face, num, numIt, layout, dpr]);

  const atlases = useMemo(() => {
    const img = shared;
    if (!img || !f) return null;
    return {
      board: buildBoardAtlas(
        {
          idle: skin === 'neon' ? img.tileIdleNeon : img.tileIdle,
          gold: img.tileGold,
          flip: skin === 'neon' ? img.tileFlipNeon : img.tileFlip,
          treasures: [img.t0, img.t1, img.t2, img.t3, img.t4, img.t5, img.t6, img.t7, img.t8],
          chest: img.chestOpen,
        },
        f.board,
        dpr,
        layout.cellW / layout.cell,
      ),
      reel: buildReelAtlas(layout, f.reel, 2, skinTone[skin]),
      text: buildTextAtlas(f.plate, f.bannerHi, f.textDpr),
      fx: buildFxAtlas(img.coinSpin, f.plus, {
        burst: img.fxBurst,
        glint: img.fxGlint,
        spark: img.fxSpark,
        ember: img.fxEmber,
        pillar: img.fxPillar,
      }),
    };
  }, [shared, f, layout, dpr, skin]);

  const boardTex = usePictureAsTexture(atlases?.board.picture ?? null, atlases?.board.size ?? NO_SIZE);
  const reelTex = usePictureAsTexture(atlases?.reel.picture ?? null, atlases?.reel.size ?? NO_SIZE);
  const fxTex = usePictureAsTexture(atlases?.fx.picture ?? null, atlases?.fx.size ?? NO_SIZE);
  const textTex = usePictureAsTexture(atlases?.text.picture ?? null, atlases?.text.size ?? NO_SIZE);

  const chrome = useMemo<ChromeImages | null>(
    () =>
      img
        ? {
            frame: img.frame,
            plate: img.plate,
            banner: img.banner,
            panel: img.panel,
            pill: img.pill,
            square: img.square,
            logo: img.logo,
            flag: img.flag,
            coins: img.coins,
            crown: img.crownIcon,
          }
        : null,
    [img],
  );

  const cam = useCamera(layout, sv);
  const hudOpacity = useDerivedValue(() => {
    const t = sv.tension.value;
    return 1 - 0.3 * t * t * (3 - 2 * t);
  });

  const ready = img && f && atlases && chrome;

  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      {ready ? (
        <>
          {/* world: framed by the camera (the backdrop with parallax); the HUD below stays put */}
          <Group transform={cam.far}>
            <Backdrop layout={layout} sv={sv} skin={skin} />
          </Group>
          <Group transform={cam.world}>
            <ArcReel layout={layout} sv={sv} atlas={atlases.reel} texture={reelTex} tone={skinTone[skin]} />
            <BoardChrome layout={layout} images={chrome} />
            <Tiles layout={layout} sv={sv} atlas={atlases.board} texture={boardTex} />
          </Group>
          {/* HUD: dims while the camera leans in on the wheel */}
          <Group opacity={hudOpacity}>
            <PanelChrome layout={layout} images={chrome} labelFont={f.label} smallFont={f.small} digitFont={f.digits} />
            <ResultPlate layout={layout} sv={sv} atlas={atlases.reel} texture={reelTex} text={atlases.text} textTexture={textTex} />
            <Banner layout={layout} sv={sv} atlas={atlases.text} texture={textTex} />
            <Counter layout={layout} sv={sv} font={f.digits} smallFont={f.small} />
          </Group>
          <Spotlight layout={layout} sv={sv} />
          <ControlBar
            layout={layout}
            sv={sv}
            idle={img.spinIdle}
            stop={img.spinStop}
            sound={img.sound}
            soundOff={img.soundOff}
            vibrate={img.vibrate}
            soundOn={soundOn}
            hapticsOn={hapticsOn}
            boardComplete={boardComplete}
          />
          <Group transform={cam.world}>
            <StageLights layout={layout} sv={sv} skin={skin} />
            <FlyNumber layout={layout} sv={sv} atlas={atlases.reel} texture={reelTex} />
            <CoinPhysics layout={layout} sv={sv} atlas={atlases.fx} texture={fxTex} />
            <Particles layout={layout} sv={sv} atlas={atlases.fx} texture={fxTex} />
            <Release layout={layout} sv={sv} godrays={img.godrays} />
            <LootBeam layout={layout} sv={sv} atlas={atlases.fx} texture={fxTex} />
            <TreasureReveal layout={layout} sv={sv} atlas={atlases.board} texture={boardTex} />
          </Group>
          {/* after the house-lights dimmer, so the lettering still catches light in the dark */}
          <Group opacity={hudOpacity}>
            <TextShimmer layout={layout} sv={sv} atlas={atlases.fx} texture={fxTex} />
          </Group>
          <JackpotBanner
            layout={layout}
            sv={sv}
            title={img.jackpot}
            crown={img.crown}
            ribbon={img.ribbon}
            star={img.star}
            godrays={img.godrays}
            font={f.ribbon}
            fx={atlases.fx}
            fxTexture={fxTex}
          />
        </>
      ) : null}
    </Canvas>
  );
});
