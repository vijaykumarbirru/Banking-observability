// Fictional billers. "fetch" simulates the biller's system: the due amount is
// derived from the consumer number so the same number always shows the same bill.
import crypto from 'node:crypto';

export const BILLERS = [
  { id: 'METRO-POWER', name: 'Metro Power Distribution', category: 'ELECTRICITY', label: 'Consumer number', pattern: '^\\d{10}$' },
  { id: 'SUNRISE-ELEC', name: 'Sunrise Electricity Co.', category: 'ELECTRICITY', label: 'Service number', pattern: '^\\d{9,12}$' },
  { id: 'AIRWAVE-POST', name: 'AirWave Mobile Postpaid', category: 'MOBILE', label: 'Mobile number', pattern: '^[6-9]\\d{9}$' },
  { id: 'SKYVIEW-DTH', name: 'SkyView DTH', category: 'DTH', label: 'Subscriber ID', pattern: '^\\d{8,11}$', recharge: true },
  { id: 'CITYGAS', name: 'CityGas Piped Gas', category: 'GAS', label: 'BP number', pattern: '^\\d{8,12}$' },
  { id: 'FIBERNET', name: 'FiberNet Broadband', category: 'BROADBAND', label: 'Account ID', pattern: '^[A-Z0-9]{6,12}$' },
  { id: 'MUNI-WATER', name: 'Municipal Water Board', category: 'WATER', label: 'Connection number', pattern: '^\\d{7,10}$' },
];

const RANGES = {
  ELECTRICITY: [600, 6500],
  MOBILE: [299, 1499],
  GAS: [350, 1800],
  BROADBAND: [499, 1999],
  WATER: [200, 1200],
};

const NAMES = ['A. Kumar', 'S. Sharma', 'R. Iyer', 'P. Reddy', 'M. Nair', 'K. Gupta', 'V. Rao', 'N. Menon'];

export function fetchBill(biller, consumerNumber) {
  const h = crypto.createHash('sha256').update(biller.id + consumerNumber).digest();
  if (biller.recharge) {
    return { billNumber: null, customerName: NAMES[h[0] % NAMES.length], dueAmountPaise: null, dueDate: null, recharge: true };
  }
  // Consumer numbers ending in 0 have no bill due (handy for testing).
  if (consumerNumber.endsWith('0')) {
    return { billNumber: null, customerName: NAMES[h[0] % NAMES.length], dueAmountPaise: 0, dueDate: null, recharge: false };
  }
  const [lo, hi] = RANGES[biller.category];
  const rupees = lo + (h.readUInt16BE(1) % (hi - lo));
  const due = new Date();
  due.setDate(due.getDate() + 3 + (h[3] % 12));
  return {
    billNumber: `${biller.id.slice(0, 3)}${h.readUInt32BE(4) % 100000000}`,
    customerName: NAMES[h[0] % NAMES.length],
    dueAmountPaise: rupees * 100,
    dueDate: due.toISOString().slice(0, 10),
    recharge: false,
  };
}
