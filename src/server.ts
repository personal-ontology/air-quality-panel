import { Hono } from "hono";
import { Cron } from "croner";
import { refreshAll } from "./refresh.ts";
import {
  listDevices,
  latestReadingPerDevice,
  listReadings,
  maxLastSeen,
  upsertReading,
  upsertDevice,
  type Reading,
} from "./db.ts";
import { readFileSync } from "node:fs";

const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

const SOURCE = "air-quality";
const PORT = Number(process.env.PORT || 8002);
const HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
const BEARER_TOKEN = process.env.PANEL_BEARER_TOKEN;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/5 * * * *";
let currentTimezone = process.env.TIMEZONE || "America/Los_Angeles";

function envelope<T>(data: T) {
  return {
    data,
    refreshed_at: new Date().toISOString(),
    source: SOURCE,
  };
}

const app = new Hono();

const UNAUTHED_PATHS = new Set(["/", "/favicon.ico"]);
app.use("*", async (c, next) => {
  if (!BEARER_TOKEN) return next();
  if (UNAUTHED_PATHS.has(c.req.path)) return next();
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== BEARER_TOKEN) {
    return c.json(envelope({ error: "unauthorized" }), 401);
  }
  return next();
});

// ── HTML view ───────────────────────────────────────────────────────────────
app.get("/", (c) => c.html(UI_HTML));

// ── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (c) => {
  const lastSeen = maxLastSeen();
  const devs = listDevices();
  let status: "ok" | "stale" | "no_devices" = "ok";
  if (devs.length === 0) status = "no_devices";
  else if (lastSeen && Date.now() - new Date(lastSeen).getTime() > 60 * 60 * 1000) {
    status = "stale";
  }
  return c.json(
    envelope({
      ok: devs.length > 0,
      status,
      devices_count: devs.length,
      last_seen_at: lastSeen,
      schedule: {
        cron: CRON_SCHEDULE,
        timezone: currentTimezone,
        next_run: cronJob?.nextRun()?.toISOString() ?? null,
      },
    }),
  );
});

// ── Headline summary — current readings per device ──────────────────────────
app.get("/data", (c) => {
  const devs = listDevices();
  const latest = latestReadingPerDevice();
  const byId = new Map(latest.map((r) => [r.device_id, r]));
  const out = devs.map((d) => ({
    device_id: d.device_id,
    name: d.name,
    model: d.model,
    last_seen_at: d.last_seen_at,
    latest: byId.get(d.device_id) ?? null,
  }));
  return c.json(envelope({ devices: out }));
});

// ── List devices ────────────────────────────────────────────────────────────
app.get("/devices", (c) => c.json(envelope({ devices: listDevices() })));

// ── Readings query ──────────────────────────────────────────────────────────
app.get("/devices/:id/readings", (c) => {
  const id = c.req.param("id");
  const from = c.req.query("from") || undefined;
  const to = c.req.query("to") || undefined;
  const limitStr = c.req.query("limit");
  const limit = limitStr ? Math.min(Number(limitStr), 10000) : 200;
  const rows = listReadings(id, { from, to, limit });
  return c.json(envelope({ readings: rows, count: rows.length }));
});

// ── Trigger refresh ─────────────────────────────────────────────────────────
app.post("/refresh", async (c) => {
  try {
    const result = await refreshAll();
    return c.json(envelope({ ok: true, result }));
  } catch (e) {
    return c.json(envelope({ ok: false, error: (e as Error).message }), 500);
  }
});

// ── BLE ingestion endpoint (used by future Mac-side scanner) ────────────────
// Accepts a single reading; dedup is on (device_id, measured_at, source).
type BleIngestBody = {
  device_id: string;
  name?: string;
  model?: string;
  measured_at: string;
  pm25?: number;
  pm10?: number;
  co2?: number;
  temperature?: number;
  humidity?: number;
  tvoc?: number;
  raw?: unknown;
};
app.post("/ingest/ble", async (c) => {
  let body: BleIngestBody;
  try {
    body = (await c.req.json()) as BleIngestBody;
  } catch {
    return c.json(envelope({ error: "invalid_json" }), 400);
  }
  if (!body?.device_id || !body?.measured_at) {
    return c.json(envelope({ error: "device_id and measured_at required" }), 400);
  }
  const nowIso = new Date().toISOString();
  upsertDevice({
    device_id: body.device_id,
    name: body.name ?? null,
    model: body.model ?? null,
    last_seen_at: nowIso,
  });
  const reading: Reading = {
    device_id: body.device_id,
    measured_at: body.measured_at,
    source: "ble",
    pm25: body.pm25 ?? null,
    pm10: body.pm10 ?? null,
    co2: body.co2 ?? null,
    temperature: body.temperature ?? null,
    humidity: body.humidity ?? null,
    tvoc: body.tvoc ?? null,
    raw_json: JSON.stringify(body.raw ?? body),
    fetched_at: nowIso,
  };
  const result = upsertReading(reading);
  return c.json(envelope({ ok: true, inserted: result.inserted }));
});

// ── Update scheduler timezone ───────────────────────────────────────────────
app.post("/timezone", async (c) => {
  let body: { tz?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(envelope({ error: "invalid_json" }), 400);
  }
  const newTz = typeof body?.tz === "string" ? body.tz : "";
  if (!newTz) return c.json(envelope({ error: "missing tz" }), 400);
  try {
    new Cron("0 0 * * *", { timezone: newTz, paused: true });
  } catch {
    return c.json(envelope({ error: "invalid_timezone", tz: newTz }), 400);
  }
  const changed = newTz !== currentTimezone;
  if (changed) {
    console.log(`[scheduler] timezone changed: ${currentTimezone} -> ${newTz}`);
    currentTimezone = newTz;
    scheduleCron();
  }
  return c.json(
    envelope({
      ok: true,
      timezone: currentTimezone,
      changed,
      next_run: cronJob?.nextRun()?.toISOString() ?? null,
    }),
  );
});

// ── 404 ─────────────────────────────────────────────────────────────────────
app.notFound((c) =>
  c.json(envelope({ error: "not_found", path: c.req.path }), 404),
);

// ── Cron scheduler ──────────────────────────────────────────────────────────
async function scheduledRefresh(reason: string) {
  console.log(`[scheduler:${reason}] starting refresh at ${new Date().toISOString()}`);
  try {
    const result = await refreshAll();
    const summary = result.devices
      .map((d) => `${(d.name || d.device_id).slice(0, 16)}=${d.readings_inserted}new`)
      .join(", ");
    console.log(`[scheduler:${reason}] done — ${summary}`);
  } catch (e) {
    console.error(`[scheduler:${reason}] error:`, (e as Error).message);
  }
}

let cronJob: Cron | null = null;
function scheduleCron() {
  if (cronJob) cronJob.stop();
  cronJob = new Cron(CRON_SCHEDULE, { timezone: currentTimezone }, () =>
    scheduledRefresh("cron"),
  );
  const next = cronJob.nextRun();
  console.log(
    `[scheduler] cron='${CRON_SCHEDULE}' tz=${currentTimezone} next=${next?.toISOString() ?? "never"}`,
  );
}

scheduleCron();
// Only run the startup refresh if we have credentials configured — otherwise
// it'll throw and look like a real error in logs.
if (process.env.QINGPING_APP_ID && process.env.QINGPING_APP_KEY) {
  setTimeout(() => scheduledRefresh("startup"), 10_000);
} else {
  console.log(
    "[scheduler] startup refresh skipped — set QINGPING_APP_ID/QINGPING_APP_KEY in .env to enable cloud polling",
  );
}

console.log(`air-quality-panel listening on http://${HOSTNAME}:${PORT}`);

export default {
  port: PORT,
  hostname: HOSTNAME,
  fetch: app.fetch,
};
