import {
  planWork,
  selectForWork,
  verifyEvaluationEvidence,
} from "./taskRouting.mjs";

/** GPT spec/QA workers are registered by the host for an exact model. Selection
 * never changes the desktop chat's model by pretending a prompt can do so.
 * Missing workers are explicit blockers. The chosen worker is pinned per
 * operation; retries cannot silently move an external operation to another one.
 */
export function routedGptWorker({
  repo,
  phase,
  baseline,
  workers,
  describeWork,
  capacityLimited = () => false,
}) {
  const read = (context) => {
    const row = repo.store.get(
      "SELECT data FROM checkpoints WHERE task_id=? AND phase=? ORDER BY id DESC LIMIT 1",
      [context.run.task_id, "gpt_route:" + context.operationKey],
    );
    return row ? JSON.parse(row.data) : null;
  };
  async function chosen(context) {
    const old = read(context);
    if (old) return old;
    if (capacityLimited())
      return {
        waiting: "WAITING_CAPACITY",
        reason: "GPT capacity unavailable; no alternate model bypass",
      };
    const input = await describeWork(context.run);
    const work = planWork({ ...input, phase });
    const decision = selectForWork({
      policy: context.run.configSnapshot.taskRouting,
      autoRouting: context.run.configSnapshot.modelAutoRouting,
      logicalFailures: context.run.logicalFailures || 0,
      work,
      baseline,
      roleProvider: "codex",
      available: (model) => !!workers[model.model],
      evidenceVerified: (model, category, ev) =>
        verifyEvaluationEvidence(repo.store, model, category, ev),
    });
    repo.checkpoint(
      context.run.task_id,
      "gpt_route:" + context.operationKey,
      decision,
    );
    return decision;
  }
  async function dispatch(method, context) {
    if (capacityLimited())
      return {
        status: "capacity",
        reason: "GPT usage limit; keep the selected model",
        effectCompleted: false,
      };
    const selection = await chosen(context);
    if (selection.waiting)
      return {
        status:
          selection.waiting === "WAITING_CAPACITY" ? "capacity" : "blocked",
        reason: selection.reason,
      };
    const worker = workers[selection.model];
    if (
      !worker ||
      selection.provider !== "codex" ||
      !worker.capabilities?.includes(selection.work.capability)
    )
      return {
        status: "blocked",
        reason: "Exact GPT model worker or capability is not connected",
      };
    return worker[method]({ ...context, selection });
  }
  return {
    reconcile: (context) => dispatch("reconcile", context),
    execute: (context) => dispatch("execute", context),
  };
}
