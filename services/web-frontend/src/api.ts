// Thin fetch wrapper: attaches the access token, refreshes it once when it has
// expired, and turns the standard {"error": {...}} body into an ApiError.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

type Session = { accessToken: string; refreshToken: string; customerId: string; expiresAt: number };

const KEY = 'vijaybank.session';

export const session = {
  get(): Session | null {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  },
  save(t: { accessToken: string; refreshToken: string; customerId: string; expiresInSeconds: number }) {
    const s: Session = { ...t, expiresAt: Date.now() + t.expiresInSeconds * 1000 };
    sessionStorage.setItem(KEY, JSON.stringify(s));
  },
  clear() {
    sessionStorage.removeItem(KEY);
  },
};

async function parse(res: Response) {
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error ?? {};
    const { code = 'ERROR', message = 'Something went wrong.', ...details } = e;
    throw new ApiError(res.status, code, message, details);
  }
  return body;
}

async function refresh(): Promise<boolean> {
  const s = session.get();
  if (!s) return false;
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: s.refreshToken }),
  });
  if (!res.ok) {
    session.clear();
    return false;
  }
  session.save(await res.json());
  return true;
}

export async function api<T = unknown>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const s = session.get();
  // Refresh shortly before expiry so active users are not interrupted.
  if (s && !retried && s.expiresAt - Date.now() < 30_000) await refresh();
  const token = session.get()?.accessToken;
  const res = await fetch('/api' + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && token && !retried && (await refresh())) {
    return api<T>(path, init, true);
  }
  return parse(res) as Promise<T>;
}

export const post = <T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body), headers });

/** Downloads an authenticated file (e.g. a PDF statement) and saves it with the server's filename. */
export async function download(path: string, fallbackName: string) {
  const token = session.get()?.accessToken;
  const res = await fetch('/api' + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) await parse(res);
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export const toPaise = (rupeesText: string) => Math.round(parseFloat(rupeesText.replace(/,/g, '')) * 100);

export const istDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

export const isoDay = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export const rupees = (paise: number | null | undefined) =>
  paise == null
    ? '—'
    : '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const istDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
