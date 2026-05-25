import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = "./data/air-quality.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    name          TEXT,
    model         TEXT,
    last_seen_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS readings (
    device_id    TEXT NOT NULL,
    measured_at  TEXT NOT NULL,
    source       TEXT NOT NULL,   -- "cloud" | "ble"
    pm25         REAL,
    pm10         REAL,
    co2          REAL,            -- ppm
    temperature  REAL,            -- °C
    humidity     REAL,            -- %
    tvoc         REAL,            -- ppb (Pro variants only)
    raw_json     TEXT NOT NULL,
    fetched_at   TEXT NOT NULL,
    PRIMARY KEY (device_id, measured_at, source)
  );

  CREATE INDEX IF NOT EXISTS idx_readings_device_time
    ON readings(device_id, measured_at DESC);
`);

export function upsertDevice(row: {
  device_id: string;
  name: string | null;
  model: string | null;
  last_seen_at: string;
}): void {
  db.prepare(
    `INSERT INTO devices (device_id, name, model, last_seen_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       name = excluded.name,
       model = excluded.model,
       last_seen_at = excluded.last_seen_at`,
  ).run(row.device_id, row.name, row.model, row.last_seen_at);
}

export type Reading = {
  device_id: string;
  measured_at: string;
  source: "cloud" | "ble";
  pm25: number | null;
  pm10: number | null;
  co2: number | null;
  temperature: number | null;
  humidity: number | null;
  tvoc: number | null;
  raw_json: string;
  fetched_at: string;
};

export function upsertReading(row: Reading): { inserted: boolean } {
  const result = db
    .prepare(
      `INSERT INTO readings (device_id, measured_at, source, pm25, pm10, co2, temperature, humidity, tvoc, raw_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, measured_at, source) DO NOTHING`,
    )
    .run(
      row.device_id,
      row.measured_at,
      row.source,
      row.pm25,
      row.pm10,
      row.co2,
      row.temperature,
      row.humidity,
      row.tvoc,
      row.raw_json,
      row.fetched_at,
    );
  return { inserted: result.changes > 0 };
}

export type DeviceRow = {
  device_id: string;
  name: string | null;
  model: string | null;
  last_seen_at: string | null;
};

export function listDevices(): DeviceRow[] {
  return db
    .prepare(
      `SELECT device_id, name, model, last_seen_at FROM devices ORDER BY COALESCE(name, device_id)`,
    )
    .all() as DeviceRow[];
}

export function latestReadingPerDevice(): Reading[] {
  return db
    .prepare(
      `SELECT r.*
       FROM readings r
       INNER JOIN (
         SELECT device_id, MAX(measured_at) AS max_t
         FROM readings GROUP BY device_id
       ) latest ON r.device_id = latest.device_id AND r.measured_at = latest.max_t`,
    )
    .all() as Reading[];
}

export function listReadings(
  deviceId: string,
  opts: { from?: string; to?: string; limit?: number },
): Reading[] {
  let sql = "SELECT * FROM readings WHERE device_id = ?";
  const params: (string | number)[] = [deviceId];
  if (opts.from) {
    sql += " AND measured_at >= ?";
    params.push(opts.from);
  }
  if (opts.to) {
    sql += " AND measured_at <= ?";
    params.push(opts.to);
  }
  sql += " ORDER BY measured_at DESC";
  if (opts.limit) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return db.prepare(sql).all(...params) as Reading[];
}

export function maxLastSeen(): string | null {
  const row = db.prepare("SELECT MAX(last_seen_at) AS t FROM devices").get() as {
    t: string | null;
  };
  return row.t;
}
