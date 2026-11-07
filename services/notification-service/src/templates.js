// Turns a domain event into the simulated SMS / e-mail a customer would receive.
// Returns null for events that do not notify the customer.
const rupees = (paise) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const maskAccount = (accountNo) => (accountNo ? 'XX' + String(accountNo).slice(-4) : '');
const sms = (message, sensitive) => ({ channel: 'SMS', message: `VijayBank: ${message}`, sensitive });

const REASONS = {
  BENEFICIARY_ACCOUNT_INVALID: 'beneficiary account invalid at destination bank',
  NETWORK_TIMEOUT: 'network timeout',
};

function otpMessage(d) {
  const validity = `Valid for ${Math.round((d.expiresInSeconds ?? 300) / 60)} minutes. Never share your OTP with anyone.`;
  switch (d.purpose) {
    case 'TRANSFER':
      return `${d.otp} is your OTP to transfer ${rupees(d.amountPaise)} to ${d.beneficiaryName} (${d.accountNoMasked}) via ${d.mode}. ${validity}`;
    case 'BENEFICIARY':
      return `${d.otp} is your OTP to add ${d.beneficiaryName} (${d.accountNoMasked}, ${d.bankName}) as a beneficiary. ${validity}`;
    default:
      return `${d.otp} is your OTP to log in to net banking. ${validity}`;
  }
}

export function render(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'auth.otp.requested':
      return sms(otpMessage(d), d.otp);
    case 'auth.account.locked':
      return sms('Your net banking login was locked after multiple failed attempts. If this was not you, call customer care immediately.');
    case 'beneficiary.added':
      return sms(`${d.beneficiaryName} (${d.accountNoMasked}, ${d.bankName}) was added as a beneficiary. You can send money after ${d.coolingMinutes} minutes. Not you? Call customer care.`);
    case 'transfer.completed':
      return sms(`${rupees(d.amountPaise)} debited from A/c ${maskAccount(d.fromAccountNo)} to ${d.beneficiaryName}. Ref ${d.reference}.`);
    case 'transfer.credited':
      return sms(`${rupees(d.amountPaise)} credited to A/c ${d.toAccountNoMasked} from A/c ${d.fromAccountNoMasked}. Ref ${d.reference}.`);
    case 'transfer.debited':
      return sms(`${rupees(d.amountPaise)} debited from A/c ${maskAccount(d.fromAccountNo)} for ${d.mode} transfer to ${d.beneficiaryName}. Ref ${d.reference}. Status: processing.`);
    case 'transfer.settled':
      return sms(`${d.mode} transfer of ${rupees(d.amountPaise)} to ${d.beneficiaryName} is successful. Ref ${d.reference}.`);
    case 'transfer.failed':
      return sms(`${d.mode} transfer of ${rupees(d.amountPaise)} to ${d.beneficiaryName} failed (${REASONS[d.reason] ?? 'declined'}). The amount has been credited back to A/c ${maskAccount(d.fromAccountNo)}. Ref ${d.reference}.`);
    case 'transfer.blocked':
      return sms(`We stopped a transfer of ${rupees(d.amountPaise)} to ${d.beneficiaryName} to protect your account. If it was you, please call customer care. Ref ${d.reference}.`);
    default:
      return null;
  }
}

/** The stored history never shows OTP digits again. */
export function mask(message, sensitive) {
  return sensitive ? message.replaceAll(sensitive, '******') : message;
}
