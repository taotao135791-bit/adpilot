import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { assertSafeIdentifier, TaskState, type TaskState as TaskStateType } from "@adpilot/shared";

const ClientProfile = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  industry: z.string().default("unknown"),
  timezone: z.string().default("UTC")
});

const KpiConfig = z.object({
  primary: z.enum(["CPI", "CPA", "ROAS", "LTV_CAC", "REVENUE", "LEADS"]),
  target: z.number().positive(),
  currency: z.string().length(3).default("USD")
});

const AccountsConfig = z.object({
  accounts: z.array(z.object({
    platform: z.string().min(1),
    accountRef: z.string().min(1),
    browserProfile: z.string().min(1),
    allowedDomains: z.array(z.string().min(1)).min(1)
  })).default([])
});

const ConstraintsConfig = z.object({
  maxBudgetChangePercent: z.number().min(0).max(100).default(20),
  allowDestructive: z.boolean().default(false),
  blockedOperations: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([])
});

export type ClientProfile = z.infer<typeof ClientProfile>;
export type KpiConfig = z.infer<typeof KpiConfig>;
export type AccountsConfig = z.infer<typeof AccountsConfig>;
export type ConstraintsConfig = z.infer<typeof ConstraintsConfig>;

export interface ClientWorkspaceConfig {
  profile: ClientProfile;
  kpi: KpiConfig;
  accounts?: AccountsConfig;
  constraints?: ConstraintsConfig;
}

export interface ClientWorkspaceInput {
  profile: z.input<typeof ClientProfile>;
  kpi: z.input<typeof KpiConfig>;
  accounts?: z.input<typeof AccountsConfig>;
  constraints?: z.input<typeof ConstraintsConfig>;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

export class WorkspaceStore {
  readonly root: string;

  constructor(root = resolve(process.cwd(), "workspace")) {
    this.root = resolve(root);
  }

  clientRoot(clientId: string): string {
    const safeId = assertSafeIdentifier(clientId, "client id");
    const path = resolve(this.root, "clients", safeId);
    const clientsRoot = `${resolve(this.root, "clients")}${sep}`;
    if (!`${path}${sep}`.startsWith(clientsRoot)) throw new Error("client workspace escaped root");
    return path;
  }

  async initializeClient(config: ClientWorkspaceInput): Promise<string> {
    const profile = ClientProfile.parse(config.profile);
    assertSafeIdentifier(profile.id, "client id");
    const root = this.clientRoot(profile.id);
    await Promise.all([
      "experiments",
      "reports",
      "screenshots",
      "traces",
      "memory",
      "tasks",
      "approvals"
    ].map((directory) => mkdir(join(root, directory), { recursive: true, mode: 0o700 })));
    await Promise.all([
      this.writeYaml(profile.id, "profile.yaml", profile),
      this.writeYaml(profile.id, "kpi.yaml", KpiConfig.parse(config.kpi)),
      this.writeYaml(profile.id, "accounts.yaml", AccountsConfig.parse(config.accounts ?? {})),
      this.writeYaml(profile.id, "constraints.yaml", ConstraintsConfig.parse(config.constraints ?? {}))
    ]);
    return root;
  }

  async listClients(): Promise<ClientProfile[]> {
    const root = resolve(this.root, "clients");
    try {
      const entries = await readdir(root, { withFileTypes: true });
      const clients = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
        try { return await this.readYaml(entry.name, "profile.yaml", ClientProfile); }
        catch { return null; }
      }));
      return clients.filter((client): client is ClientProfile => client !== null);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readClient(clientId: string): Promise<ClientWorkspaceConfig> {
    const [profile, kpi, accounts, constraints] = await Promise.all([
      this.readYaml(clientId, "profile.yaml", ClientProfile),
      this.readYaml(clientId, "kpi.yaml", KpiConfig),
      this.readYaml(clientId, "accounts.yaml", AccountsConfig),
      this.readYaml(clientId, "constraints.yaml", ConstraintsConfig)
    ]);
    return { profile, kpi, accounts, constraints };
  }

  async saveTask(task: TaskStateType): Promise<void> {
    const value = TaskState.parse(task);
    await this.writeJson(value.clientId, join("tasks", `${value.id}.json`), value);
  }

  async readTask(clientId: string, taskId: string): Promise<TaskStateType> {
    assertSafeIdentifier(taskId, "task id");
    return this.readJson(clientId, join("tasks", `${taskId}.json`), TaskState);
  }

  async listTasks(clientId: string): Promise<TaskStateType[]> {
    const directory = this.resolveClientPath(clientId, "tasks");
    const files = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const tasks = await Promise.all(files.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
      const id = entry.name.slice(0, -5);
      try { return await this.readTask(clientId, id); } catch { return null; }
    }));
    return tasks.filter((task): task is TaskStateType => task !== null).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async appendJsonl(clientId: string, relativePath: string, value: unknown): Promise<void> {
    const path = this.resolveClientPath(clientId, relativePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeAtomic(path, `${current}${JSON.stringify(value)}\n`);
  }

  async readJsonl<S extends z.ZodTypeAny>(clientId: string, relativePath: string, schema: S): Promise<Array<z.output<S>>> {
    const path = this.resolveClientPath(clientId, relativePath);
    const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return content.split("\n").filter(Boolean).map((line) => schema.parse(JSON.parse(line)));
  }

  async writeJson(clientId: string, relativePath: string, value: unknown): Promise<void> {
    await writeAtomic(this.resolveClientPath(clientId, relativePath), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readJson<S extends z.ZodTypeAny>(clientId: string, relativePath: string, schema: S): Promise<z.output<S>> {
    const content = await readFile(this.resolveClientPath(clientId, relativePath), "utf8");
    return schema.parse(JSON.parse(content));
  }

  private async writeYaml(clientId: string, relativePath: string, value: unknown): Promise<void> {
    await writeAtomic(this.resolveClientPath(clientId, relativePath), stringifyYaml(value));
  }

  private async readYaml<S extends z.ZodTypeAny>(clientId: string, relativePath: string, schema: S): Promise<z.output<S>> {
    const content = await readFile(this.resolveClientPath(clientId, relativePath), "utf8");
    return schema.parse(parseYaml(content));
  }

  private resolveClientPath(clientId: string, relativePath: string): string {
    if (relativePath.startsWith("/") || relativePath.includes("..")) throw new Error("unsafe workspace path");
    const root = this.clientRoot(clientId);
    const path = resolve(root, relativePath);
    if (!`${path}${sep}`.startsWith(`${root}${sep}`)) throw new Error("workspace path escaped client root");
    return path;
  }
}

export { AccountsConfig, ClientProfile, ConstraintsConfig, KpiConfig };
