/** Skin ids (asset-free, so the store and tests can import it). Order = tap-the-logo cycle. */
export const SKINS = ['neon', 'royal'] as const;
export type SkinId = (typeof SKINS)[number];
