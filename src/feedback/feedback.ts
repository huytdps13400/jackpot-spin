import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { AppState, type NativeEventSubscription } from 'react-native';

import { useGameStore, type ResultKind } from '../game/store';

/**
 * Haptic + sound "ladder". Every event escalates in weight so the player can *feel* the
 * spin's structure with eyes closed: press (light) → ticks (selection, then light → medium as suspense builds) → lock (rigid) →
 * impact (success / heavy). These run on the JS thread; the UI thread only schedules them,
 * so a slow haptic call can never cost an animation frame.
 */

let players: { tick: AudioPlayer; lock: AudioPlayer; win: AudioPlayer; music: AudioPlayer } | null = null;
let unsubs: (() => void)[] = [];

/** Background music bed level: under the effects, so ticks and the win sting still lead. */
const MUSIC_VOLUME = 0.32;
/** While the win sting plays the bed dips, then swells back. */
const MUSIC_DUCKED = 0.14;
let duckTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Background music (assets/sounds/music_jackpot.m4a, an original 32 s loop made by
 * scripts/make-music.py) follows the same Sound toggle as the effects, respects the silent
 * switch, and stops whenever the app leaves the foreground.
 */
function syncMusic() {
  if (!players) return;
  const on = useGameStore.getState().soundOn && AppState.currentState === 'active';
  try {
    if (on && !players.music.playing) players.music.play();
    else if (!on && players.music.playing) players.music.pause();
  } catch {
    // audio is a bonus; never let it break the game loop
  }
}

function duckMusic(ms: number) {
  if (!players) return;
  players.music.volume = MUSIC_DUCKED;
  if (duckTimer) clearTimeout(duckTimer);
  duckTimer = setTimeout(() => {
    if (players) players.music.volume = MUSIC_VOLUME;
    duckTimer = null;
  }, ms);
}

export function initSounds() {
  if (players) return;
  setAudioModeAsync({ playsInSilentMode: false }).catch(() => {});
  players = {
    tick: createAudioPlayer(require('../../assets/sounds/tick.wav')),
    lock: createAudioPlayer(require('../../assets/sounds/lock.wav')),
    win: createAudioPlayer(require('../../assets/sounds/win.wav')),
    music: createAudioPlayer(require('../../assets/sounds/music_jackpot.m4a')),
  };
  players.tick.volume = 0.35;
  players.lock.volume = 0.8;
  players.win.volume = 0.7;
  players.music.loop = true;
  players.music.volume = MUSIC_VOLUME;
  const app: NativeEventSubscription = AppState.addEventListener('change', syncMusic);
  const store = useGameStore.subscribe((s, prev) => {
    if (s.soundOn !== prev.soundOn) syncMusic();
  });
  unsubs = [() => app.remove(), store];
  syncMusic();
}

export function releaseSounds() {
  if (!players) return;
  unsubs.forEach((u) => u());
  unsubs = [];
  if (duckTimer) clearTimeout(duckTimer);
  duckTimer = null;
  players.tick.remove();
  players.lock.remove();
  players.win.remove();
  players.music.remove();
  players = null;
}

function play(name: 'tick' | 'lock' | 'win') {
  if (!players || !useGameStore.getState().soundOn) return;
  const p = players[name];
  try {
    p.seekTo(0).catch(() => {});
    p.play();
  } catch {
    // audio is a bonus; never let it break the game loop
  }
}

const hapticsOn = () => useGameStore.getState().hapticsOn;
const TICK_STYLES = [
  Haptics.ImpactFeedbackStyle.Light,
  Haptics.ImpactFeedbackStyle.Medium,
  Haptics.ImpactFeedbackStyle.Heavy,
];

export const feedback = {
  press() {
    if (hapticsOn()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  /**
   * One pin passing the pointer. level 0..3 counts down to the stop: 0 ratchet while braking,
   * 1 crawl click, 2 the last three numbers, 3 the winner's pin. Heavier and louder each step.
   */
  tick(level = 0) {
    if (hapticsOn()) {
      if (level === 0) Haptics.selectionAsync().catch(() => {});
      else Haptics.impactAsync(TICK_STYLES[level - 1] ?? Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    }
    if (players) players.tick.volume = Math.min(1, 0.3 + 0.2 * level);
    play('tick');
  },
  lock() {
    if (hapticsOn()) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => {});
    play('lock');
  },
  impact(kind: ResultKind) {
    if (hapticsOn()) {
      if (kind === 'repeat') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {});
      else if (kind === 'complete')
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)
          .then(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success))
          .catch(() => {});
      else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
    if (kind !== 'repeat') {
      if (useGameStore.getState().soundOn) duckMusic(kind === 'complete' ? 2600 : 1300);
      play('win');
    }
  },
};
