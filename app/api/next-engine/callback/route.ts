import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { getNextEngineAppConfiguration } from "@/lib/listing/nextEngine/appConfiguration";
import { exchangeNextEngineLaunch } from "@/lib/listing/nextEngine/authExchange";
import { configuredNextEngineOrigin, createNextEngineCallbackHandlers } from "@/lib/listing/nextEngine/callbackHandler";
import { completeNextEngineLaunch } from "@/lib/listing/nextEngine/completeLaunch";
import { readNextEngineTokens, saveNextEngineTokens } from "@/lib/listing/nextEngine/tokenStore";

export const dynamic = "force-dynamic";

const handlers = createNextEngineCallbackHandlers({
  origin: configuredNextEngineOrigin,
  isAdmin: async () => (await getInventoryRole()) === "ADMIN",
  configuration: getNextEngineAppConfiguration,
  complete: completeNextEngineLaunch,
  preflight: readNextEngineTokens,
  exchange: exchangeNextEngineLaunch,
  save: saveNextEngineTokens,
  readBack: readNextEngineTokens,
});

export async function GET(request: Request) { return handlers.GET(request); }
export async function POST(request: Request) { return handlers.POST(request); }
