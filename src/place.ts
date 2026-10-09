/** Where a recording was made. Coarse on purpose: a city, not a track. */
export type Place = { lat: number; lon: number; city?: string; region?: string };

/**
 * Loaded on demand, never at import time. expo-location calls
 * requireNativeModule as soon as its module body runs, so a static import
 * would throw while this screen was being loaded on any build without the
 * native module — and updates reach the installed APK before a new one is
 * sideloaded. A missing module has to degrade to "no place", not a crash.
 */
function loadLocation(): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-location");
  } catch {
    return null;
  }
}

/**
 * One fix at the start of a take. Never follows the phone around: a
 * conversation does not move, and a continuous fix would cost battery on
 * exactly the takes that run longest.
 *
 * Returns undefined whenever anything is missing — module absent, permission
 * refused, no fix. A recording without a place is normal; a recording that
 * failed to start because of a place is not.
 */
export async function capturePlace(): Promise<Place | undefined> {
  const Location = loadLocation();
  if (!Location) return undefined;
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    if (status !== "granted") return undefined;
    const pos = await Location.getLastKnownPositionAsync({
      maxAge: 10 * 60 * 1000,
      requiredAccuracy: 1000,
    });
    const fix =
      pos ??
      (await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
        // Starting a recording must never raise a system dialog. With location
        // services off this otherwise offers to turn them on, mid-start.
        mayShowUserSettingsDialog: false,
      }));
    if (!fix?.coords) return undefined;
    const place: Place = {
      lat: Number(fix.coords.latitude.toFixed(4)),
      lon: Number(fix.coords.longitude.toFixed(4)),
    };
    try {
      const [geo] = await Location.reverseGeocodeAsync({
        latitude: fix.coords.latitude,
        longitude: fix.coords.longitude,
      });
      if (geo?.city) place.city = geo.city;
      if (geo?.region) place.region = geo.region;
    } catch {
      /* coordinates without a name are still useful */
    }
    return place;
  } catch {
    return undefined;
  }
}

/** Asks once, from Settings. Recording never prompts. */
export async function requestPlacePermission(): Promise<boolean> {
  const Location = loadLocation();
  if (!Location) return false;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    return status === "granted";
  } catch {
    return false;
  }
}

/** "Lisbon" / "Lisbon, Lisboa" / "" — for a list row. */
export function placeLabel(p?: Place): string {
  if (!p) return "";
  if (p.city && p.region && p.region !== p.city) return `${p.city}, ${p.region}`;
  return p.city ?? `${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}`;
}
