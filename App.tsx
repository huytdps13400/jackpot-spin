import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { useSyncExternalStore } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { GameScreen } from './src/components/GameScreen';
import { useGameStore } from './src/game/store';
import { color, fonts } from './src/theme/tokens';

const subscribeHydration = (onChange: () => void) => useGameStore.persist.onFinishHydration(onChange);
const getHydrated = () => useGameStore.persist.hasHydrated();

/** Wait for the persisted board before mounting, so the reel starts on the last result. */
function useHydrated() {
  return useSyncExternalStore(subscribeHydration, getHydrated);
}

export default function App() {
  const [fontsLoaded] = useFonts({
    'BodoniModa-SemiBold': fonts.displaySemi,
    'Inter-Medium': fonts.uiMedium,
    'Inter-SemiBold': fonts.uiSemi,
    'Cinzel-Bold': fonts.engraved,
    'Cinzel-Black': fonts.engravedBlack,
    LilitaOne: fonts.arcade,
  });
  const hydrated = useHydrated();

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {fontsLoaded && hydrated ? <GameScreen /> : null}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
});
