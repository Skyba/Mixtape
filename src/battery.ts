import { Platform } from "react-native";
import * as Battery from "expo-battery";
import * as IntentLauncher from "expo-intent-launcher";
import AsyncStorage from "@react-native-async-storage/async-storage";
import appConfig from "../app.json";

const SNOOZE_KEY = "batteryPromptSnoozeUntil";
// Derived from app.json so it tracks whatever package id you build with.
const PKG = (appConfig as { expo?: { android?: { package?: string } } }).expo
  ?.android?.package;

/** True if Android battery optimization is ON (i.e. NOT set to Unrestricted). */
export async function isBatteryOptimized(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await Battery.isBatteryOptimizationEnabledAsync();
  } catch {
    return false;
  }
}

export async function isBatteryPromptSnoozed(): Promise<boolean> {
  try {
    const v = await AsyncStorage.getItem(SNOOZE_KEY);
    return !!v && Date.now() < Number(v);
  } catch {
    return false;
  }
}

export async function snoozeBatteryPrompt(): Promise<void> {
  await AsyncStorage.setItem(
    SNOOZE_KEY,
    String(Date.now() + 14 * 24 * 60 * 60 * 1000)
  );
}

/** Opens the one-tap "let app run unrestricted" dialog; falls back to app settings. */
export async function openUnrestrictedSettings(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await IntentLauncher.startActivityAsync(
      "android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
      { data: "package:" + PKG }
    );
  } catch {
    try {
      await IntentLauncher.startActivityAsync(
        IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS,
        { data: "package:" + PKG }
      );
    } catch {}
  }
}
