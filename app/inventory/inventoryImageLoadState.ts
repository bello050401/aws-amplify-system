/**
 * 画像表示高速化・段階読込(P1) QA是正 — InventoryImageGallery.tsxの
 * 「メイン画像(small→medium)」「ライトボックス(original)」双方に
 * 共通する、Reactに依存しない純粋な状態遷移/描画方針ロジック。
 *
 * 【なぜ切り出したか】元の実装(2185e57)はheroUrl/fullUrlが「文字列に
 * なった時点」で即座に<img>へ表示していた——署名URL自体は取れても
 * ブラウザの実際の画像取得(本体)が失敗/まだ途中というケースを一切
 * 見ていなかった(onLoad/onErrorが無い)ため、①読み込み中の表示が
 * URL解決だけで消える、②本体失敗がfullFailedに反映されず再試行UIが
 * 出ない、という2つの不具合があった。これを直すには「本体の
 * 読み込み成否」を別途状態として持つ必要があるが、Reactの
 * useState/useEffectだけで書くと、選択中の画像を切り替えた直後に
 * 前の画像の遅延onLoad/onErrorが新しい選択へ誤反映する競合
 * (このモジュールのreduceBodyLoadStateが防ぐ)を素のuseStateでは
 * 表現しづらい。inventoryImageUrlResolver.tsと同じ方針で、Amplify/
 * DOMに一切依存しない部分だけをここへ切り出し、
 * scripts/verify-inventory-image-load-state.tsがReact/jsdom無しで
 * 直接検証できるようにする(このworktreeにnode_modulesが無い制約でも
 * 動く — qa-worktree-tooling-limitsメモリと同じ理由)。
 *
 * InventoryImageGallery.tsx自身はこのモジュールをそのままimportして
 * 使う(別実装を並行して持たない)ので、ここでのテストはコンポーネント
 * の実際の判定ロジックの境界試験になる。
 */

/**
 * 1枚の画像の「本体(バイト列)読み込み」状態。`key`は今この状態が
 * どの画像/どの派生(small/medium/original)を指しているかの識別子——
 * 呼び出し側は表示中の画像が切り替わるたびSELECTでこれを進める。
 * loaded/failedはその識別子に対してだけ有効で、SELECT以外のイベント
 * (LOADED/FAILED)はevent.keyが現在のkeyと一致しない限り無視される
 * (旧画像の遅延イベントが新しい選択へ反映しない、という完了条件)。
 */
export interface BodyLoadState {
  readonly key: string | null;
  readonly loaded: boolean;
  readonly failed: boolean;
}

export function initialBodyLoadState(key: string | null): BodyLoadState {
  return { key, loaded: false, failed: false };
}

export type BodyLoadEvent = { type: "SELECT"; key: string | null } | { type: "LOADED"; key: string } | { type: "FAILED"; key: string };

export function reduceBodyLoadState(state: BodyLoadState, event: BodyLoadEvent): BodyLoadState {
  if (event.type === "SELECT") {
    // 同じkeyへの再SELECTでも状態は必ずリセットする(呼び出し側が
    // 明示的にSELECTを発行するのは「これから新しく読み込む」時だけ
    // ——ライトボックスを閉じて同じ画像で開き直す場合も含む)。
    return initialBodyLoadState(event.key);
  }
  if (event.key !== state.key) return state; // stale — 現在の選択と一致しないイベントは捨てる
  if (event.type === "LOADED") return state.loaded ? state : { ...state, loaded: true };
  return state.failed ? state : { ...state, failed: true };
}

// ---------------------------------------------------------------------
// メイン画像(hero) — small(effectiveListThumbnailKey)を先に確定表示し、
// medium(mediumKeyがある場合のみ)は裏で読み込んでからonLoad成功時だけ
// 差し替える。表示中の<img>はどちらの段階でも同じ1枚のタグなので、
// small→medium切替時に画面が一瞬空白になることはない(mountSrcが
// 常にnon-nullを保つ)。
// ---------------------------------------------------------------------

export interface HeroStageInputs {
  /** effectiveListThumbnailKey(current)の署名結果。null=まだ未解決。 */
  readonly smallUrl: string | null;
  /** useInventoryImageUrl(smallKey)自体の解決失敗(署名/取得の失敗、3回リトライ済み)。 */
  readonly smallResolveFailed: boolean;
  readonly smallBody: BodyLoadState;
  /** mediumKeyが無い画像はそもそもこの段階が存在しない(smallがそのまま最終形)。 */
  readonly mediumUrl: string | null;
  readonly mediumBody: BodyLoadState;
}

export interface HeroRenderPlan {
  /** <img src>に渡すべきURL。nullは「まだ何も描画できない」——loading/failedのどちらかが必ずtrueになる。 */
  readonly mountSrc: string | null;
  /** trueの間は「読み込み中…」を(mountSrcがnon-nullでも)前面に出す——URL解決だけで消してはいけない、という完了条件そのもの。 */
  readonly showLoadingOverlay: boolean;
  /** small自体(=最後の安全網)の解決/本体のどちらかが失敗——placeholderへ切り替える。 */
  readonly showFailedPlaceholder: boolean;
}

export function planHeroRender(inputs: HeroStageInputs): HeroRenderPlan {
  const smallFailed = inputs.smallResolveFailed || inputs.smallBody.failed;
  if (smallFailed) {
    return { mountSrc: null, showLoadingOverlay: false, showFailedPlaceholder: true };
  }
  if (!inputs.smallUrl) {
    return { mountSrc: null, showLoadingOverlay: true, showFailedPlaceholder: false };
  }
  // mediumは「onLoadが実際に成功した場合だけ」採用する——署名(URL文字列)
  // が取れているだけでは不十分(本体失敗時はsmallを維持し続ける、という
  // 完了条件)。medium読み込み中/失敗は一切表に出さない——ユーザーには
  // 常にsmallが見えていて、置き換わるとしたら良くなる方向にだけ変わる。
  const useMedium = inputs.mediumUrl !== null && inputs.mediumBody.loaded;
  return {
    mountSrc: useMedium ? inputs.mediumUrl : inputs.smallUrl,
    // smallの実際の描画(onLoad)が終わるまでは、URLがあってもまだ
    // 「読み込み中」を出し続ける——これがURL解決だけで消えていた
    // 元の不具合の修正本体。
    showLoadingOverlay: !inputs.smallBody.loaded,
    showFailedPlaceholder: false,
  };
}

// ---------------------------------------------------------------------
// ライトボックス(original) — hero同様だが「medium」段階が無い代わりに
// 本体失敗時に再試行UIを出す(hero側は安全なplaceholderで十分だが、
// ライトボックスはユーザーが明示的に「原本を見る」操作をした結果な
// ので、失敗を隠さず再試行の手段を提示する)。
// ---------------------------------------------------------------------

export interface FullStageInputs {
  readonly fullUrl: string | null;
  readonly fullResolveFailed: boolean;
  readonly fullBody: BodyLoadState;
}

export interface FullRenderPlan {
  readonly mountSrc: string | null;
  readonly showLoadingOverlay: boolean;
  readonly showFailedRetry: boolean;
}

export function planFullRender(inputs: FullStageInputs): FullRenderPlan {
  const failed = inputs.fullResolveFailed || inputs.fullBody.failed;
  if (failed) {
    return { mountSrc: null, showLoadingOverlay: false, showFailedRetry: true };
  }
  if (!inputs.fullUrl) {
    return { mountSrc: null, showLoadingOverlay: true, showFailedRetry: false };
  }
  return { mountSrc: inputs.fullUrl, showLoadingOverlay: !inputs.fullBody.loaded, showFailedRetry: false };
}
