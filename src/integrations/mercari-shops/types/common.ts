/** [UNVERIFIED] メルカリShops APIの共通型。docs/mercari-api.md参照。 */

export interface MercariCategory {
  id: string;
  name: string;
  parentId: string | null;
  hasChildren: boolean;
}

export interface MercariBrand {
  id: string;
  name: string;
}

export interface MercariShippingOption {
  code: string;
  label: string;
}

export interface GraphQLErrorItem {
  message: string;
  extensions?: {
    code?: string;
    [key: string]: unknown;
  };
}

export interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorItem[];
}
