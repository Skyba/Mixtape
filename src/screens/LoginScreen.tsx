import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import * as Google from "expo-auth-session/providers/google";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import {
  signIn,
  signUp,
  signInWithGoogleIdToken,
  subscribeAuth,
} from "../firebase";
import {
  googleWebClientId,
  googleAndroidClientId,
  isGoogleConfigured,
} from "../../firebaseConfig";
import type { RootStackParamList } from "../../App";

WebBrowser.maybeCompleteAuthSession();

type Props = NativeStackScreenProps<RootStackParamList, "Login">;

/**
 * Google.useAuthRequest throws synchronously on Android if androidClientId is
 * missing. We isolate it in a child that only mounts when fully configured —
 * otherwise the parent screen would crash before email login is reachable.
 */
function GoogleButton({
  onError,
  setBusy,
}: {
  onError: (msg: string) => void;
  setBusy: (b: boolean) => void;
}) {
  const [request, response, promptAsync] = Google.useAuthRequest({
    webClientId: googleWebClientId,
    androidClientId: googleAndroidClientId,
  });

  useEffect(() => {
    if (response?.type !== "success") return;
    const idToken =
      response.authentication?.idToken ?? (response.params as any)?.id_token;
    if (!idToken) {
      onError("Google returned no token");
      return;
    }
    setBusy(true);
    signInWithGoogleIdToken(idToken)
      .catch((e) => onError(String(e?.code ?? e?.message ?? e)))
      .finally(() => setBusy(false));
  }, [response]);

  return (
    <TouchableOpacity
      style={styles.googleBtn}
      disabled={!request}
      onPress={() => promptAsync()}
    >
      <Ionicons name="logo-google" size={20} color="#1f1f1f" />
      <Text style={styles.googleTxt}>Continue with Google</Text>
    </TouchableOpacity>
  );
}

export default function LoginScreen({ navigation }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");

  // Close this screen as soon as auth succeeds (any method).
  useEffect(() => subscribeAuth((e) => e && navigation.goBack()), [navigation]);

  async function emailAuth() {
    setBusy(true);
    setErr("");
    try {
      if (mode === "signup") await signUp(email, password);
      else await signIn(email, password);
    } catch (e: any) {
      setErr(String(e?.code ?? e?.message ?? e));
    }
    setBusy(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.brand}>
        <View style={styles.logo}>
          <Ionicons name="mic" size={42} color="#fff" />
        </View>
        <Text style={styles.appName}>Mixtape</Text>
        <Text style={styles.tagline}>
          Sign in to back up & sync recordings
        </Text>
      </View>

      {isGoogleConfigured ? (
        <GoogleButton onError={setErr} setBusy={setBusy} />
      ) : (
        <View style={[styles.googleBtn, styles.disabled]}>
          <Ionicons name="logo-google" size={20} color="#1f1f1f" />
          <Text style={styles.googleTxt}>Continue with Google</Text>
        </View>
      )}
      {!isGoogleConfigured ? (
        <Text style={styles.note}>
          Google not configured — paste googleWebClientId + googleAndroidClientId
          in firebaseConfig.ts. (Google sign-in completes only in an EAS build,
          not Expo Go.)
        </Text>
      ) : null}

      <View style={styles.divider}>
        <View style={styles.line} />
        <Text style={styles.or}>or</Text>
        <View style={styles.line} />
      </View>

      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        placeholder="email"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <TextInput
        style={[styles.input, { marginTop: 10 }]}
        value={password}
        onChangeText={setPassword}
        placeholder="password"
        placeholderTextColor="#6b7280"
        autoCapitalize="none"
        secureTextEntry
        onSubmitEditing={emailAuth}
      />

      {err ? <Text style={styles.err}>{err}</Text> : null}

      <TouchableOpacity
        style={styles.primary}
        onPress={emailAuth}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.primaryTxt}>
            {mode === "signup" ? "Create account" : "Sign in"}
          </Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => {
          setErr("");
          setMode((m) => (m === "signin" ? "signup" : "signin"));
        }}
      >
        <Text style={styles.toggle}>
          {mode === "signin"
            ? "No account? Create one"
            : "Have an account? Sign in"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => navigation.goBack()}>
        <Text style={styles.skip}>Skip — keep recordings on this phone</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f1115",
    padding: 28,
    justifyContent: "center",
  },
  brand: { alignItems: "center", marginBottom: 40 },
  logo: {
    width: 84,
    height: 84,
    borderRadius: 24,
    backgroundColor: "#3b82f6",
    alignItems: "center",
    justifyContent: "center",
  },
  appName: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "800",
    marginTop: 18,
  },
  tagline: { color: "#9aa0a6", fontSize: 14, marginTop: 6 },
  googleBtn: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  googleTxt: { color: "#1f1f1f", fontSize: 16, fontWeight: "600" },
  disabled: { opacity: 0.45 },
  note: { color: "#6b7280", fontSize: 11, marginTop: 8, lineHeight: 16 },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 22,
    gap: 12,
  },
  line: { flex: 1, height: 1, backgroundColor: "#23262d" },
  or: { color: "#6b7280", fontSize: 13 },
  input: {
    backgroundColor: "#1a1d23",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  err: { color: "#f87171", fontSize: 12, marginTop: 12 },
  primary: {
    backgroundColor: "#3b82f6",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    marginTop: 18,
  },
  primaryTxt: { color: "#fff", fontSize: 16, fontWeight: "700" },
  toggle: {
    color: "#3b82f6",
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
    marginTop: 20,
  },
  skip: {
    color: "#6b7280",
    fontSize: 13,
    textAlign: "center",
    marginTop: 18,
  },
});
