/** Money amount as Up reports it */
export type UpMoney = { currencyCode: string; value: string; valueInBaseUnits: number };

export type UpAccountType = 'SAVER' | 'TRANSACTIONAL' | 'HOME_LOAN';
export type UpOwnershipType = 'INDIVIDUAL' | 'JOINT';
export type UpTransactionStatus = 'HELD' | 'SETTLED';
export type UpWebhookEventType = 'TRANSACTION_CREATED' | 'TRANSACTION_SETTLED' | 'TRANSACTION_DELETED' | 'PING';
export type UpDeliveryStatus = 'DELIVERED' | 'UNDELIVERABLE' | 'BAD_RESPONSE_CODE';

export type MockAccount = {
  id: string;
  displayName: string;
  accountType: UpAccountType;
  ownershipType: UpOwnershipType;
  /** Base units (cents) of the account currency */
  balanceInBaseUnits: number;
  currencyCode: string;
  createdAt: string;
};

export type MockTransaction = {
  id: string;
  accountId: string;
  status: UpTransactionStatus;
  rawText: string | null;
  description: string;
  message: string | null;
  /** Signed base units: negative = money out */
  amountInBaseUnits: number;
  currencyCode: string;
  foreignAmount: { currencyCode: string; valueInBaseUnits: number } | null;
  transactionType: string | null;
  /** Counterparty account id for transfers between Up accounts */
  transferAccountId: string | null;
  categoryId: string | null;
  tags: string[];
  createdAt: string;
  settledAt: string | null;
};

export type MockWebhook = {
  id: string;
  url: string;
  description: string | null;
  secretKey: string;
  createdAt: string;
};

export type MockDelivery = {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: UpWebhookEventType;
  attempt: number;
  requestBody: string;
  responseStatus: number | null;
  responseBody: string | null;
  deliveryStatus: UpDeliveryStatus;
  createdAt: string;
};

export type MockEvent = {
  id: string;
  webhookId: string;
  eventType: UpWebhookEventType;
  transactionId: string | null;
  createdAt: string;
};
