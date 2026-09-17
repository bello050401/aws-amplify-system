/**
 * 会話全体から、人による家具・照明選びの相談が約束されているかを判定する。
 * 後続メッセージが配送等の別件でも、過去の相談依頼を消さないため履歴も見る。
 */
export interface HumanHandoffEvidence {
  required: boolean;
  reasons: string[];
  carriedOverFromHistory: boolean;
}

const CONSULTATION_SIGNALS: { label: string; pattern: RegExp }[] = [
  { label: "空間全体の相談", pattern: /空間全体|部屋全体|お部屋全体/ },
  { label: "家具と照明の選定", pattern: /家具.{0,8}(照明|ライト)|照明.{0,8}家具/ },
  { label: "リビング・ダイニングの相談", pattern: /リビング.{0,4}ダイニング|リビングダイニング|LDK/i },
  { label: "間取りを使った相談", pattern: /間取り|図面|平面図/ },
  { label: "配置・コーディネート相談", pattern: /配置.{0,8}(相談|提案|シミュレーション)|コーディネート|家具選び/ },
];

function reasonsIn(text: string): string[] {
  return CONSULTATION_SIGNALS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

export function detectHumanHandoff(input: {
  currentText: string;
  history: { direction: "INBOUND" | "OUTBOUND"; body: string }[];
}): HumanHandoffEvidence {
  const currentReasons = reasonsIn(input.currentText);
  const historyReasons = input.history.flatMap((message) => reasonsIn(message.body));
  const reasons = [...new Set([...currentReasons, ...historyReasons])];
  return {
    required: reasons.length > 0,
    reasons,
    carriedOverFromHistory: currentReasons.length === 0 && historyReasons.length > 0,
  };
}
