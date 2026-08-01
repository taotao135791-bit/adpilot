import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

const KNOWN_BROAD_ROOTS = new Set([
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/Volumes",
  "/bin",
  "/dev",
  "/etc",
  "/opt",
  "/private",
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/private/var/folders",
  "/sbin",
  "/tmp",
  "/usr",
  "/var"
]);

/**
 * Returns a stable reason when a project root would make a terminal sandbox
 * effectively equivalent to broad host access. The caller owns the public
 * error type so kernel and terminal routes can keep their existing contracts.
 */
export async function broadProjectRootReason(canonicalPath: string): Promise<string | null> {
  const candidate = resolve(canonicalPath);
  if (candidate === parse(candidate).root) return "filesystem_root";
  if (KNOWN_BROAD_ROOTS.has(candidate)) return "system_root";

  const canonicalHome = await realpath(homedir()).catch(() => resolve(homedir()));
  if (candidate === canonicalHome) return "user_home";

  const parent = dirname(candidate);
  if (candidate === "/Volumes" || parent === "/Volumes") return "volume_root";

  const [metadata, parentMetadata] = await Promise.all([
    stat(candidate).catch(() => null),
    stat(parent).catch(() => null)
  ]);
  if (metadata && parentMetadata && metadata.dev !== parentMetadata.dev) return "volume_root";
  return null;
}
