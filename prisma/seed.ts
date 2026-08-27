import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.shippingTemplate.upsert({
    where: { id: "seed-kazaibin-a" },
    update: {},
    create: {
      id: "seed-kazaibin-a",
      name: "家財便Aランク",
      type: "KAZAIBIN",
    },
  });
  await prisma.shippingTemplate.upsert({
    where: { id: "seed-kazaibin-b" },
    update: {},
    create: {
      id: "seed-kazaibin-b",
      name: "家財便Bランク",
      type: "KAZAIBIN",
    },
  });
  await prisma.shippingTemplate.upsert({
    where: { id: "seed-sagawa-220" },
    update: {},
    create: {
      id: "seed-sagawa-220",
      name: "佐川220サイズ",
      type: "TAKKYUBIN",
    },
  });
  await prisma.shippingTemplate.upsert({
    where: { id: "seed-free-shipping" },
    update: {},
    create: {
      id: "seed-free-shipping",
      name: "全国送料無料",
      type: "FREE_SHIPPING",
      isDefault: true,
    },
  });
  await prisma.shippingTemplate.upsert({
    where: { id: "seed-pickup" },
    update: {},
    create: {
      id: "seed-pickup",
      name: "直接引取",
      type: "PICKUP",
    },
  });

  await prisma.descriptionTemplate.upsert({
    where: { id: "seed-furniture-default" },
    update: {},
    create: {
      id: "seed-furniture-default",
      name: "家具標準テンプレート",
      isDefault: true,
      body: [
        "【商品について】",
        "",
        "【サイズ】",
        "",
        "【商品の状態】",
        "",
        "【配送について】",
        "",
        "【注意事項】",
        "",
      ].join("\n"),
    },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
