import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiHelpers";
import { z } from "zod";
import {
  deleteDescriptionTemplate,
  updateDescriptionTemplate,
} from "@/domain/services/DescriptionTemplateService";

const schema = z.object({
  name: z.string().trim().min(1),
  body: z.string().trim().min(1),
  isDefault: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = schema.parse(await req.json());
    const template = await updateDescriptionTemplate(id, input);
    return NextResponse.json({ template });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteDescriptionTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
