// Turns a domain event into the simulated SMS / e-mail a customer would receive.
// Returns null for events that do not notify the customer.
const rupees = (paise) =>
  '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function render(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case 'auth.otp.requested':
      return {
        channel: 'SMS',
        message: `VijayBank: ${d.otp} is your OTP to log in to net banking. Valid for ${Math.round(
          (d.expiresInSeconds ?? 300) / 60,
        )} minutes. Never share your OTP with anyone.`,
        sensitive: d.otp,
      };
    case 'auth.account.locked':
      return {
        channel: 'SMS',
        message:
          'VijayBank: Your net banking login was locked after multiple failed attempts. If this was not you, call customer care immediately.',
      };
    case 'transfer.settled':
      return { channel: 'SMS', message: `VijayBank: ${rupees(d.amountPaise)} transferred to ${d.beneficiaryName}. Ref ${d.reference}.` };
    case 'transfer.failed':
      return { channel: 'SMS', message: `VijayBank: Transfer of ${rupees(d.amountPaise)} failed and was reversed. Ref ${d.reference}.` };
    default:
      return null;
  }
}

/** The stored history never shows OTP digits again. */
export function mask(message, sensitive) {
  return sensitive ? message.replaceAll(sensitive, '******') : message;
}
