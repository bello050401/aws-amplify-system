import {selectableLocations} from "@/lib/inventory/locationChoices";
import { buildSearchFieldDefs } from "@/lib/inventory/advancedSearch";
import { mobileSearchFields } from "@/mobile/src/domain/search";
import { NextResponse } from "next/server";
import { getMobileSession } from "@/lib/mobile/session";
import { listCategories, listLocations, listStatuses, listCustomFieldDefinitions } from "@/lib/inventory/queries";
export const dynamic = "force-dynamic";
export async function GET() {
  const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
  const session = await getMobileSession();
  if (!session.ok) return NextResponse.json({error:session.error},{status:session.status,headers});
  try {
    const [categories, locations, statuses, customFields] = await Promise.all([listCategories(),listLocations(),listStatuses(),listCustomFieldDefinitions()]);
    return NextResponse.json({owner:session.owner, searchFields:mobileSearchFields(buildSearchFieldDefs(customFields,{categories,locations,statuses}),session.features), categories:categories.map(x=>x.name), locations:selectableLocations(locations).map(x=>x.name), statuses:statuses.map(x=>({id:x.id,label:x.label}))},{headers});
  } catch { return NextResponse.json({error:"UNAVAILABLE"},{status:503,headers}); }
}
