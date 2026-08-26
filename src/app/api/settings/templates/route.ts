import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { z } from "zod";
import {
  createDescriptionTemplate,
  listDescriptionTemplates,
} from "@/domain/services/DescriptionTemplateService";

const schema = z.object({
  name: z.string().trim().min(1),
  body: z.string().trim().min(1),
  isDefault: z.boolean().optional(),
});

export async function GET() {
  const templates = await listDescriptionTemplates();
  return NextResponse.json({ templates });
}

export async function POST(req: NextRequest) {
  try {
    const input = schema.parse(await req.json());
    const template = await createDescriptionTemplate(input);
    return NextResponse.json({ template }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
