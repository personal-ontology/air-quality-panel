import {
  listDevices as listQingpingDevices,
  getDeviceData,
  pickValue,
  type QingpingReading,
} from "./qingping.ts";
import { upsertDevice, upsertReading } from "./db.ts";

const DEVICE_MAC_FILTER = process.env.QINGPING_DEVICE_MAC || "";

export type DeviceRefreshResult = {
  device_id: string;
  name: string | null;
  readings_pulled: number;
  readings_inserted: number;
  error: string | null;
};

export type RefreshResult = {
  devices: DeviceRefreshResult[];
  ran_at: string;
};

function readingTimestamp(r: QingpingReading): string {
  const ts = typeof r.timestamp === "number" ? r.timestamp : r.timestamp?.value;
  if (!ts) return new Date().toISOString();
  return new Date(ts * 1000).toISOString();
}

export async function refreshAll(opts?: { startTime?: number }): Promise<RefreshResult> {
  const now = new Date();
  const nowIso = now.toISOString();
  const results: DeviceRefreshResult[] = [];

  const list = await listQingpingDevices();
  const devices = DEVICE_MAC_FILTER
    ? list.devices.filter((d) => d.mac === DEVICE_MAC_FILTER || d.info?.mac === DEVICE_MAC_FILTER)
    : list.devices;

  for (const dev of devices) {
    const mac = dev.mac || dev.info?.mac || "";
    const name = dev.name || dev.info?.name || null;
    const model = dev.product?.code || dev.product?.name || null;

    const r: DeviceRefreshResult = {
      device_id: mac,
      name,
      readings_pulled: 0,
      readings_inserted: 0,
      error: null,
    };

    if (!mac) {
      r.error = "device has no mac";
      results.push(r);
      continue;
    }

    upsertDevice({ device_id: mac, name, model, last_seen_at: nowIso });

    try {
      // Pull last 15 minutes by default. Caller can override with `startTime`.
      const startTime = opts?.startTime ?? Math.floor((Date.now() - 15 * 60 * 1000) / 1000);
      const data = await getDeviceData(mac, { start_time: startTime, limit: 50 });
      const points = data.data || [];
      r.readings_pulled = points.length;
      for (const p of points) {
        const result = upsertReading({
          device_id: mac,
          measured_at: readingTimestamp(p),
          source: "cloud",
          pm25: pickValue(p.pm25),
          pm10: pickValue(p.pm10),
          co2: pickValue(p.co2),
          temperature: pickValue(p.temperature),
          humidity: pickValue(p.humidity),
          tvoc: pickValue(p.tvoc),
          raw_json: JSON.stringify(p),
          fetched_at: nowIso,
        });
        if (result.inserted) r.readings_inserted++;
      }
    } catch (e) {
      r.error = (e as Error).message;
    }
    results.push(r);
  }

  return { devices: results, ran_at: nowIso };
}
