import "server-only";
import { EconveniHttpError, type EconveniHttpSession } from "./httpSession";
import type { EconveniWorkflowStore } from "./workflowStore";

type Store = Pick<EconveniWorkflowStore, "acquire" | "release" | "stop">;
type Session = Pick<EconveniHttpSession, "login" | "dispose">;

/** All preflight reads, authentication and mutations share the same account lease.
 * Authentication failures before a write also stop the queue; making a fresh session
 * must never silently clear a CAPTCHA/access-denied stop.
 */
export async function withEconveniAccount<T>(
  store: Store,
  session: Session,
  credentials: () => Promise<{ loginId: string; password: string } | null>,
  operation: () => Promise<T>,
): Promise<T> {
  await store.acquire();
  try {
    const secret = await credentials();
    if (!secret) throw new EconveniHttpError("AUTH_REQUIRED");
    await session.login(secret);
    return await operation();
  } catch (error) {
    if (error instanceof EconveniHttpError &&
        ["AUTH_REQUIRED", "ACCESS_DENIED", "ADDITIONAL_AUTH"].includes(error.code)) {
      await store.stop(error.code as "AUTH_REQUIRED" | "ACCESS_DENIED" | "ADDITIONAL_AUTH");
    }
    throw error;
  } finally {
    session.dispose();
    await store.release();
  }
}
