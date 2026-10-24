/** Dispatch preserves location. Arrival remains an explicit confirmation. */
export function preservesOutboundClassification(value:{templateType?:string;arrivalWorkflow?:string}|null|undefined):boolean {
  return !!value;
}

export const PRESERVED_CLASSIFICATION_NOTICE='出庫分の移動予定だけを外します。他のカテゴリは維持し、保管場所は到着後の「確認」で変更します。';
