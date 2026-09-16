import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Session-scoped GPT desktop worker bridge. It is NOT an always-on GPT service.
 * Request files live outside the implementation worktree. Tokens authorize only
 * one run/phase/artifact response and can never authorize a production action.
 */
export class DesktopQaBridge {
  constructor({ directory, verifyDeployment, now = () => Date.now() }) {
    this.directory = directory;
    this.verifyDeployment = verifyDeployment;
    this.now = now;
    fs.mkdirSync(directory, { recursive: true });
  }
  adapter(phase) {
    const files = (key) => {
      if (!/^[a-f0-9]{64}$/.test(key)) throw Error("Invalid operation key");
      return {
        request: path.join(this.directory, key + ".request.json"),
        response: path.join(this.directory, key + ".response.json"),
      };
    };
    return {
      reconcile: async ({ run, operationKey }) => {
        const f = files(operationKey);
        if (!fs.existsSync(f.request)) return { status: "absent" };
        const request = JSON.parse(fs.readFileSync(f.request, "utf8"));
        if (request.expiresAt < this.now())
          return {
            status: "auth",
            reason: "Desktop QA worker session expired",
          };
        if (!fs.existsSync(f.response)) return { status: "pending" };
        const response = JSON.parse(fs.readFileSync(f.response, "utf8"));
        const expected = crypto
          .createHash("sha256")
          .update(request.token)
          .digest();
        const actual = crypto
          .createHash("sha256")
          .update(String(response.token || ""))
          .digest();
        if (
          !crypto.timingSafeEqual(expected, actual) ||
          request.runId !== run.id ||
          request.phase !== phase ||
          response.operationKey !== operationKey
        )
          return {
            status: "blocked",
            reason: "QA worker response authorization mismatch",
          };
        if (phase === "qaVerify" && !(await this.verifyDeployment(run)))
          return {
            status: "blocked",
            reason: "Published build changed during QA",
          };
        return {
          status: "succeeded",
          artifact: response.artifact,
          currentRevision: run.headSHA,
        };
      },
      execute: async ({ run, operationKey }) => {
        if (phase === "qaVerify" && !(await this.verifyDeployment(run)))
          return {
            status: "blocked",
            reason: "Cannot verify published build before QA",
          };
        const f = files(operationKey);
        if (!fs.existsSync(f.request)) {
          fs.writeFileSync(
            f.request,
            JSON.stringify(
              {
                phase,
                operationKey,
                token: crypto.randomBytes(32).toString("hex"),
                expiresAt: this.now() + 600000,
                runId: run.id,
                revision: run.revision,
                acIds: run.acIds,
                url: run.configSnapshot.qaUrl,
                specId: run.specId,
                initialQaId: run.initialQaId,
                headSHA: run.headSHA,
                deployment: run.deployment,
              },
              null,
              2,
            ),
            { flag: "wx" },
          );
        }
        return { status: "pending" };
      },
    };
  }
}
