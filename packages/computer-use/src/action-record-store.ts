import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ComputerActionRecord,
  type ComputerActionRecord as ComputerActionRecordValue
} from "./protocol.js";
import type { ComputerActionRecordStore } from "./runtime.js";

const MAX_RECORD_BYTES = 1024 * 1024;

/**
 * Private, atomic action ledger for the composition root. File names are UUIDs,
 * writes use private temporary files plus rename, and symlinked directories or
 * records fail closed.
 */
export class FileComputerActionRecordStore implements ComputerActionRecordStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory) throw new Error("Computer Action record directory is required");
    this.directory = resolve(directory);
  }

  async save(recordInput: ComputerActionRecordValue): Promise<void> {
    const record = ComputerActionRecord.parse(recordInput);
    await this.ensureSafeDirectory();
    const target = this.pathFor(record.id);
    await assertNotSymlink(target, true);
    const temporary = this.pathForTemporary(record.id);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async get(actionId: string): Promise<ComputerActionRecordValue | undefined> {
    assertUuid(actionId);
    await this.ensureSafeDirectory();
    const target = this.pathFor(actionId);
    try {
      await assertNotSymlink(target, false);
      const contents = await readFile(target);
      if (contents.byteLength > MAX_RECORD_BYTES) throw new Error("Computer Action record exceeds the size limit");
      return ComputerActionRecord.parse(JSON.parse(contents.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(sessionId: string): Promise<ComputerActionRecordValue[]> {
    assertUuid(sessionId);
    await this.ensureSafeDirectory();
    const records: ComputerActionRecordValue[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const actionId = name.slice(0, -5);
      const record = await this.get(actionId);
      if (record?.sessionId === sessionId) records.push(record);
    }
    return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  private async ensureSafeDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Computer Action record directory must be a real private directory");
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(actionId: string): string {
    assertUuid(actionId);
    return confinedPath(this.directory, `${actionId}.json`);
  }

  private pathForTemporary(actionId: string): string {
    assertUuid(actionId);
    return confinedPath(this.directory, `.${actionId}.${process.pid}.${randomUUID()}.tmp`);
  }
}

async function assertNotSymlink(path: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("Computer Action record path must not be a symlink");
    if (!metadata.isFile()) throw new Error("Computer Action record path must be a regular file");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function confinedPath(directory: string, name: string): string {
  const path = resolve(join(directory, name));
  if (!path.startsWith(`${directory}/`)) throw new Error("Computer Action record path escaped its store");
  return path;
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("invalid Computer Action record ID");
  }
}
