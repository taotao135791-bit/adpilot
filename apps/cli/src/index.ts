#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import open from "open";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "@adpilot/server";

try { process.loadEnvFile(); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const command = process.argv[2] ?? "serve";
const uiRoot = fileURLToPath(new URL("../desktop", import.meta.url));

if (command === "serve") {
  const host = process.env.ADPILOT_HOST ?? "127.0.0.1";
  const port = Number(process.env.ADPILOT_PORT ?? 4317);
  const system = await createAdPilotSystem();
  const server = await createServer(system, { uiRoot });
  await server.listen({ host, port });
  const url = `http://${host}:${port}`;
  console.log(`AdPilot is running at ${url}`);
  if (process.env.ADPILOT_NO_OPEN !== "1") await open(url);
} else if (command === "doctor") {
  const system = await createAdPilotSystem();
  const clients = await system.workspace.listClients();
  console.log(JSON.stringify({ node: process.version, workspace: system.workspace.root, clients: clients.length, models: system.modelStatus, status: "ok" }, null, 2));
} else if (command === "init") {
  const id = process.argv[3];
  if (!id) throw new Error("client id is required: adpilot init <client-id> --name <name> --kpi CPA --target 20");
  const name = flag("--name") ?? id;
  const kpi = flag("--kpi") ?? "CPA";
  const target = Number(flag("--target"));
  const currency = (flag("--currency") ?? "USD").toUpperCase();
  if (!Number.isFinite(target) || target <= 0) throw new Error("--target must be a positive number");
  if (!["CPI", "CPA", "ROAS", "LTV_CAC", "REVENUE", "LEADS"].includes(kpi)) throw new Error("--kpi must be CPI, CPA, ROAS, LTV_CAC, REVENUE, or LEADS");
  const system = await createAdPilotSystem();
  const path = await system.workspace.initializeClient({ profile: { id, name }, kpi: { primary: kpi as "CPI" | "CPA" | "ROAS" | "LTV_CAC" | "REVENUE" | "LEADS", target, currency } });
  console.log(JSON.stringify({ status: "created", clientId: id, path }, null, 2));
} else {
  console.error(`Unknown command: ${command}\nUsage: adpilot [serve|doctor|init <client-id> --name <name> --kpi CPA --target 20]`);
  process.exitCode = 1;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
