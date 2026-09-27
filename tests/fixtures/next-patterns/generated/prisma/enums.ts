export const SellerStatus = {
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  ACTIVE: 'ACTIVE',
} as const;

export type SellerStatus = (typeof SellerStatus)[keyof typeof SellerStatus];
