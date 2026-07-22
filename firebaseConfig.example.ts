// ── SETUP ──────────────────────────────────────────────────────────────────
// Copy this file to `firebaseConfig.ts` and paste YOUR Firebase project's web
// config: Firebase console → Project settings → "Your apps" → Web app → SDK setup.
//
// The web `apiKey` is NOT a secret — it's a client identifier. Access is
// controlled by the Firestore/Storage security rules + Firebase Auth, not by
// keeping this key private. `firebaseConfig.ts` is gitignored anyway so your
// project's ids never get committed.
//
// Until `storageBucket` is filled in, the app runs fully local (recordings stay
// on the device only; no cloud sync, share links, or REST API).
// ─────────────────────────────────────────────────────────────────────────────
export const firebaseConfig = {
  apiKey: "PASTE_FIREBASE_WEB_API_KEY",
  authDomain: "PASTE_PROJECT.firebaseapp.com",
  projectId: "PASTE_PROJECT",
  storageBucket: "PASTE_PROJECT.firebasestorage.app",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
  measurementId: "PASTE_MEASUREMENT_ID",
};

export const isFirebaseConfigured =
  !firebaseConfig.storageBucket.startsWith("PASTE");

// Google sign-in (OPTIONAL — email/password works without this).
// Web client ID:     Firebase console → Auth → Sign-in method → Google → Web SDK.
// Android client ID: Google Cloud Console → Credentials → OAuth 2.0 (Android);
//                    needs your app's SHA-1 fingerprint + package name.
// Not secret. Google sign-in only completes in an EAS build, not in Expo Go.
export const googleWebClientId = "PASTE_GOOGLE_WEB_CLIENT_ID";
export const googleAndroidClientId = "PASTE_GOOGLE_ANDROID_CLIENT_ID";

export const isGoogleConfigured =
  !googleWebClientId.startsWith("PASTE") &&
  !googleAndroidClientId.startsWith("PASTE");
