import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { reportMobileRuntimeError } from '../runtime/service';

export class SystemErrorBoundary extends React.Component<{children: React.ReactNode}, {failed: boolean; reported: boolean}> {
  state = { failed: false, reported: false };
  private active = true;
  private generation = 0;
  static getDerivedStateFromError() { return { failed: true, reported: false }; }
  componentDidCatch(error: Error) {
    const generation = ++this.generation;
    void Promise.resolve().then(() => reportMobileRuntimeError(error, 'UI_RENDER_FAILED')).then(reported => {
      if (this.active && this.generation === generation) this.setState({ reported });
    }).catch(() => { /* The fallback remains usable even if error reporting fails. */ });
  }
  componentWillUnmount() { this.active = false; this.generation++; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <View style={styles.screen}>
      <Text style={styles.title}>画面の表示中に問題が発生しました</Text>
      <Text style={styles.body}>通信を確認して再試行してください。</Text>
      {this.state.reported ? <Text accessibilityRole="status" style={styles.body}>エラーを修復受付へ送信しました。</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="再試行" style={styles.button} onPress={() => { this.generation++; this.setState({ failed: false, reported: false }); }}><Text style={styles.buttonText}>再試行</Text></Pressable>
    </View>;
  }
}
const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 18, backgroundColor: '#F8F6F1' },
  title: { fontSize: 20, fontWeight: '700', color: '#263D3C' }, body: { fontSize: 14, lineHeight: 22, color: '#53665D' },
  button: { minHeight: 48, borderRadius: 12, justifyContent: 'center', alignItems: 'center', backgroundColor: '#214C3C' }, buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
