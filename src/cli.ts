import { refreshAll } from "./refresh.ts";
import { listDevices, latestReadingPerDevice } from "./db.ts";

async function main() {
  console.log("\n→ Polling Qingping cloud...\n");
  const result = await refreshAll();
  console.log(`Polled ${result.devices.length} device(s):\n`);
  for (const d of result.devices) {
    console.log(`▸ ${d.name || d.device_id}`);
    if (d.error) console.log(`    ⚠ ${d.error}`);
    console.log(`    ${d.readings_pulled} readings pulled, ${d.readings_inserted} new`);
  }

  console.log("\n→ Latest reading per device (from DB):\n");
  const latest = latestReadingPerDevice();
  for (const r of latest) {
    const dev = listDevices().find((d) => d.device_id === r.device_id);
    console.log(`▸ ${dev?.name || r.device_id}  @ ${r.measured_at}  (${r.source})`);
    if (r.pm25 !== null) console.log(`    PM2.5         ${r.pm25.toFixed(1).padStart(6)} µg/m³`);
    if (r.pm10 !== null) console.log(`    PM10          ${r.pm10.toFixed(1).padStart(6)} µg/m³`);
    if (r.co2 !== null) console.log(`    CO2           ${Math.round(r.co2).toString().padStart(6)} ppm`);
    if (r.temperature !== null) console.log(`    Temperature   ${r.temperature.toFixed(1).padStart(6)} °C`);
    if (r.humidity !== null) console.log(`    Humidity      ${r.humidity.toFixed(1).padStart(6)} %`);
    if (r.tvoc !== null) console.log(`    TVOC          ${r.tvoc.toFixed(1).padStart(6)} ppb`);
    console.log();
  }

  console.log("✓ Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nError:", err.message);
  process.exit(1);
});
