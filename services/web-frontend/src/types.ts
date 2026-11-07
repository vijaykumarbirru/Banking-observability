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
