import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { signIn, signOut, confirmSignIn, getCurrentUser } from "aws-amplify/auth";
import * as Network from "expo-network";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { API_ORIGIN, clearLocalSession, configureMobileAuth, readInventory, readInventoryThumbnails, readInventoryDetail, readInventoryOptions, uploadInventoryPhoto, readSales, readMobileSession, saveInventory, mobileWritesEnabled, StaffSessionError, type MobileSession } from "../runtime/service";
import { RESTRICTED_FEATURES } from "../domain/access";
import { SnapshotStore } from "../domain/snapshot";
import { StaffApp, type StaffAppPorts } from "./StaffApp";
import { removeInventory } from "../runtime/service";
import { colors } from "./theme";
import { loginErrorMessage, loginUsername, requestedLoginMode, type LoginMode } from "../domain/login";
import type { InventorySearchInput } from "../domain/search";

function connected(state: Network.NetworkState) { return state.isConnected !== false && state.isInternetReachable !== false; }
const loginModeKey = `bello.login-mode.${API_ORIGIN}`;
export function LiveApp() {
  const requestedMode = useRef(requestedLoginMode(typeof window === "undefined" ? "" : window.location?.search ?? "")).current;
  const [loginMode, setLoginMode] = useState<LoginMode>(requestedMode ?? "account");
  const [userId, setUserId] = useState<string | null>(null);
  const [access, setAccess] = useState<MobileSession | null>(null);
  // Retain local editing capability while offline; every actual write is reauthorized by BELLO.
  const [canEdit, setCanEdit] = useState(false);
  const [offline, setOffline] = useState(false);
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<"password" | "code" | null>(null); const [answer, setAnswer] = useState("");
  const [message, setMessage] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const setup = async () => {
    setMessage(null); setReady(false); setAccess(null); setCanEdit(false);
    try {
      const online = connected(await Network.getNetworkStateAsync()); setOffline(!online);
      await configureMobileAuth(online); if (!mounted.current) return;
      const rememberedMode = requestedMode ?? await AsyncStorage.getItem(loginModeKey).catch(() => null);
      if (!mounted.current) return;
      setLoginMode(rememberedMode === "staff" ? "staff" : "account");
      if (requestedMode) void AsyncStorage.setItem(loginModeKey, requestedMode).catch(() => {});
      setReady(true);
      const user = await getCurrentUser().catch(() => null);
      if (user && mounted.current) {
        // Online restoration must revalidate staff authorization with the server.
        if (online) { const session = await readMobileSession(); setAccess(session); setCanEdit(session.role !== "VIEWER"); }
        setUserId(user.userId);
      }
    } catch (error) { if (mounted.current) setMessage(error instanceof Error ? error.message : "接続できませんでした。"); }
  };
  useEffect(() => {
    mounted.current = true; void setup();
    const subscription = Network.addNetworkStateListener(state => setOffline(!connected(state)));
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  // No permission cache is reused offline or across accounts. Revalidate on reconnection.
  useEffect(() => {
    let active = true;
    if (!userId || offline) { setAccess(null); return; }
    // Setup/sign-in already verified this account. Avoid a second identical request at startup.
    // Going offline clears access above, so reconnecting still revalidates it.
    if (access?.owner === userId) return;
    void readMobileSession().then(session => {
      if (active && session.owner === userId) { setAccess(session); setCanEdit(session.role !== "VIEWER"); }
    }).catch(() => { if (active) { setAccess(null); setCanEdit(false); } });
    return () => { active = false; };
  }, [userId, offline]);
  const ports = useMemo<StaffAppPorts | null>(() => {
    if (!userId) return null;
    const snapshot = new SnapshotStore(AsyncStorage, userId, API_ORIGIN);
    const loadInventoryPage = async (input?: InventorySearchInput) => {
      try { return await readInventory(input); }
      catch (error) {
        // The paginated list must handle expired/revoked sessions too, not only the legacy loader.
        if (error instanceof StaffSessionError) {
          setAccess(null); setCanEdit(false);
          await snapshot.clearOnLogout();
          await signOut(); await clearLocalSession();
          setUserId(null); setMessage(error.message);
        }
        throw error;
      }
    };
    return {
    snapshot,
    online: async () => connected(await Network.getNetworkStateAsync()),
    loadInventory: async () => {
      try {
        const session = await readMobileSession();
        if (session.owner !== userId) throw new StaffSessionError("ログインが必要です。");
        setAccess(session);
        setCanEdit(session.role !== "VIEWER");
        return (await readInventory()).items;
      }
      catch (error) {
        setAccess(null);
        if (error instanceof StaffSessionError) {
          await snapshot.clearOnLogout();
          await signOut(); await clearLocalSession();
          setCanEdit(false); setUserId(null); setMessage(error.message);
        }
        throw error;
      }
    },
    newMutationId: () => Crypto.randomUUID(),
    searchInventory: loadInventoryPage,
    loadThumbnails: readInventoryThumbnails,
    loadDetail: readInventoryDetail,
    loadOptions: readInventoryOptions,
    uploadPhoto: uploadInventoryPhoto,
    loadSales: readSales,
    save: saveInventory,
    removeInventory,
  }; }, [userId]);

  const chooseLoginMode = (mode: LoginMode) => {
    if (busy) return;
    setLoginMode(mode); setPassword(""); setAnswer(""); setChallenge(null); setMessage(null);
    // Store only the chosen entrance, never a password or an authorization decision.
    void AsyncStorage.setItem(loginModeKey, mode).catch(() => setMessage("この端末にログイン方法を記憶できませんでした。ログインは続けられます。"));
  };
  const login = async () => {
    if (busy) return;
    setBusy(true); setMessage(null);
    try {
      if (!connected(await Network.getNetworkStateAsync())) { setMessage("【圏外です】"); return; }
      if (!challenge && ((loginMode === "account" && !email.trim()) || !password)) { setMessage(loginMode === "staff" ? "パスワードを入力してください。" : "ログインIDとパスワードを入力してください。"); return; }
      if (!challenge && password.length < 8) { setMessage("パスワードは8文字以上です。登録時のパスワードを入力してください。"); return; }
      if (!challenge) await signOut();
      const result = challenge ? await confirmSignIn({ challengeResponse: answer }) : await signIn({ username: loginUsername(loginMode, email), password });
      if (result.isSignedIn) {
        const session = await readMobileSession(); setAccess(session); setCanEdit(session.role !== "VIEWER");
        const user = await getCurrentUser(); setUserId(user.userId); setPassword(""); setAnswer(""); setChallenge(null);
      } else {
        const step = result.nextStep.signInStep;
        if (step === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") setChallenge("password");
        else if (["CONFIRM_SIGN_IN_WITH_SMS_CODE", "CONFIRM_SIGN_IN_WITH_TOTP_CODE", "CONFIRM_SIGN_IN_WITH_EMAIL_CODE"].includes(step)) setChallenge("code");
        else setMessage("追加の本人確認が必要です。管理者にログイン方法を確認してください。");
      }
    } catch (error) { setMessage(error instanceof StaffSessionError ? error.message : loginErrorMessage(error, loginMode)); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    setAccess(null); setCanEdit(false);
    try {
      await ports?.snapshot.clearOnLogout();
      await signOut(); await clearLocalSession();
      setUserId(null);
      await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]);
    } catch { setMessage("ログアウト処理を完了できませんでした。再試行してください。"); }
  };
  if (ports) return <StaffApp key={userId} ports={ports} offline={offline} onLogout={logout} writesEnabled={canEdit && mobileWritesEnabled()}
    features={!offline && access?.owner === userId ? access.features : RESTRICTED_FEATURES} />;
  return <View style={s.root}><Image source={require("../../assets/bello-system-icon.png")} style={s.brand} contentFit="contain" accessibilityLabel="Bello SYSTEM"/>
    {message && <Text accessibilityRole="alert" style={s.error}>{message}</Text>}
    {!ready ? <Pressable accessibilityRole="button" onPress={setup} style={s.button}><Text style={s.white}>接続を確認する</Text></Pressable> : <>
      {challenge ? <><Text style={s.label}>{challenge === "password" ? "新しいパスワード" : "確認コード"}</Text><TextInput accessibilityLabel={challenge === "password" ? "新しいパスワード" : "確認コード"} style={s.input} value={answer} onChangeText={setAnswer} secureTextEntry={challenge === "password"} autoCapitalize="none" /></> : <>
        {loginMode === "account" && <><Text style={s.label}>ログインID</Text><TextInput accessibilityLabel="ログインID" placeholder="スタッフ または メールアドレス" style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} autoComplete="username" /></>}
        <Text style={s.label}>パスワード</Text><TextInput accessibilityLabel="パスワード" style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" /></>}
      <Pressable accessibilityRole="button" disabled={busy} onPress={login} style={s.button}>{busy ? <ActivityIndicator color="white" /> : <Text style={s.white}>{challenge ? "確認する" : "ログイン"}</Text>}</Pressable>
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => chooseLoginMode(loginMode === "staff" ? "account" : "staff")} style={s.switchAccount}><Text style={s.switchText}>{loginMode === "staff" ? "別のアカウントでログイン" : "スタッフはこちら"}</Text></Pressable>
    </>}
  </View>;
}
const s = StyleSheet.create({ root: { flex: 1, justifyContent: "center", padding: 30, backgroundColor: "#F8F6F1" }, brand: { width: 112, height: 112, alignSelf: "center", borderRadius: 24, marginBottom: 30 }, label: { fontSize: 15, color: colors.muted, marginBottom: 8 }, input: { borderWidth: 1, borderColor: colors.border, backgroundColor: "white", borderRadius: 12, padding: 15, fontSize: 17, marginBottom: 20 }, button: { borderRadius: 16, backgroundColor: "#263D3C", padding: 17, alignItems: "center", marginTop: 10 }, white: { fontSize: 17, fontWeight: "600", color: "white" }, switchAccount: { minHeight: 44, justifyContent: "center", alignItems: "center", marginTop: 16 }, switchText: { fontSize: 14, color: "#526B63" }, error: { color: colors.danger, marginBottom: 20, lineHeight: 23 } });
