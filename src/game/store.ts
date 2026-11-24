import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { SKINS, type SkinId } from '../theme/skin';

import { newBoardSeed } from './treasure';

export type UiPhase = 'idle' | 'spinning';
export type ResultKind = 'new' | 'repeat' | 'complete';

type GameState = {
  /** Numbers 1..100 the player has claimed, in the order they were first won. */
  won: number[];
  /** Every result, newest last (capped). */
  history: number[];
  round: number;
  lastKind: ResultKind | null;
  /** Shuffles the treasures hidden under this board's cells (see treasure.ts). */
  boardSeed: number;
  /** New cells claimed in a row (a repeat breaks it) and the best run ever. */
  streak: number;
  bestStreak: number;
  soundOn: boolean;
  hapticsOn: boolean;
  hasSpun: boolean;
  /** Coarse phase for accessibility labels only — animation never reads React state. */
  uiPhase: UiPhase;
  perfHud: boolean;
  skin: SkinId;

  commitResult: (n: number) => ResultKind;
  resetBoard: () => void;
  startSpin: () => void;
  toggleSound: () => void;
  toggleHaptics: () => void;
  togglePerfHud: () => void;
  cycleSkin: () => void;
  debugFillAllBut: (n: number) => void;
};

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      won: [],
      history: [],
      round: 0,
      lastKind: null,
      boardSeed: newBoardSeed(),
      streak: 0,
      bestStreak: 0,
      soundOn: true,
      hapticsOn: true,
      hasSpun: false,
      uiPhase: 'idle',
      perfHud: false,
      skin: 'neon',

      commitResult: (n) => {
        const { won, history, round, streak, bestStreak } = get();
        const isNew = !won.includes(n);
        const nextWon = isNew ? [...won, n] : won;
        const kind: ResultKind = !isNew ? 'repeat' : nextWon.length === 100 ? 'complete' : 'new';
        const nextStreak = isNew ? streak + 1 : 0;
        set({
          won: nextWon,
          history: [...history, n].slice(-50),
          round: round + 1,
          lastKind: kind,
          streak: nextStreak,
          bestStreak: Math.max(bestStreak, nextStreak),
          uiPhase: 'idle',
        });
        return kind;
      },
      resetBoard: () => set({ won: [], history: [], round: 0, lastKind: null, streak: 0, boardSeed: newBoardSeed() }),
      // one store write per spin start (a11y label + first-run hint), one per result
      startSpin: () => set({ uiPhase: 'spinning', hasSpun: true }),
      toggleSound: () => set((s) => ({ soundOn: !s.soundOn })),
      toggleHaptics: () => set((s) => ({ hapticsOn: !s.hapticsOn })),
      togglePerfHud: () => set((s) => ({ perfHud: !s.perfHud })),
      cycleSkin: () => set((s) => ({ skin: SKINS[(SKINS.indexOf(s.skin) + 1) % SKINS.length] })),
      /** QA helper (long-press the round counter): claim every cell except `n`. */
      debugFillAllBut: (n) => {
        const won = Array.from({ length: 100 }, (_, i) => i + 1).filter((v) => v !== n);
        set({ won, history: won.slice(-50), round: won.length, lastKind: 'new' });
      },
    }),
    {
      name: 'jackpot-spin/v2',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        won: s.won,
        history: s.history,
        round: s.round,
        lastKind: s.lastKind,
        boardSeed: s.boardSeed,
        streak: s.streak,
        bestStreak: s.bestStreak,
        soundOn: s.soundOn,
        hapticsOn: s.hapticsOn,
        hasSpun: s.hasSpun,
        skin: s.skin,
      }),
    },
  ),
);

export const selectBoardComplete = (s: GameState) => s.won.length === 100;
