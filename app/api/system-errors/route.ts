import { getVerifiedInventoryAccess } from "@/lib/amplify/requireInventoryUser";
import { handleSystemErrorPost } from "@/lib/systemErrors/intake";
import { getSystemErrorQueue } from "@/lib/systemErrors/server";
export const runtime = "nodejs";
export async function POST(request: Request) {
  return handleSystemErrorPost(request, {access: getVerifiedInventoryAccess, queue: getSystemErrorQueue});
}
