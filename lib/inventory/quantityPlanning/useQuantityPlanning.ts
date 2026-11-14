import { useCallback, useEffect, useRef, useState } from "react";
import type {
  QuantityPlanningCalculationResult, QuantityPlanningConditions, QuantityPlanningReadResult,
  QuantityPlanningSaveRequest, QuantityPlanningSource,
} from "./contracts";
import type { QuantityPlan, QuantityPlanIssue } from "./types";
import { draftFromConditions, parseDraft, type QuantityPlanningDraft } from "./presentation";

export type QuantityPlanningPorts = {
  read: (id: string) => Promise<QuantityPlanningReadResult>;
  calculate: (id: string, conditions: QuantityPlanningConditions) => Promise<QuantityPlanningCalculationResult>;
  save: (id: string, request: QuantityPlanningSaveRequest) => Promise<QuantityPlanningReadResult>;
};

type Snapshot = Extract<QuantityPlanningReadResult, { status: "ok" }>;
type Proposal = {
  plan: QuantityPlan;
  fingerprint: string;
  logicVersion: string;
  settingsVersion: number;
  draft: QuantityPlanningDraft;
  saveRequest: QuantityPlanningSaveRequest | null;
};

export function useQuantityPlanning({ id, version, ports, enabled, canWrite, newOperationId }: {
  id: string;
  version?: string;
  ports: QuantityPlanningPorts;
  enabled: boolean;
  canWrite: boolean;
  newOperationId: () => string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [source, setSource] = useState<QuantityPlanningSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(draftFromConditions());
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [issues, setIssues] = useState<QuantityPlanIssue[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"calculate" | "save" | null>(null);
  const lock = useRef(false);
  const readSequence = useRef(0);

  const refresh = useCallback(async (reuseLatest = false, duringOperation = false) => {
    if (lock.current && !duringOperation) return;
    const sequence = ++readSequence.current;
    setLoading(true);
    setReadError("");
    try {
      const response = await ports.read(id);
      if (sequence !== readSequence.current) return;
      if (response.status !== "ok") {
        setReadError(response.message);
        return;
      }
      setSnapshot(response);
      setSource(response.source);
      if (reuseLatest) setDraft(draftFromConditions(response.latest?.conditions));
    } catch {
      if (sequence === readSequence.current) setReadError("適正数量の保存結果を取得できませんでした。");
    } finally {
      if (sequence === readSequence.current) setLoading(false);
    }
  }, [id, ports]);

  useEffect(() => {
    if (enabled) void refresh();
    return () => { readSequence.current++; };
  }, [enabled, refresh, version]);

  const sourceChanged = !!proposal && (proposal.fingerprint !== source?.fingerprint ||
    proposal.settingsVersion !== snapshot?.settingsVersion || proposal.logicVersion !== snapshot?.logicVersion);
  const inputsChanged = !!proposal && proposal.draft !== draft;
  const needsRecalculation = sourceChanged || inputsChanged || (!!proposal && proposal.saveRequest === null && !!snapshot?.canEdit && canWrite);
  const canSave = enabled && canWrite && !!snapshot?.canEdit && !!proposal?.saveRequest
    && !loading && !readError && !busy && !needsRecalculation;

  function begin() {
    if (lock.current || !enabled || !snapshot) return;
    setDraft(draftFromConditions(snapshot.latest?.conditions));
    setProposal(null);
    setIssues([]);
    setError("");
    setOpen(true);
    void refresh(true);
  }

  function close() {
    if (!lock.current) setOpen(false);
  }

  function change(values: Partial<QuantityPlanningDraft>) {
    if (lock.current) return;
    setDraft(current => ({ ...current, ...values }));
    setIssues([]);
    setError("");
  }

  async function calculate() {
    if (lock.current || !source || !enabled || loading) return false;
    const parsed = parseDraft(draft, source);
    setError("");
    setProposal(null);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return false;
    }
    lock.current = true;
    setBusy("calculate");
    setIssues([]);
    try {
      const response = await ports.calculate(id, parsed.conditions);
      if (response.status !== "ok") {
        setError(response.message);
        return false;
      }
      setSource(response.source);
      setSnapshot(current => current && {
        ...current, source: response.source, logicVersion: response.logicVersion, settingsVersion: response.settingsVersion,
        stale: !!current.latest && (current.stale || current.source.fingerprint !== response.source.fingerprint ||
          current.latest.settingsVersion !== response.settingsVersion || current.latest.logicVersion !== response.logicVersion),
      });
      if (!response.calculation.ok) {
        setIssues(response.calculation.issues);
        return false;
      }
      setProposal({
        plan: response.calculation.plan,
        fingerprint: response.source.fingerprint,
        logicVersion: response.logicVersion,
        settingsVersion: response.settingsVersion,
        draft,
        saveRequest: response.token ? { conditions: parsed.conditions, token: response.token, operationId: newOperationId() } : null,
      });
      return true;
    } catch {
      setError("計算結果を取得できませんでした。入力した条件で再試行できます。");
      return false;
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  async function save() {
    if (lock.current || !canSave || !proposal?.saveRequest) return;
    lock.current = true;
    setBusy("save");
    setError("");
    try {
      const response = await ports.save(id, proposal.saveRequest);
      if (response.status === "ok") {
        readSequence.current++;
        setLoading(false);
        setSnapshot(response);
        setSource(response.source);
        setOpen(false);
      } else {
        setError(response.message);
        if (response.status === "conflict" || response.status === "invalid" || response.status === "forbidden") {
          setProposal({ ...proposal, saveRequest: null });
          if (response.status === "conflict") await refresh(false, true);
        }
      }
    } catch {
      setError("計算結果を保存できませんでした。入力した条件で再試行できます。");
    } finally {
      lock.current = false;
      setBusy(null);
    }
  }

  return {
    snapshot, source, loading, readError, open, draft, plan: proposal?.plan ?? null,
    issues, error, busy, canSave, needsRecalculation, sourceChanged, inputsChanged, refresh, begin, close, change, calculate, save,
  };
}
