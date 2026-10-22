/** Kawagoe keeps the current categories and location, including split stock. */
export function preservesOutboundClassification(value:{templateType?:string}|null|undefined):boolean {
  return value?.templateType==='KAWAGOE_V1';
}

export const PRESERVED_CLASSIFICATION_NOTICE='出庫後もカテゴリ・保管場所は変更しません。一部数量の出庫では商品ページを分割し、どちらにも出庫前のカテゴリ・保管場所を引き継ぎます。';
