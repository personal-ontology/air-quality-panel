import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const APP_ID = process.env.QINGPING_APP_ID;
const APP_KEY = process.env.QINGPING_APP_KEY;
const OAUTH_BASE = process.env.QINGPING_OAUTH_BASE || "https://oauth.cleargrass.com";
const API_BASE = process.env.QINGPING_API_BASE || "https://apis.cleargrass.com";

const TOKEN_PATH = "./data/qingping_token.json";

type CachedToken = { access_token: string; expires_at: string };

let cached: CachedToken | null = null;

function loadCachedFromDisk(): CachedToken | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, "utf8")) as CachedToken;
  } catch {
    return null;
  }
}

function saveCachedToDisk(t: CachedToken): void {
  mkdirSync(dirname(TOKEN_PATH), { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(t));
}

async function getAccessToken(): Promise<string> {
  if (!APP_ID || !APP_KEY) {
    throw new Error("QINGPING_APP_ID / QINGPING_APP_KEY not set");
  }
  const now = Date.now();
  const fresh = (t: CachedToken | null) =>
    t && new Date(t.expires_at).getTime() > now + 60_000;
  if (fresh(cached)) return cached!.access_token;
  const fromDisk = loadCachedFromDisk();
  if (fresh(fromDisk)) {
    cached = fromDisk;
    return cached!.access_token;
  }

  const basic = btoa(`${APP_ID}:${APP_KEY}`);
  const res = await fetch(`${OAUTH_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=device_full_access",
  });
  if (!res.ok) {
    throw new Error(`oauth/token ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    access_token: data.access_token,
    expires_at: new Date(now + (data.expires_in - 60) * 1000).toISOString(),
  };
  saveCachedToDisk(cached);
  return cached.access_token;
}

async function call<T>(path: string, params?: Record<string, string | number>): Promise<T> {
  const token = await getAccessToken();
  const sp = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
  }
  const qs = sp.size ? "?" + sp.toString() : "";
  const res = await fetch(`${API_BASE}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// Qingping device shape (best-effort; actual API may differ slightly)
export type QingpingDevice = {
  mac: string;
  name?: string;
  product?: { code?: string; name?: string };
  info?: { name?: string; mac?: string };
};

export type QingpingDeviceList = {
  devices: QingpingDevice[];
  total?: number;
};

export async function listDevices(): Promise<QingpingDeviceList> {
  return call<QingpingDeviceList>("/v1/apis/devices");
}

// Qingping reading shape — fields are typically wrapped { value: number, unit: string, level?: number }
// We normalize via pickValue() in refresh.ts.
export type QingpingReading = {
  timestamp?: { value: number } | number;
  pm25?: { value: number } | number;
  pm10?: { value: number } | number;
  co2?: { value: number } | number;
  temperature?: { value: number } | number;
  humidity?: { value: number } | number;
  tvoc?: { value: number } | number;
};

export type QingpingDeviceDataResponse = {
  data?: QingpingReading[];
};

export async function getDeviceData(
  mac: string,
  opts: { start_time?: number; end_time?: number; limit?: number } = {},
): Promise<QingpingDeviceDataResponse> {
  return call<QingpingDeviceDataResponse>("/v1/apis/devices/data", {
    mac,
    ...(opts.start_time !== undefined ? { start_time: opts.start_time } : {}),
    ...(opts.end_time !== undefined ? { end_time: opts.end_time } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
}

export function pickValue(field: unknown): number | null {
  if (field === null || field === undefined) return null;
  if (typeof field === "number") return field;
  if (typeof field === "object" && field !== null && "value" in field) {
    const v = (field as { value: unknown }).value;
    if (typeof v === "number") return v;
  }
  return null;
}
