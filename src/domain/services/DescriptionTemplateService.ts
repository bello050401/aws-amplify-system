import { prisma } from "@/lib/prisma";

/** 商品説明テンプレート管理 (/settings/templates、指示書10項)。 */

export async function listDescriptionTemplates() {
  return prisma.descriptionTemplate.findMany({ orderBy: { createdAt: "desc" } });
}

export async function createDescriptionTemplate(input: {
  name: string;
  body: string;
  isDefault?: boolean;
}) {
  if (input.isDefault) {
    await prisma.descriptionTemplate.updateMany({ data: { isDefault: false }, where: {} });
  }
  return prisma.descriptionTemplate.create({
    data: { name: input.name, body: input.body, isDefault: input.isDefault ?? false },
  });
}

export async function updateDescriptionTemplate(
  id: string,
  input: { name: string; body: string; isDefault?: boolean },
) {
  if (input.isDefault) {
    await prisma.descriptionTemplate.updateMany({ data: { isDefault: false }, where: {} });
  }
  return prisma.descriptionTemplate.update({
    where: { id },
    data: { name: input.name, body: input.body, isDefault: input.isDefault ?? false },
  });
}

export async function deleteDescriptionTemplate(id: string) {
  await prisma.descriptionTemplate.delete({ where: { id } });
}
