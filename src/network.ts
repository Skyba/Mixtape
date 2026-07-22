import * as Network from "expo-network";
import { Settings } from "./types";

export async function canUploadNow(settings: Settings): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    if (!state.isConnected || !state.isInternetReachable) return false;
    if (state.type === Network.NetworkStateType.WIFI) return true;
    return settings.uploadOnCellular;
  } catch {
    return false;
  }
}
