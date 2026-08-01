import { useEffect, useState } from "react";
import { AppState } from "react-native";
import * as Font from "expo-font";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer, DarkTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import ErrorBoundary from "./src/ErrorBoundary";
import RecordScreen from "./src/screens/RecordScreen";
import LibraryScreen from "./src/screens/LibraryScreen";
import RecordingDetailScreen from "./src/screens/RecordingDetailScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import LoginScreen from "./src/screens/LoginScreen";
import ApiKeysScreen from "./src/screens/ApiKeysScreen";
import { initNotifications } from "./src/notifications";
import {
  flushPendingUploads,
  retryPendingMerges,
  retryPendingTranscriptions,
  pullCloudTranscripts,
} from "./src/recordingFlow";
import { logEvent, getLogText } from "./src/log";
import { uploadDebugLog, authReady } from "./src/firebase";
import { getSettings } from "./src/storage";
import { Recording } from "./src/types";

export type RootStackParamList = {
  Tabs: undefined;
  Detail: { rec: Recording; remote?: boolean };
  Login: undefined;
  ApiKeys: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  Record: "mic",
  Library: "albums",
  Settings: "settings",
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarStyle: {
          backgroundColor: "#0f1115",
          borderTopColor: "#23262d",
        },
        tabBarActiveTintColor: "#3b82f6",
        tabBarInactiveTintColor: "#6b7280",
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons
            name={
              focused
                ? TAB_ICONS[route.name]
                : (`${TAB_ICONS[route.name]}-outline` as keyof typeof Ionicons.glyphMap)
            }
            size={size}
            color={color}
          />
        ),
      })}
    >
      <Tab.Screen name="Record" component={RecordScreen} />
      <Tab.Screen name="Library" component={LibraryScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function App() {
  // Explicitly load the icon font — under the New Architecture @expo/vector-icons
  // doesn't always auto-register it, which shows icons as blank squares.
  const [fontReady, setFontReady] = useState(false);
  useEffect(() => {
    Font.loadAsync(Ionicons.font).finally(() => setFontReady(true));
  }, []);

  useEffect(() => {
    // capture uncaught JS errors into the debug log
    const g: any = global;
    if (g.ErrorUtils?.setGlobalHandler) {
      const prev = g.ErrorUtils.getGlobalHandler?.();
      g.ErrorUtils.setGlobalHandler((e: any, fatal?: boolean) => {
        logEvent(`FATAL(${fatal}) ${e?.message}\n${String(e?.stack).slice(0, 600)}`);
        prev?.(e, fatal);
      });
    }
    logEvent("app launch");
    initNotifications();
    getSettings().then(async (s) => {
      // Auth restores from storage asynchronously — without this the recovery
      // jobs below all read "signed out" and take their offline path, which
      // re-transcribes on-device what the backend already did in the cloud.
      await authReady();
      flushPendingUploads(s);
      retryPendingMerges(s); // recover any live recording whose merge didn't finish
      pullCloudTranscripts(s); // collect transcripts the backend finished while closed
      retryPendingTranscriptions(s); // offline fallback: finish on-device transcriptions
      try {
        await uploadDebugLog(await getLogText()); // make latest logs pullable
      } catch {}
    });

    // Also recover on every foreground — a transcription killed in the
    // background otherwise stays stuck until the next cold launch.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") {
        getSettings().then(async (s) => {
          await authReady();
          flushPendingUploads(s);
          pullCloudTranscripts(s);
          retryPendingTranscriptions(s);
        });
      }
    });
    return () => sub.remove();
  }, []);

  if (!fontReady) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <ErrorBoundary>
      <NavigationContainer theme={DarkTheme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: "#0f1115" },
            headerTintColor: "#fff",
          }}
        >
          <Stack.Screen
            name="Tabs"
            component={Tabs}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Detail"
            component={RecordingDetailScreen}
            options={{ title: "Recording" }}
          />
          <Stack.Screen
            name="Login"
            component={LoginScreen}
            options={{ headerShown: false, presentation: "modal" }}
          />
          <Stack.Screen
            name="ApiKeys"
            component={ApiKeysScreen}
            options={{ title: "API access" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
