export type Account = {
  accountNo: string;
  maskedAccountNo: string;
  type: string;
  nickname: string | null;
  branch: string;
  ifsc: string;
  balancePaise: number | null;
};

export type Beneficiary = {
  beneficiaryId: string;
  name: string;
  nickname: string | null;
  accountNoMasked: string;
  ifsc: string;
  bankName: string;
  type: 'INTERNAL' | 'EXTERNAL';
  status: string;
  activatesAt: string | null;
  canReceive: boolean;
};

export type Transfer = {
  transferId: string;
  reference: string;
  mode: 'OWN' | 'INTRA' | 'IMPS' | 'NEFT' | 'RTGS';
  status: 'OTP_REQUIRED' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  failureReason: string | null;
  fromAccountNo: string;
  toAccountNoMasked: string;
  beneficiaryName: string;
  amountPaise: number;
  remarks: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type Entry = {
  id: number;
  reference: string;
  direction: 'DEBIT' | 'CREDIT';
  amountPaise: number;
  balanceAfterPaise: number;
  narration: string;
  postedAt: string;
};

export const MODE_LABEL: Record<Transfer['mode'], string> = {
  OWN: 'Own account',
  INTRA: 'VijayBank',
  IMPS: 'IMPS',
  NEFT: 'NEFT',
  RTGS: 'RTGS',
};

export const REASON_LABEL: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'Insufficient balance',
  FRAUD_SUSPECTED: 'Stopped by security checks',
  BENEFICIARY_ACCOUNT_INVALID: 'Rejected by beneficiary bank — amount reversed',
  NETWORK_TIMEOUT: 'Network timeout — amount reversed',
  DAILY_LIMIT_EXCEEDED: 'Daily limit exceeded',
  NEW_BENEFICIARY_LIMIT: 'New beneficiary limit exceeded',
  FRAUD_CHECK_UNAVAILABLE: 'Security check unavailable',
};

export type Biller = { id: string; name: string; category: string; label: string; pattern: string; recharge?: boolean };

export type BillPayment = {
  paymentId: string;
  reference: string;
  billerName: string;
  category: string;
  consumerNumber: string;
  amountPaise: number;
  status: string;
  failureReason: string | null;
  createdAt: string;
};

export type Controls = {
  atmLimitPaise: number;
  posLimitPaise: number;
  onlineLimitPaise: number;
  internationalEnabled: boolean;
  contactlessEnabled: boolean;
};

export type Card = {
  cardId: string;
  type: 'DEBIT' | 'CREDIT';
  variant: string;
  network: string;
  maskedNumber: string;
  holderName: string;
  expiry: string;
  accountNo: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'HOTLISTED';
  blockReason: string | null;
  controls: Controls;
  caps: Controls;
  creditLimitPaise: number | null;
  outstandingPaise: number | null;
  availableCreditPaise: number | null;
  minimumDuePaise: number | null;
  statementDueDate: string | null;
};

export type Deposit = {
  depositId: string;
  fdNo: string;
  fundingAccountNo: string;
  principalPaise: number;
  rateBps: number;
  tenureMonths: number;
  startDate: string;
  maturityDate: string;
  maturityAmountPaise: number;
  status: string;
  closedOn: string | null;
  payoutPaise: number | null;
};
