import { type ClientSchema, a, defineData } from "@aws-amplify/backend";

/**
 * Data model for the BASE feature-page generator.
 *
 * Design rule (per spec §6): BASE is the system of record for price,
 * stock, title, images, and visibility. This schema never duplicates
 * that data onto a Feature — a FeatureItem is just an ordered pointer
 * (`baseItemId`) into BASE's catalog. `BaseItemCache` is a read-through
 * cache kept warm by admin-authenticated actions (see its own comment
 * below for why that's also an auth-boundary decision, not just a perf
 * one), and `BaseOAuthToken` holds this shop's connected-app credentials.
 */
const schema = a.schema({
  TemplateType: a.enum(["COLLECTION", "BRAND", "FEATURE"]),
  FeatureStatus: a.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),

  // Structured AI-generated copy, kept as one JSON blob per feature so
  // individual sections (headline / intro / color variation copy / CTA…)
  // can be regenerated independently without a schema migration each time
  // the copy sections evolve. Shape (informal, enforced in lib/ai/types.ts):
  //   {
  //     headline: string
  //     intro: string
  //     productGroupNotes: string        // 商品群の特徴
  //     differenceNotes: string          // 商品同士の違い
  //     colorVariationNotes?: string      // カラー・仕様紹介
  //     stylingSuggestion: string        // コーディネート提案
  //     ctaText: string
  //   }
  Feature: a
    .model({
      title: a.string().required(),
      slug: a.string().required(),
      status: a.ref("FeatureStatus").required(),
      templateType: a.ref("TemplateType").required(),
      content: a.json(),
      seoTitle: a.string(),
      seoDescription: a.string(),
      heroBaseItemId: a.string(), // which selected item's image anchors the HERO
      publishedAt: a.datetime(),
      archivedAt: a.datetime(),
      items: a.hasMany("FeatureItem", "featureId"),
    })
    .secondaryIndexes((index) => [index("slug")])
    .authorization((allow) => [
      allow.group("Admins"),
      // Public visitors only ever need read access, and only for pages the
      // admin explicitly published. The public route (app/features/[slug])
      // enforces `status === "PUBLISHED"` in its query — Amplify Data does
      // not support row-level conditions on a public API-key rule, so this
      // is a deliberate application-layer check, not a data-layer one.
      allow.publicApiKey().to(["read"]),
    ]),

  FeatureItem: a
    .model({
      featureId: a.id().required(),
      feature: a.belongsTo("Feature", "featureId"),
      baseItemId: a.string().required(),
      sortOrder: a.integer().required(),
      isVisible: a.boolean().default(true),
    })
    .authorization((allow) => [
      allow.group("Admins"),
      allow.publicApiKey().to(["read"]),
    ]),

  // Read-through cache of BASE product data. Written only by admin-authenticated
  // code paths (search/generate/edit all fetch live BASE data already —
  // see lib/features/baseSync.ts) and read by the PUBLIC feature page. This
  // is deliberate, not just a perf optimization: it means the public route
  // never needs a BASE access token, so that credential never has to be
  // reachable from an unauthenticated request. A dedicated periodic sync
  // job (Phase 2) can refresh this on a schedule instead of only on admin
  // touch, but the auth boundary this creates is Phase 1.
  BaseItemCache: a
    .model({
      baseItemId: a.string().required(),
      title: a.string(),
      price: a.integer(),
      stock: a.integer(),
      isPublished: a.boolean(),
      imageUrls: a.string().array(),
      itemUrl: a.string(),
      brand: a.string(),
      variationLabel: a.string(), // e.g. color name, only if BASE provides one
      cachedAt: a.datetime().required(),
    })
    .identifier(["baseItemId"])
    .authorization((allow) => [
      allow.group("Admins"),
      allow.publicApiKey().to(["read"]),
    ]),

  // BASE OAuth2 tokens for this shop's connected app. Admins-only, no
  // public rule at all — unlike the models above, this is a credential,
  // not display data. There is exactly one row (id: "singleton"). Written
  // by the OAuth callback route (has the connecting admin's session) and
  // refreshed by lib/base/oauth.ts, always from an admin-authenticated
  // request context (see BaseItemCache comment above for why that's true
  // of every caller of the BASE API client in this system).
  BaseOAuthToken: a
    .model({
      accessToken: a.string().required(),
      refreshToken: a.string().required(),
      expiresAt: a.datetime().required(),
      updatedAt: a.datetime().required(),
    })
    .authorization((allow) => [allow.group("Admins")]),
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "apiKey",
    apiKeyAuthorizationMode: { expiresInDays: 30 },
  },
});
