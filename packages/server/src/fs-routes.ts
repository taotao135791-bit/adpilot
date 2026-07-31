import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AdPilotSystem } from "@adpilot/application";

const TreeQuery = z.object({
  root: z.string().min(1).max(4_096),
  depth: z.coerce.number().int().min(0).max(4).default(2)
}).strict();

const FileQuery = z.object({
  path: z.string().min(1).max(4_096)
}).strict();

/** Hard caps so a project files browser can never walk or stream the world. */
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 512 * 1024;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

class FsRouteError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "FsRouteError";
    this.code = code;
  }
}

interface FsTreeEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  children?: FsTreeEntry[];
}

/**
 * Universal Workspace read-only filesystem routes: a bounded directory tree
 * for the project files browser and a capped text-file reader for the inline
 * preview. Both expand a leading `~`, resolve symlinks via realpath, and fail
 * closed on anything that is not a real directory/file. Directory walks skip
 * node_modules/.git and symlinks, never descend past depth 4, and stop at 500
 * emitted entries (flagged via `truncated`). File reads refuse anything over
 * 512KB or containing NUL bytes.
 *
 * The module also carries `GET /api/skills` — the desktop Skills view needs
 * the merged built-in + user skill catalog and this is the one new route module the
 * workbench ships with, so the small read-only catalog lives here instead of
 * growing a second registration in index.ts.
 */
export function registerFsRoutes(app: FastifyInstance, system: AdPilotSystem): void {
  app.get("/api/fs/tree", async (request) => {
    const query = TreeQuery.parse(request.query);
    const root = await resolveDirectory(query.root);
    const budget = { remaining: MAX_ENTRIES, truncated: false };
    const entries = await walk(root, query.depth, budget);
    return { root, truncated: budget.truncated, entries };
  });

  app.get("/api/fs/file", async (request) => {
    const query = FileQuery.parse(request.query);
    const target = await resolveFile(query.path);
    const metadata = await stat(target);
    if (metadata.size > MAX_FILE_BYTES) {
      throw new FsRouteError(`file exceeds the ${MAX_FILE_BYTES}-byte preview limit: ${query.path}`, "FS_FILE_TOO_LARGE");
    }
    const buffer = await readFile(target);
    if (buffer.includes(0)) {
      throw new FsRouteError(`binary files cannot be previewed: ${query.path}`, "FS_FILE_BINARY");
    }
    return { path: target, size: metadata.size, content: buffer.toString("utf8") };
  });

  app.get("/api/skills", async () => {
    const [skills, userSkills, warnings] = await Promise.all([
      system.knowledge.list(),
      system.userSkills.list(),
      system.userSkills.warnings()
    ]);
    const userByName = new Map(userSkills.map((skill) => [skill.name, skill]));
    return {
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        triggers: skill.triggers,
        source: userByName.get(skill.name)?.source ?? "built-in",
        publisher: userByName.has(skill.name) ? undefined : "AdPilot",
        license: userByName.has(skill.name) ? undefined : "MIT"
      })),
      warnings
    };
  });
}

/** Expands a leading `~` then pins the canonical path; must be a real directory. */
async function resolveDirectory(input: string): Promise<string> {
  const expanded = expandHome(input);
  let canonical: string;
  try {
    canonical = await realpath(expanded);
  } catch {
    throw new FsRouteError(`directory does not exist: ${input}`, "FS_ROOT_INVALID");
  }
  const metadata = await stat(canonical).catch(() => null);
  if (!metadata?.isDirectory()) {
    throw new FsRouteError(`not a directory: ${input}`, "FS_ROOT_INVALID");
  }
  return canonical;
}

async function resolveFile(input: string): Promise<string> {
  const expanded = expandHome(input);
  let canonical: string;
  try {
    canonical = await realpath(expanded);
  } catch {
    throw new FsRouteError(`file does not exist: ${input}`, "FS_FILE_NOT_FOUND");
  }
  const metadata = await stat(canonical).catch(() => null);
  if (!metadata?.isFile()) {
    throw new FsRouteError(`not a file: ${input}`, "FS_FILE_NOT_FOUND");
  }
  return canonical;
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

/**
 * Recursive walk with a shared entry budget: directories first, then files,
 * both name-ascending. Once the budget runs out the walk stops and the
 * response is flagged `truncated` rather than silently incomplete.
 */
async function walk(directory: string, depth: number, budget: { remaining: number; truncated: boolean }): Promise<FsTreeEntry[]> {
  const listing = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (!listing) return [];
  const directories = listing
    .filter((entry) => entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const files = listing
    .filter((entry) => entry.isFile())
    .sort((left, right) => left.name.localeCompare(right.name));
  const entries: FsTreeEntry[] = [];
  for (const entry of [...directories, ...files]) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    budget.remaining -= 1;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = depth > 0 ? await walk(path, depth - 1, budget) : undefined;
      entries.push(children !== undefined ? { name: entry.name, path, kind: "directory", children } : { name: entry.name, path, kind: "directory" });
    } else {
      entries.push({ name: entry.name, path, kind: "file" });
    }
  }
  return entries;
}
