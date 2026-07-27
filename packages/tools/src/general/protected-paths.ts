/**
 * Protected paths enforced on BOTH sides of the tool surface (AdPilot-specific):
 * the read/write/edit path guard and the bash command classifier + sandbox
 * profile. These locations carry the exact secrets and channels of the
 * reviewed threat model, so they are denied without exception — read or write,
 * with or without an approval:
 *
 * - workspace/.adpilot/approval-secret: the HMAC key for approval tokens; a
 *   same-user process read would allow forging approvals (threat a).
 * - workspace/.adpilot/pi-auth.json and settings.json: provider credentials.
 * - .env* files anywhere, PEM/key material, SSH/AWS/GnuPG/cloud config dirs:
 *   credential stores that must never enter the model context.
 * - clients' audit.jsonl chain files: tampering would break the compliance
 *   record.
 * - workspace/browser-profiles and browser-sessions plus the macOS browser
 *   profile/cookie stores: direct cookie/profile manipulation would bypass the
 *   dual visual review (threat c).
 *
 * The bash classifier mirrors the same policy through the root-independent
 * patterns in @adpilot/shared (isProtectedToken); this matcher is the
 * canonical, workspace-aware version used by the path guard and the seatbelt
 * profile generator. Every rejection carries the same message prefix,
 * PROTECTED_PATH_MESSAGE, so audits and tests have one string to assert.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve, sep } from "node:path";

/** Unified rejection prefix for every protected-path denial (asserted by tests). */
export const PROTECTED_PATH_MESSAGE = "path is protected by AdPilot policy (credentials, approval secrets, audit chain and browser profile stores are never tool-accessible)";

export interface ProtectedPathMatcher {
  /** Returns the matched rule id when the canonical absolute path is protected, null otherwise. */
  match(canonicalAbsolutePath: string): string | null;
  /** Absolute literal files and directory prefixes, for the seatbelt profile generator. */
  deniedFiles(): readonly string[];
  deniedPrefixes(): readonly string[];
}

interface ProtectedPathOptions {
  workspaceRoot: string;
  /** Defaults to the process home directory; injectable for tests. */
  homeDir?: string;
}

function canonicalize(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Basename rules that deny a file wherever it lives. */
const PROTECTED_BASENAMES: ReadonlyArray<{ pattern: RegExp; rule: string }> = [
  { pattern: /^\.env(?:\..+)?$/i, rule: "env_file" },
  { pattern: /^audit\.jsonl$/i, rule: "audit_chain" },
  { pattern: /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys)$/i, rule: "ssh_material" },
  { pattern: /^\.(?:netrc|npmrc|pypirc|dockerconfigjson)$/i, rule: "credential_file" },
  { pattern: /\.(?:pem|key|p12|pfx|keystore)$/i, rule: "key_material" }
];

const MACOS_BROWSER_PREFIXES = [
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
  "Library/Application Support/Arc",
  "Library/Application Support/Vivaldi",
  "Library/Application Support/com.operasoftware.Opera",
  "Library/Safari",
  "Library/Cookies"
];

const HOME_CREDENTIAL_PREFIXES = [".ssh", ".aws", ".gnupg", ".docker", ".kube", ".azure", ".config/gcloud", ".config/gh"];

export function createProtectedPathMatcher(options: ProtectedPathOptions): ProtectedPathMatcher {
  const workspaceRoot = canonicalize(options.workspaceRoot);
  const home = canonicalize(options.homeDir ?? homedir());

  const files: ReadonlyArray<{ path: string; rule: string }> = [
    { path: resolve(workspaceRoot, ".adpilot", "approval-secret"), rule: "approval_secret" },
    { path: resolve(workspaceRoot, ".adpilot", "pi-auth.json"), rule: "provider_credentials" },
    { path: resolve(workspaceRoot, ".adpilot", "settings.json"), rule: "settings_credentials" }
  ].map((entry) => ({ path: canonicalize(entry.path), rule: entry.rule }));

  const prefixes: ReadonlyArray<{ path: string; rule: string }> = [
    { path: resolve(workspaceRoot, "browser-profiles"), rule: "managed_browser_profile" },
    { path: resolve(workspaceRoot, "browser-sessions"), rule: "browser_session_state" },
    ...MACOS_BROWSER_PREFIXES.map((relative) => ({ path: resolve(home, relative), rule: "browser_profile_store" })),
    ...HOME_CREDENTIAL_PREFIXES.map((relative) => ({ path: resolve(home, relative), rule: "credential_store" }))
  ].map((entry) => ({ path: canonicalize(entry.path), rule: entry.rule }));

  return {
    match(canonicalAbsolutePath: string): string | null {
      for (const file of files) {
        if (canonicalAbsolutePath === file.path) return file.rule;
      }
      for (const prefix of prefixes) {
        if (canonicalAbsolutePath === prefix.path || canonicalAbsolutePath.startsWith(`${prefix.path}${sep}`)) return prefix.rule;
      }
      const base = basename(canonicalAbsolutePath);
      for (const entry of PROTECTED_BASENAMES) {
        if (entry.pattern.test(base)) return entry.rule;
      }
      return null;
    },
    deniedFiles: () => files.map((file) => file.path),
    deniedPrefixes: () => prefixes.map((prefix) => prefix.path)
  };
}
