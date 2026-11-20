export function catalogMutation(action: 'create' | 'renew' | 'disable', label: string, id?: string) {
  if (action === 'disable') return { action, id };
  if (action === 'renew') return { action, id, expiresInDays: 90 };
  return { action, label: label.trim() || '取引先共有', title: 'BELLO 商品カタログ', expiresInDays: 90 };
}
