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
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  ArtifactRecord,
  type ArtifactRecord as ArtifactRecordValue
} from "./record.js";

const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export interface ArtifactVersionFiles {
  version: number;
  files: string[];
}

/**
 * Private, atomic artifact store. Layout under the store root:
 *
 *   <root>/.adpilot/artifacts/<id>/record.json   (0o600, atomic write)
 *   <root>/.adpilot/artifacts/<id>/spec.json     (renderer source, via writeOutput)
 *   <root>/.adpilot/artifacts/<id>/v<version>/…  (rendered outputs, old versions kept)
 *
 * File names are validated against path escape, writes use private temporary
 * files plus rename, and symlinked directories or records fail closed.
 */
export class FileArtifactStore {
  private readonly directory: string;

  constructor(root: string) {
    if (!root) throw new Error("Artifact store root is required");
    this.directory = resolve(join(root, ".adpilot", "artifacts"));
  }

  /** Absolute path of the artifacts root (…/.adpilot/artifacts). */
  get root(): string {
    return this.directory;
  }

  async save(recordInput: ArtifactRecordValue): Promise<void> {
    const record = ArtifactRecord.parse(recordInput);
    const artifactDirectory = await this.ensureArtifactDirectory(record.id);
    const target = join(artifactDirectory, "record.json");
    await assertNotSymlink(target, true);
    const temporary = join(
      artifactDirectory,
      `.record.${process.pid}.${randomUUID()}.tmp`
    );
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

  async get(id: string): Promise<ArtifactRecordValue | undefined> {
    assertUuid(id);
    await this.ensureRootDirectory();
    const target = join(this.directory, id, "record.json");
    try {
      await assertNotSymlink(target, false);
      const contents = await readFile(target);
      if (contents.byteLength > MAX_RECORD_BYTES) {
        throw new Error("Artifact record exceeds the size limit");
      }
      return ArtifactRecord.parse(JSON.parse(contents.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list(projectId?: string): Promise<ArtifactRecordValue[]> {
    await this.ensureRootDirectory();
    const records: ArtifactRecordValue[] = [];
    for (const name of await readdir(this.directory)) {
      if (!isUuid(name)) continue;
      const record = await this.get(name);
      if (!record) continue;
      if (projectId !== undefined && record.projectId !== projectId) continue;
      records.push(record);
    }
    return records.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );
  }

  async delete(id: string): Promise<void> {
    assertUuid(id);
    await this.ensureRootDirectory();
    const artifactDirectory = join(this.directory, id);
    try {
      const metadata = await lstat(artifactDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error("Artifact directory must be a real directory");
      }
      await rm(artifactDirectory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  /**
   * Write a rendered output or source file under the artifact directory.
   * `filename` may contain sub-directories (`v2/slides.pptx`) but must never
   * escape the artifact directory.
   */
  async writeOutput(id: string, filename: string, buffer: Buffer): Promise<void> {
    if (buffer.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error("Artifact output exceeds the size limit");
    }
    const artifactDirectory = await this.ensureArtifactDirectory(id);
    const target = confinedPath(artifactDirectory, filename);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await assertNotSymlink(target, true);
    const temporary = join(
      dirname(target),
      `.output.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      await writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async readOutput(id: string, filename: string): Promise<Buffer | undefined> {
    assertUuid(id);
    await this.ensureRootDirectory();
    const target = confinedPath(join(this.directory, id), filename);
    try {
      await assertNotSymlink(target, false);
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Absolute path of the output directory for one version, created on demand.
   * Renderers write their real files here; everything stays confined to the
   * artifact directory.
   */
  async outputDirFor(id: string, version: number): Promise<string> {
    if (!Number.isInteger(version) || version < 1) {
      throw new Error("Artifact version must be a positive integer");
    }
    const artifactDirectory = await this.ensureArtifactDirectory(id);
    const outputDirectory = join(artifactDirectory, `v${version}`);
    await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(outputDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Artifact version directory must be a real directory");
    }
    return outputDirectory;
  }

  /** Files of every kept version, ascending. */
  async listVersions(id: string): Promise<ArtifactVersionFiles[]> {
    assertUuid(id);
    await this.ensureRootDirectory();
    const artifactDirectory = join(this.directory, id);
    let entries: string[];
    try {
      entries = await readdir(artifactDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const versions: ArtifactVersionFiles[] = [];
    for (const entry of entries) {
      const match = /^v(\d+)$/.exec(entry);
      if (!match) continue;
      const versionDirectory = join(artifactDirectory, entry);
      const metadata = await lstat(versionDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) continue;
      const files = (await readdir(versionDirectory))
        .filter((name) => !name.startsWith("."))
        .sort();
      versions.push({ version: Number.parseInt(match[1] as string, 10), files });
    }
    return versions.sort((left, right) => left.version - right.version);
  }

  private async ensureRootDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Artifact store directory must be a real private directory");
    }
    await chmod(this.directory, 0o700);
  }

  private async ensureArtifactDirectory(id: string): Promise<string> {
    assertUuid(id);
    await this.ensureRootDirectory();
    const artifactDirectory = join(this.directory, id);
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(artifactDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Artifact directory must be a real private directory");
    }
    await chmod(artifactDirectory, 0o700);
    return artifactDirectory;
  }
}

async function assertNotSymlink(path: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error("Artifact path must not be a symlink");
    }
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function confinedPath(directory: string, filename: string): string {
  if (!filename || isAbsolute(filename) || filename.includes("\0")) {
    throw new Error("Artifact output filename must be a relative path");
  }
  const target = resolve(join(directory, filename));
  if (target !== directory && !target.startsWith(`${directory}/`)) {
    throw new Error("Artifact output path escaped its store");
  }
  if (target === directory) {
    throw new Error("Artifact output filename must name a file");
  }
  return target;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function assertUuid(value: string): void {
  if (!isUuid(value)) throw new Error("invalid artifact ID");
}
