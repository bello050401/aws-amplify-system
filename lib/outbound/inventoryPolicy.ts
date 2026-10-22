/** All dispatches preserve classification; only manual arrival changes it. */
export function preservesOutboundClassification(value:{templateType?:string;arrivalWorkflow?:string}|null|undefined):boolean {
  return !!value;
}

export const PRESERVED_CLASSIFICATION_NOTICE='出庫時はカテゴリ・保管場所を維持します。数量分割は行います。到着後、出庫履歴から在庫情報を変更してください。';
