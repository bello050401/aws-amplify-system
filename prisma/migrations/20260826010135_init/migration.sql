-- CreateEnum
CREATE TYPE "ProductConditionCode" AS ENUM ('NEW', 'LIKE_NEW', 'NO_NOTABLE_DAMAGE', 'SLIGHT_DAMAGE', 'DAMAGE', 'BAD');

-- CreateEnum
CREATE TYPE "ProductInternalStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED', 'SOLD_OUT', 'HIDDEN', 'ERROR');

-- CreateEnum
CREATE TYPE "ShippingPayerCode" AS ENUM ('SELLER', 'BUYER');

-- CreateEnum
CREATE TYPE "ShippingTemplateType" AS ENUM ('KAZAIBIN', 'TAKKYUBIN', 'FREE_SHIPPING', 'PICKUP', 'OTHER');

-- CreateEnum
CREATE TYPE "IntegrationChannel" AS ENUM ('MERCARI_SHOPS');

-- CreateEnum
CREATE TYPE "IntegrationOperation" AS ENUM ('CREATE', 'UPDATE', 'SYNC', 'CLOSE');

-- CreateEnum
CREATE TYPE "IntegrationJobStatus" AS ENUM ('WAITING', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "condition" "ProductConditionCode" NOT NULL,
    "internalStatus" "ProductInternalStatus" NOT NULL DEFAULT 'DRAFT',
    "janCode" TEXT,
    "catalogId" TEXT,
    "categoryMappingId" TEXT,
    "brandMappingId" TEXT,
    "shippingPayer" "ShippingPayerCode" NOT NULL DEFAULT 'SELLER',
    "shippingFromStateId" TEXT,
    "shippingDurationCode" TEXT,
    "shippingTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "skuCode" TEXT NOT NULL,
    "stockQuantity" INTEGER NOT NULL DEFAULT 1,
    "optionLabel" TEXT,
    "optionValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryMapping" (
    "id" TEXT NOT NULL,
    "mercariCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentMercariId" TEXT,
    "isLeaf" BOOLEAN NOT NULL DEFAULT false,
    "path" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryFavorite" (
    "id" TEXT NOT NULL,
    "categoryMappingId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CategoryFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandMapping" (
    "id" TEXT NOT NULL,
    "mercariBrandId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BrandMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DescriptionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DescriptionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ShippingTemplateType" NOT NULL,
    "mercariShippingConfigurationId" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShippingTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShippingTemplateRate" (
    "id" TEXT NOT NULL,
    "shippingTemplateId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,

    CONSTRAINT "ShippingTemplateRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MercariListing" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "mercariProductId" TEXT,
    "mercariStatus" TEXT,
    "environment" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MercariListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationJob" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "channel" "IntegrationChannel" NOT NULL DEFAULT 'MERCARI_SHOPS',
    "operation" "IntegrationOperation" NOT NULL,
    "status" "IntegrationJobStatus" NOT NULL DEFAULT 'WAITING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "operation" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");

-- CreateIndex
CREATE INDEX "Product_internalStatus_idx" ON "Product"("internalStatus");

-- CreateIndex
CREATE INDEX "Product_createdAt_idx" ON "Product"("createdAt");

-- CreateIndex
CREATE INDEX "ProductImage_productId_sortOrder_idx" ON "ProductImage"("productId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_skuCode_key" ON "ProductVariant"("skuCode");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryMapping_mercariCategoryId_key" ON "CategoryMapping"("mercariCategoryId");

-- CreateIndex
CREATE INDEX "CategoryMapping_parentMercariId_idx" ON "CategoryMapping"("parentMercariId");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryFavorite_categoryMappingId_key" ON "CategoryFavorite"("categoryMappingId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandMapping_mercariBrandId_key" ON "BrandMapping"("mercariBrandId");

-- CreateIndex
CREATE INDEX "BrandMapping_name_idx" ON "BrandMapping"("name");

-- CreateIndex
CREATE INDEX "ShippingTemplate_type_idx" ON "ShippingTemplate"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingTemplateRate_shippingTemplateId_destination_key" ON "ShippingTemplateRate"("shippingTemplateId", "destination");

-- CreateIndex
CREATE UNIQUE INDEX "MercariListing_productId_key" ON "MercariListing"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "MercariListing_mercariProductId_key" ON "MercariListing"("mercariProductId");

-- CreateIndex
CREATE INDEX "IntegrationJob_status_idx" ON "IntegrationJob"("status");

-- CreateIndex
CREATE INDEX "IntegrationJob_productId_idx" ON "IntegrationJob"("productId");

-- CreateIndex
CREATE INDEX "IntegrationLog_productId_createdAt_idx" ON "IntegrationLog"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryMappingId_fkey" FOREIGN KEY ("categoryMappingId") REFERENCES "CategoryMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_brandMappingId_fkey" FOREIGN KEY ("brandMappingId") REFERENCES "BrandMapping"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shippingTemplateId_fkey" FOREIGN KEY ("shippingTemplateId") REFERENCES "ShippingTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryFavorite" ADD CONSTRAINT "CategoryFavorite_categoryMappingId_fkey" FOREIGN KEY ("categoryMappingId") REFERENCES "CategoryMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingTemplateRate" ADD CONSTRAINT "ShippingTemplateRate_shippingTemplateId_fkey" FOREIGN KEY ("shippingTemplateId") REFERENCES "ShippingTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MercariListing" ADD CONSTRAINT "MercariListing_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationJob" ADD CONSTRAINT "IntegrationJob_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationLog" ADD CONSTRAINT "IntegrationLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
