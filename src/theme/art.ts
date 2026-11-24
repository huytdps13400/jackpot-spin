import type { SkinId } from './skin';

/**
 * Raster art. Pipelines, all reproducible from the repo:
 *  - assets/sprites:     3D tiles and coins rendered with Blender/Cycles
 *                        (scripts/blender/render_tiles.py, render_coins.py → pack_sprites.py)
 *  - assets/art/arcade:  painted UI chrome generated with an image model from written briefs
 *                        (see README → "Assets"), cropped/resized by scripts/art/process_arcade.py
 *  - assets/art/lux:     the "Royal Treasure" skin: the arcade chrome re-graded in OKLCH by
 *                        scripts/art/recolor_luxury.py, plus new image-model art (background,
 *                        crown, ribbon, star, treasure symbols) cut by scripts/art/process_lux.py
 *  - everything that moves (numbers, glows, particles, light) is drawn by Skia at runtime
 */
export const sprites = {
  /** 16 frames, 4×4 grid of 128 px cells: a gold coin turning a full revolution. */
  coinSpin: require('../../assets/sprites/coin_spin_sheet.png'),
  /** 128 px vault lid, unclaimed: sapphire lacquer with a gold rim. */
  tileIdle: require('../../assets/sprites/tile_idle.png'),
  /** 128 px open vault, claimed: gold bezel around a dark setting for the treasure. */
  tileGold: require('../../assets/sprites/tile_gold.png'),
  /** 24 frames, 6×4 grid of 128 px cells: sapphire lid → gold setting, flipping 0 → 180°. */
  tileFlip: require('../../assets/sprites/tile_flip_sheet.png'),
  /** Neon Royale: the same two renders with the lacquer re-lit violet (scripts/art/recolor_neon.py). */
  tileIdleNeon: require('../../assets/sprites/tile_idle_neon.png'),
  tileFlipNeon: require('../../assets/sprites/tile_flip_sheet_neon.png'),
  /** 16 frames, 4×4 grid of 256 px cells: the treasure chest throwing its lid open. */
  chestOpen: require('../../assets/sprites/chest_open_sheet.png'),
  // light effects (scripts/blender/render_vfx.py): light on pure black, for additive blending only
  /** 16 frames, 4×4 grid of 256 px cells: impact flare (pop, streaks, needle rays, shockwave ring). */
  fxBurst: require('../../assets/sprites/fx_burst_sheet.png'),
  /** 16 frames, 4×4 grid of 128 px cells: a 4-point star glint growing, turning and fading. */
  fxGlint: require('../../assets/sprites/fx_glint_sheet.png'),
  /** 128×32: a white-hot streak, bright head on the right. */
  fxSpark: require('../../assets/sprites/fx_spark.png'),
  /** 64×64: a tiny white core in a gold halo. */
  fxEmber: require('../../assets/sprites/fx_ember.png'),
  /** 12 + 12 frames of 96×384 px: the loot beam's tintable haze row, then its white-hot core row. */
  fxPillar: require('../../assets/sprites/fx_pillar_sheet.png'),
  /** 512×512: 22 soft light shafts. */
  fxGodrays: require('../../assets/sprites/fx_godrays.png'),
};

const shared = {
  crown: require('../../assets/art/lux/crown_lux.png'),
  ribbon: require('../../assets/art/lux/ribbon_ruby.png'),
  star: require('../../assets/art/lux/star_gold.png'),
};

/**
 * Two skins over the same nine-slice geometry (the lux set is the arcade set re-graded, so every
 * rect lines up). Tap the logo to switch; the choice persists.
 *  - neon:  "Neon Royale" — the original concept: violet stage, magenta SPIN jewel, gold trim.
 *  - royal: "Royal Treasure" — midnight sapphire + polished gold.
 */
export const skins = {
  neon: {
    logo: require('../../assets/art/arcade/logo_small.png'),
    frame: require('../../assets/art/arcade/frame_board.png'),
    // gold enamel plate, as in the reference: the number's dark outline + extrusion carry it
    plate: require('../../assets/art/arcade/plate_hex.png'),
    banner: require('../../assets/art/arcade/banner_strip.png'),
    panel: require('../../assets/art/arcade/panel_counter.png'),
    pill: require('../../assets/art/arcade/pill.png'),
    square: require('../../assets/art/arcade/button_square.png'),
    spinIdle: require('../../assets/art/arcade/spin_idle.png'),
    spinStop: require('../../assets/art/arcade/spin_stop.png'),
    jackpot: require('../../assets/art/arcade/jackpot_title.png'),
    iconSound: require('../../assets/art/arcade/icon_sound.png'),
    iconSoundOff: require('../../assets/art/arcade/icon_sound_off.png'),
    iconVibrate: require('../../assets/art/arcade/icon_vibrate.png'),
    iconFlag: require('../../assets/art/arcade/icon_flag.png'),
    iconCoins: require('../../assets/art/arcade/icon_coins.png'),
    iconCrown: require('../../assets/art/arcade/icon_crown.png'),
    ...shared,
  },
  royal: {
    logo: require('../../assets/art/lux/logo_small.png'),
    frame: require('../../assets/art/lux/frame_board.png'),
    plate: require('../../assets/art/lux/plate_hex.png'),
    banner: require('../../assets/art/lux/banner_strip.png'),
    panel: require('../../assets/art/lux/panel_counter.png'),
    pill: require('../../assets/art/lux/pill.png'),
    square: require('../../assets/art/lux/button_square.png'),
    spinIdle: require('../../assets/art/lux/spin_idle.png'),
    spinStop: require('../../assets/art/lux/spin_stop.png'),
    jackpot: require('../../assets/art/lux/jackpot_title.png'),
    iconSound: require('../../assets/art/lux/icon_sound.png'),
    iconSoundOff: require('../../assets/art/lux/icon_sound_off.png'),
    iconVibrate: require('../../assets/art/lux/icon_vibrate.png'),
    iconFlag: require('../../assets/art/lux/icon_flag.png'),
    iconCoins: require('../../assets/art/lux/icon_coins.png'),
    iconCrown: require('../../assets/art/lux/icon_crown.png'),
    ...shared,
  },
} satisfies Record<SkinId, unknown>;

/** Treasure symbols, in game/treasure.ts order (coin … chest). 160 px squares. */
export const treasureArt = [
  require('../../assets/art/lux/t_coin.png'),
  require('../../assets/art/lux/t_bars.png'),
  require('../../assets/art/lux/t_emerald.png'),
  require('../../assets/art/lux/t_sapphire.png'),
  require('../../assets/art/lux/t_amethyst.png'),
  require('../../assets/art/lux/t_ruby.png'),
  require('../../assets/art/lux/t_crown.png'),
  require('../../assets/art/lux/t_diamond.png'),
  require('../../assets/art/lux/t_chest.png'),
];

/**
 * Nine-slice metadata for the painted panels: the centre rect (image px) that may stretch, and
 * `cap` = the panel's natural thickness in image px, i.e. the image is drawn at `cap / pt` px per
 * point so bevels and glows keep their painted proportions at any panel size.
 */
export const nine = {
  frame: { center: [80, 80, 574, 571], cap: 50 },
  plate: { center: [140, 60, 424, 150], cap: 210 },
  banner: { center: [80, 40, 700, 102], cap: 142 },
  panel: { center: [90, 90, 463, 146], cap: 236 },
  pill: { center: [60, 30, 299, 82], cap: 112 },
} as const;
