import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

const MutationClaim = z.object({
  mutationKey: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().uuid(),
  actionId: z.string().uuid(),
  approvalId: z.string().uuid(),
  claimedAt: z.string().datetime()
}).strict();
export type MutationClaim = z.infer<typeof MutationClaim>;
const MAX_MUTATION_CLAIM_BYTES = 64 * 1024;

export interface MutationReplayStore {
  /**
   * Atomically claim a mutation key. `false` means it was claimed before and
   * native input must not be attempted again, regardless of the earlier result.
   */
  claim(input: MutationClaim): Promise<boolean>;
  get(mutationKey: string): Promise<MutationClaim | undefined>;
}

export class MemoryMutationReplayStore implements MutationReplayStore {
  private readonly claims = new Map<string, MutationClaim>();

  async claim(input: MutationClaim): Promise<boolean> {
    const claim = MutationClaim.parse(input);
    if (this.claims.has(claim.mutationKey)) return false;
    this.claims.set(claim.mutationKey, claim);
    return true;
  }

  async get(mutationKey: string): Promise<MutationClaim | undefined> {
    assertMutationKey(mutationKey);
    return this.claims.get(mutationKey);
  }
}

/**
 * Durable, append-only replay protection. `wx` is the atomic boundary: two
 * concurrent runtimes cannot both reserve the same approved mutation.
 */
export class FileMutationReplayStore implements MutationReplayStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!directory) throw new Error("mutation replay directory is required");
    this.directory = resolve(directory);
  }

  async claim(input: MutationClaim): Promise<boolean> {
    const claim = MutationClaim.parse(input);
    await this.ensureSafeDirectory();
    const target = this.pathFor(claim.mutationKey);
    await assertSafeClaimFile(target, true);
    try {
      await writeFile(target, `${JSON.stringify(claim)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await chmod(target, 0o600);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await assertSafeClaimFile(target, false);
        return false;
      }
      throw error;
    }
  }

  async get(mutationKey: string): Promise<MutationClaim | undefined> {
    assertMutationKey(mutationKey);
    await this.ensureSafeDirectory();
    const target = this.pathFor(mutationKey);
    try {
      await assertSafeClaimFile(target, false);
      const contents = await readFile(target);
      if (contents.byteLength > MAX_MUTATION_CLAIM_BYTES) {
        throw new Error("mutation replay claim exceeds the size limit");
      }
      return MutationClaim.parse(JSON.parse(contents.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async ensureSafeDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("mutation replay directory must be a real private directory");
    }
    await chmod(this.directory, 0o700);
  }

  private pathFor(mutationKey: string): string {
    assertMutationKey(mutationKey);
    const path = resolve(join(this.directory, `${mutationKey}.json`));
    if (!path.startsWith(`${this.directory}/`)) throw new Error("mutation claim escaped its store");
    return path;
  }
}

async function assertSafeClaimFile(path: string, allowMissing: boolean): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("mutation replay claim must not be a symlink");
    if (!metadata.isFile()) throw new Error("mutation replay claim must be a regular file");
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertMutationKey(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid mutation key");
}
