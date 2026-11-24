/**
 * "Vault at Midnight" colour system (Treasure Vault skin: + ruby accent for gems and the SPIN face).
 *
 * Reference tokens are built in OKLCH around the hero gold #C68D28 = oklch(0.683 0.130 76.7).
 * The gold ramp walks hue from ~55° (bronze) to ~98° (specular) because darker metal reads warmer
 * (Bezold–Brücke shift). Contrast pairs were verified against WCAG 2.x (see README).
 *
 * Rule of thumb: 60% ink, 30% raised surfaces, 10% gold. Gold is *light*, so it is only used for
 * the reel rails, the primary action and things the player has won.
 */
export const ref = {
  ink900: '#040712',
  ink800: '#080D1D',
  ink700: '#12192A',
  ink600: '#1C2338',
  ink400: '#353D50',
  mist300: '#8893A5',
  ivory50: '#F5F0E3',
  gold50: '#FDF6D4',
  gold200: '#F3D991',
  gold300: '#E6B557',
  gold500: '#C68D28', // hero / anchor
  gold700: '#9D621F',
  gold900: '#683B18',
  ember400: '#FECE92',
  plum700: '#4D1538',
  ruby300: '#E2506A',
  ruby500: '#A3152E',
  ruby700: '#5E0A1B',
  indigo700: '#2A2869',
} as const;

/**
 * "Royal Treasure" (layout #4, luxury grade). Midnight sapphire carries the structure, polished
 * gold is the hero (frames, rims, everything the player wins), ruby is the one warm accent (the
 * SPIN jewel, ribbons) and cyan is a rare cool spark (secondary text, edge light). No magenta.
 */
export const lux = {
  night: '#05051A',
  navy900: '#0B0A26',
  navy800: '#141038',
  navy700: '#1C1650',
  navy600: '#221A5C',
  royal500: '#3A2F9E',
  royal300: '#8E8CFF',
  ice: '#E6EAFF',
  iceDim: '#AEB8E8',
  ruby300: '#FF7A9C',
  ruby500: '#E23A6E',
  ruby700: '#B0123F',
  ruby900: '#6E0A26',
  cyan300: '#9BEFFF',
  cyan500: '#5FE1FF',
  gold50: '#FFF8DC',
  gold200: '#FFE592',
  gold400: '#F7C948',
  gold600: '#D79A2B',
  gold800: '#9A5E14',
  gold900: '#5A3208',
  outline: '#0B0A26',
} as const;

/** Semantic roles — components consume these, never raw hex. */
export const color = {
  bg: lux.night,
  bgDeep: ref.ink900,
  cell: ref.ink700,
  cellWon: ref.ink600,
  hairline: ref.ink400,
  textMuted: ref.mist300,
  textPrimary: ref.ivory50,
  textOnGold: ref.ink900,
  accent: ref.gold500,
  accentSoft: ref.gold200,
  wonEdge: ref.gold700,
  glowCore: ref.ember400,
} as const;

/** 9-stop metal gradient (OKLab-interpolated by Skia when rendered with `in oklab`-like stops). */
export const metal = {
  colors: [
    ref.gold900,
    ref.gold700,
    ref.gold500,
    ref.gold300,
    ref.gold200,
    ref.gold50,
    ref.gold300,
    ref.gold500,
    ref.gold900,
  ],
  positions: [0, 0.18, 0.36, 0.47, 0.53, 0.56, 0.62, 0.8, 1],
};

/**
 * Spacing scale — one 4 pt base for every margin, padding and gap in the game layout
 * (theme/layout.ts) and inside the Skia panels:
 *   1 = 4   hairline gaps: between keys, between chips in the control bar, bar end padding
 *   2 = 8   section rhythm: plate ↔ banner ↔ panel ↔ SPIN, chip vertical padding
 *   3 = 12  screen gutter: every full-width element's *visible* edge
 *   6 = 24  panel inner padding (counter lettering)
 */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24 } as const;

export const fonts = {
  displayMedium: require('../../assets/fonts/BodoniModa_500Medium.ttf'),
  displaySemi: require('../../assets/fonts/BodoniModa_600SemiBold.ttf'),
  uiMedium: require('../../assets/fonts/Inter_500Medium.ttf'),
  uiSemi: require('../../assets/fonts/Inter_600SemiBold.ttf'),
  engraved: require('../../assets/fonts/Cinzel_700Bold.ttf'),
  engravedBlack: require('../../assets/fonts/Cinzel_900Black.ttf'),
  /** Chunky rounded display face of the arcade skin (numbers, banner, counter). */
  arcade: require('../../assets/fonts/LilitaOne_400Regular.ttf'),
  /** Heavy geometric grotesque of the arcade lettering: wheel, board and plate numbers. */
  numeric: require('../../assets/fonts/Montserrat_900Black.ttf'),
  /** Its true italic: banner, result plate, counter. */
  numericItalic: require('../../assets/fonts/Montserrat_900Black_Italic.ttf'),
};

/**
 * Per-skin tones for the procedural (Skia-drawn) parts, so they sit in the same light as each
 * skin's painted chrome. Gold is shared: it is the "you win" colour in every skin.
 */
export const skinTone = {
  neon: {
    /** wheel plate lacquer, rim → hub */
    plate: ['#9A6BF2', '#6232C4', '#31137A', '#190846'],
    plateEdge: 'rgba(205,185,255,0.42)',
    /** the pointer window: a lit magenta jewel */
    window: ['#FF6EC7', '#E81F94', '#A30F7C', '#4E0848'],
    windowGlow: 'rgba(255,92,196,0.9)',
    gem: ['#FFD0EE', '#F0369F', '#6E0A5A'],
  },
  royal: {
    plate: ['#4A44B8', '#2A2580', '#15124A', '#0B0A28'],
    plateEdge: 'rgba(150,170,255,0.35)',
    window: ['#FF9DB8', '#E23A6E', '#B0123F', '#5E0A1B'],
    windowGlow: 'rgba(255,96,140,0.9)',
    gem: ['#FFD2DE', '#E23A6E', '#6E0A26'],
  },
} as const;
export type SkinTone = (typeof skinTone)[keyof typeof skinTone];
