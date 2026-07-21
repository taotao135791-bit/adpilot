#!/usr/bin/env node
import { resolve } from "node:path";
import open from "open";
import { createAdPilotSystem } from "@adpilot/application";
import { createServer } from "@adpilot/server";

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  const host = process.env.ADPILOT_HOST ?? "127.0.0.1";
  const port = Number(process.env.ADPILOT_PORT ?? 4317);
  const system = await createAdPilotSystem();
  const server = await createServer(system, { uiRoot: resolve(process.cwd(), "dist", "desktop") });
  await server.listen({ host, port });
  const url = `http://${host}:${port}`;
  console.log(`AdPilot is running at ${url}`);
  if (process.env.ADPILOT_NO_OPEN !== "1") await open(url);
} else if (command === "doctor") {
  const system = await createAdPilotSystem();
  const clients = await system.workspace.listClients();
  console.log(JSON.stringify({ node: process.version, workspace: system.workspace.root, clients: clients.length, models: system.modelStatus, status: "ok" }, null, 2));
} else {
  console.error(`Unknown command: ${command}\nUsage: adpilot [serve|doctor]`);
  process.exitCode = 1;
}
