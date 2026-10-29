/** Dispatch preserves both categories and location until explicit arrival confirmation. */
export function preservesOutboundClassification(value:{templateType?:string;arrivalWorkflow?:string}|null|undefined):boolean {
  return !!value;
}

export const PRESERVED_CLASSIFICATION_NOTICE='出庫時はカテゴリ・保管場所を変更しません。到着後の「確認」で移動予定だけを外し、保管場所を変更します。他のカテゴリは維持します。';
