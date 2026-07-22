import { Component, ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { logEvent } from "./log";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** Catches render/runtime errors so one bad screen can't crash the whole app. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    logEvent(`BOUNDARY ${error.message}\n${String(error.stack).slice(0, 600)}`);
  }

  render() {
    if (this.state.error) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.msg}>{String(this.state.error.message)}</Text>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => this.setState({ error: null })}
          >
            <Text style={styles.btnTxt}>Go back</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f1115",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
  },
  title: { color: "#fff", fontSize: 20, fontWeight: "700" },
  msg: {
    color: "#9aa0a6",
    fontSize: 13,
    marginTop: 12,
    textAlign: "center",
    lineHeight: 19,
  },
  btn: {
    backgroundColor: "#3b82f6",
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 12,
    marginTop: 24,
  },
  btnTxt: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
