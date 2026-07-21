#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createInterface, type Interface } from "node:readline";
import open from "open";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
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
} else if (command === "providers") {
  const system = await createAdPilotSystem();
  for (const provider of system.models.getProviders()) {
    const auth = [provider.auth.apiKey ? "api-key" : "", provider.auth.oauth ? "oauth" : ""].filter(Boolean).join(",");
    console.log(`${provider.id.padEnd(27)} ${String(provider.getModels().length).padStart(3)} models  ${auth}`);
  }
} else if (command === "login") {
  const system = await createAdPilotSystem();
  const providers = system.models.getProviders().filter((provider) => provider.auth.oauth);
  const providerId = process.argv[3];
  if (!providerId || !providers.some((provider) => provider.id === providerId)) throw new Error(`OAuth provider is required. Available: ${providers.map((provider) => provider.id).join(", ")}`);
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await system.models.login(providerId, "oauth", { prompt: (item) => answerAuthPrompt(readline, item), notify: notifyAuth });
    console.log(`Connected ${providerId}. Credentials are stored in the active AdPilot workspace.`);
  } finally { readline.close(); }
} else if (command === "logout") {
  const providerId = process.argv[3];
  if (!providerId) throw new Error("provider id is required: adpilot logout <provider>");
  const system = await createAdPilotSystem();
  await system.models.logout(providerId);
  console.log(`Disconnected ${providerId}.`);
} else {
  console.error(`Unknown command: ${command}\nUsage: adpilot [serve|doctor|providers|login <provider>|logout <provider>|init <client-id> --name <name> --kpi CPA --target 20]`);
  process.exitCode = 1;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function ask(readline: Interface, question: string): Promise<string> {
  return new Promise((resolve) => readline.question(question, resolve));
}

async function answerAuthPrompt(readline: Interface, prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`));
    const index = Number.parseInt(await ask(readline, `Choose 1-${prompt.options.length}: `), 10) - 1;
    const selected = prompt.options[index];
    if (!selected) throw new Error("invalid selection");
    return selected.id;
  }
  return ask(readline, `${prompt.message}${prompt.placeholder ? ` (${prompt.placeholder})` : ""}: `);
}

function notifyAuth(event: AuthEvent): void {
  if (event.type === "auth_url") {
    console.log(`\nOpen this URL to authorize:\n${event.url}`);
    if (event.instructions) console.log(event.instructions);
    void open(event.url);
  } else if (event.type === "device_code") {
    console.log(`\nOpen ${event.verificationUri} and enter code ${event.userCode}`);
    void open(event.verificationUri);
  } else console.log(event.message);
}
