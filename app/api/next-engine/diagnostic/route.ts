import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { configuredNextEngineOrigin } from "@/lib/listing/nextEngine/callbackHandler";
import { createNextEngineDiagnosticHandler } from "@/lib/listing/nextEngine/diagnosticHandler";
import { runNextEngineDiagnosticProbe } from "@/lib/listing/nextEngine/diagnosticProbe";

export const dynamic = "force-dynamic";

const handler = createNextEngineDiagnosticHandler({
  enabled: () => process.env.NEXT_ENGINE_DIAGNOSTIC_ENABLED === "1",
  origin: configuredNextEngineOrigin,
  isAdmin: async () => (await getInventoryRole()) === "ADMIN",
  probe: async () => {
    const client = new SecretsManagerClient({ region: "us-west-2" });
    try { return await runNextEngineDiagnosticProbe(client, process.env); }
    finally { client.destroy(); }
  },
});

export async function POST(request: Request) { return handler.POST(request); }
export async function GET() { return handler.GET(); }
