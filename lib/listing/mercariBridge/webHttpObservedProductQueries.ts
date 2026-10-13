// Exact GraphQL documents observed in the owner-provided HAR on 2026-10-13.
// Only documents are retained; no variables, identifiers, cookies or tokens.

export const VALIDATE_PRODUCT_QUERY = `mutation ValidateProductInfo($input: ValidateProductInfoInput!) {
  validateProductInfo(validateProductInfoInput: $input) {
    result
    __typename
  }
}`;

export const CREATE_PRODUCT_QUERY = `mutation CreateProduct($input: CreateProductInput!, $idempotencyKeySeed: Float!) {
  createProduct(
    createProductInput: $input
    idempotencyKeySeed: $idempotencyKeySeed
  ) {
    id
    __typename
  }
}`;

export const UPDATE_PRODUCT_QUERY = `mutation UpdateProductV2($input: UpdateProductInput!, $idempotencyKeySeed: Float!) {
  updateProductV2(
    updateProductInput: $input
    idempotencyKeySeed: $idempotencyKeySeed
  ) {
    ...ProductListItem
    __typename
  }
}

fragment ProductListItem on Product {
  id
  name
  price
  likesCount
  viewCount
  variants {
    quantity
    restockSubscriptionsCount {
      count
      __typename
    }
    __typename
  }
  status {
    id
    name
    __typename
  }
  inStock
  shippingPayerType {
    id
    name
    __typename
  }
  assets {
    id
    imageUrl(options: {presets: [Small]})
    __typename
  }
  thumbnails {
    id
    imageUrl(options: {presets: [Small]})
    __typename
  }
  createdAt
  updatedAt
  preOrder {
    __typename
    acceptancePeriod {
      from
      to
      __typename
    }
    releaseDate
  }
  isRefurbished
  orderType
  channelListingScope
  tenants {
    tenant
    __typename
  }
  __typename
}`;

export const READ_PRODUCT_QUERY = `query EditProductPage($id: String!) {
  ownShops {
    ...OwnShop
    createdAt
    __typename
  }
  productOrders(productId: $id) {
    id
    status
    __typename
  }
  shopProduct(id: $id) {
    ... on Product {
      id
      name
      createdAt
      description
      snapshotId
      inStock
      shop {
        id
        __typename
      }
      status {
        id
        name
        __typename
      }
      price
      condition {
        id
        name
        __typename
      }
      brands {
        id
        name
        __typename
      }
      categories {
        category {
          id
          name
          mercariCategoryId
          __typename
        }
        __typename
      }
      thumbnails {
        id
        imageUrl(options: {presets: [Large]})
        contentType
        __typename
      }
      variants {
        ...Variant
        optionTypes {
          ...OptionType
          __typename
        }
        attributes {
          id
          title
          required
          type
          flags
          options {
            id
            title
            legacyId
            __typename
          }
          inputValue
          __typename
        }
        __typename
      }
      shippingMethodType {
        id
        name
        __typename
      }
      shippingPayerType {
        id
        name
        __typename
      }
      shippingDurationType {
        id
        name
        __typename
      }
      shippingFromState {
        id
        name
        __typename
      }
      currentDualPrice {
        originalPrice
        __typename
      }
      shippingConfiguration {
        id
        __typename
      }
      mercaribinForBusinessSetting {
        id
        mercaribinForBusinessCoolType {
          id
          name
          __typename
        }
        mercaribinForBusinessShippingFeeType {
          id
          name
          __typename
        }
        __typename
      }
      preOrder {
        releaseDate
        acceptancePeriod {
          from
          to
          __typename
        }
        cancellationDeadline
        deliveryTiming
        __typename
      }
      orderType
      isRefurbished
      channelListingScope
      auction {
        duration
        __typename
      }
      __typename
    }
    countryRestrictionTemplateId
    __typename
  }
}

fragment OwnShop on Shop {
  id
  shopProductsStatus
  shopStatus
  applicationComprehensiveStatus
  businessKind
  isSellingRestricted
  ordersCount(status: STATUS_WAITING_SHIPPING)
  permissions
  __typename
}

fragment Variant on Variant {
  id
  name
  quantity
  stockSnapshotId
  skuCode
  janCode
  catalogSkuId
  maxQuantityPerOrderConfig {
    configuredValue
    actualValue
    __typename
  }
  __typename
}

fragment OptionType on OptionType {
  id
  name
  options {
    id
    name
    __typename
  }
  __typename
}`;
