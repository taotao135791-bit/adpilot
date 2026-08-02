/**
 * Deterministic, LLM-free classifier for the vendored bash tool (AdPilot).
 *
 * The classifier is shell-syntax aware: it lexes the command line (quotes,
 * escapes, comments), splits it into simple commands at pipes, redirections,
 * command lists (&&, ||, ;, &) and newlines, and classifies every simple
 * command on its own. The overall verdict is the most severe one found:
 *
 * - read: every simple command is on the read-only whitelist (ls, cat, grep,
 *   git status/diff/log, ...) with no writing redirection — flows through the
 *   tool gate at the read level.
 * - write: anything else that is not explicitly dangerous (file redirects,
 *   package installs, inline interpreter code, unknown commands, and anything
 *   the lexer cannot fully resolve, including command substitution) — requires
 *   explicit Full Access because the shell schema has no action-bound grant.
 * - deny: hard-blocked patterns, not eligible for approval at all. These are
 *   exactly the channels of the reviewed threat model: network egress/ingress
 *   (curl/wget/ssh/rsync/nc/...), screen or UI capture (screencapture,
 *   osascript), browser cookie/profile store access, credential stores
 *   (.ssh, keychain, .env*, the .adpilot approval secret, pi-auth.json,
 *   settings.json, the audit chain), privilege escalation (sudo), process
 *   control (kill, launchctl), scheduled persistence (crontab/at) and rm -rf.
 *
 * The classification decision is written to the audit chain by the bash tool.
 * The classifier is the first of two enforcement layers; the sandbox-exec
 * seatbelt profile (network deny, write confinement, protected reads) is the
 * OS-level floor that holds even when a command was misclassified.
 */

export type BashCommandVerdict = "read" | "write" | "deny";

export interface SimpleCommandVerdict {
  /** Display form of the simple command (truncated). */
  readonly command: string;
  /** Resolved program name after path stripping and wrapper unwrapping. */
  readonly program: string | null;
  readonly verdict: BashCommandVerdict;
  /** Stable rule id for audit and tests. */
  readonly rule: string;
  readonly reason: string;
}

export interface BashClassification {
  readonly verdict: BashCommandVerdict;
  /** False when the lexer hit unterminated quotes or unparseable structure; verdict then floors at write. */
  readonly parseable: boolean;
  readonly commands: readonly SimpleCommandVerdict[];
  readonly reason: string;
}

export interface BashClassifierOptions {
  /**
   * When present, absolute redirection targets and path arguments are
   * confined: outside the workspace root and the well-known temp directories
   * they hard-deny. Without it, unverifiable absolute paths only floor the
   * segment at write (the gate-level pass runs without a workspace context;
   * the bash tool re-runs the classifier with the root for the final word).
   */
  readonly workspaceRoot?: string | undefined;
}

/* ------------------------------------------------------------------------ */
/* Lexer                                                                     */
/* ------------------------------------------------------------------------ */

interface WordToken {
  readonly kind: "word";
  readonly value: string;
  /** True when any part came from a substitution the classifier cannot resolve ($(), backticks, $VAR). */
  readonly dynamic: boolean;
}

interface OpToken {
  readonly kind: "op";
  readonly value: string;
}

type Token = WordToken | OpToken;

const CONTROL_OPERATORS = new Set(["|", "|&", "||", "&&", ";", "&", "\n"]);
const REDIRECT_OPERATORS = new Set([">", ">>", ">|", "<", "<<", "<<<", "&>", "&>>", "2>", "2>>"]);

interface LexResult {
  readonly tokens: Token[];
  /** Lexer reached the end cleanly (no unterminated quote/substitution). */
  readonly complete: boolean;
}

function lex(input: string): LexResult {
  const tokens: Token[] = [];
  let index = 0;
  let complete = true;
  const length = input.length;

  const readSubstitution = (start: number, opener: string, closer: string): number => {
    // Returns the index just past the balanced closer, or input.length when unbalanced.
    let depth = 1;
    let cursor = start;
    while (cursor < length) {
      const char = input[cursor]!;
      if (char === "\\") { cursor += 2; continue; }
      if (char === "'") {
        cursor += 1;
        while (cursor < length && input[cursor] !== "'") cursor += 1;
        cursor += 1;
        continue;
      }
      if (char === opener) depth += 1;
      if (char === closer) {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
    complete = false;
    return length;
  };

  while (index < length) {
    const char = input[index]!;
    if (char === " " || char === "\t" || char === "\r") { index += 1; continue; }
    if (char === "\n") { tokens.push({ kind: "op", value: "\n" }); index += 1; continue; }
    if (char === "#") { // comment: runs to end of line
      while (index < length && input[index] !== "\n") index += 1;
      continue;
    }
    // Operators, longest first. A digit directly before > or < is an fd prefix (2>, 2>>).
    const three = input.slice(index, index + 3);
    const two = input.slice(index, index + 2);
    if (three === "2>>" || three === "&>>" || three === "<<<") { tokens.push({ kind: "op", value: three }); index += 3; continue; }
    if (["||", "&&", ">>", "<<", ">|", "&>", "|&", "2>", "2>&", ">&"].includes(two)) {
      tokens.push({ kind: "op", value: two === "2>&" || two === ">&" ? ">&" : two });
      index += 2;
      continue;
    }
    if (char === "|" || char === ";" || char === "&" || char === ">" || char === "<" || char === "(" || char === ")") {
      tokens.push({ kind: "op", value: char });
      index += 1;
      continue;
    }
    // Word: consume until whitespace or an operator char.
    let value = "";
    let dynamic = false;
    let closed = true;
    while (index < length) {
      const current = input[index]!;
      if (" \t\r\n|;&<>()#".includes(current)) break;
      if (current === "\\") {
        value += input[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (current === "'") {
        index += 1;
        while (index < length && input[index] !== "'") { value += input[index]; index += 1; }
        if (index >= length) { closed = false; break; }
        index += 1;
        continue;
      }
      if (current === '"') {
        index += 1;
        let dclosed = false;
        while (index < length) {
          const dchar = input[index]!;
          if (dchar === '"') { dclosed = true; index += 1; break; }
          if (dchar === "\\" && index + 1 < length) { value += input[index + 1]; index += 2; continue; }
          if (dchar === "`") { dynamic = true; index = readSubstitution(index + 1, "`", "`"); continue; }
          if (dchar === "$" && input[index + 1] === "(") { dynamic = true; index = readSubstitution(index + 2, "(", ")"); continue; }
          if (dchar === "$") dynamic = true;
          value += dchar;
          index += 1;
        }
        if (!dclosed) { closed = false; }
        continue;
      }
      if (current === "`") { dynamic = true; index = readSubstitution(index + 1, "`", "`"); continue; }
      if (current === "$" && input[index + 1] === "(") { dynamic = true; index = readSubstitution(index + 2, "(", ")"); continue; }
      if (current === "$") { dynamic = true; value += current; index += 1; continue; }
      value += current;
      index += 1;
    }
    if (!closed) complete = false;
    tokens.push({ kind: "word", value, dynamic });
  }
  return { tokens, complete };
}

/* ------------------------------------------------------------------------ */
/* Rule tables                                                               */
/* ------------------------------------------------------------------------ */

/** Programs that only ever observe. Flags that turn them into writers are handled per program below. */
const READ_PROGRAMS = new Set([
  "ls", "cat", "grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "sort", "uniq", "cut", "tr",
  "diff", "comm", "cmp", "pwd", "date", "uname", "whoami", "id", "hostname", "basename", "dirname",
  "realpath", "readlink", "stat", "file", "du", "df", "echo", "printf", "true", "false", "test", "[",
  "which", "type", "jq", "yq", "column", "fmt", "fold", "nl", "expand", "unexpand", "shasum",
  "sha256sum", "sha1sum", "md5", "cksum", "man", "less", "more", "sed"
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "rev-parse", "ls-files", "ls-tree", "blame", "shortlog",
  "describe", "tag", "grep", "whatchanged", "reflog", "name-rev", "rev-list", "cat-file", "count-objects"
]);

/** Git subcommands that talk to a remote: exfiltration and inbound-code channels. */
const GIT_DENY_SUBCOMMANDS = new Set(["push", "fetch", "pull", "clone", "ls-remote", "archive", "bundle", "submodule"]);

const PACKAGE_MANAGER_DENY_SUBCOMMANDS = new Set([
  "publish", "login", "logout", "adduser", "ping", "view", "info", "show", "search", "audit",
  "outdated", "owner", "dist-tag", "token", "whoami", "access", "team", "org", "star", "unstar"
]);

interface DenyRule {
  readonly rule: string;
  readonly reason: string;
}

const NETWORK_EGRESS: DenyRule = {
  rule: "network_egress",
  reason: "network commands are hard-denied: they could reach the advertising APIs directly, exfiltrate workspace data, or pull remote code, bypassing the visual-only red line and the local-only privacy mode"
};
const SCREEN_CAPTURE: DenyRule = {
  rule: "screen_capture",
  reason: "screen capture and UI scripting are hard-denied: screenshots flow exclusively through the privacy pipeline"
};
const GUI_LAUNCH: DenyRule = {
  rule: "gui_application_launch",
  reason: "GUI application launch is hard-denied: terminal commands must not delegate URLs, files, or work to other software"
};
const PRIVILEGE_PROCESS: DenyRule = {
  rule: "privilege_or_process_control",
  reason: "privilege escalation and process control are hard-denied"
};
const CREDENTIAL_ACCESS: DenyRule = {
  rule: "credential_access",
  reason: "credential stores are hard-denied: approval secrets, provider credentials and cookies never enter the model context"
};
const PERSISTENCE: DenyRule = {
  rule: "persistence",
  reason: "scheduled execution and persistence mechanisms are hard-denied"
};
const DESTRUCTIVE_FS: DenyRule = {
  rule: "destructive_filesystem",
  reason: "irreversible filesystem destruction is hard-denied"
};
const DESTRUCTIVE_REPOSITORY: DenyRule = {
  rule: "destructive_repository",
  reason: "destructive repository ref or reflog changes are hard-denied"
};

const DENY_PROGRAMS: Readonly<Record<string, DenyRule>> = {
  curl: NETWORK_EGRESS, wget: NETWORK_EGRESS, http: NETWORK_EGRESS, https: NETWORK_EGRESS,
  nc: NETWORK_EGRESS, ncat: NETWORK_EGRESS, socat: NETWORK_EGRESS, telnet: NETWORK_EGRESS,
  ftp: NETWORK_EGRESS, lftp: NETWORK_EGRESS, sftp: NETWORK_EGRESS, scp: NETWORK_EGRESS,
  rsync: NETWORK_EGRESS, ssh: NETWORK_EGRESS, sshfs: NETWORK_EGRESS, rclone: NETWORK_EGRESS,
  aria2c: NETWORK_EGRESS, axel: NETWORK_EGRESS, ping: NETWORK_EGRESS, traceroute: NETWORK_EGRESS,
  mtr: NETWORK_EGRESS, dig: NETWORK_EGRESS, host: NETWORK_EGRESS, nslookup: NETWORK_EGRESS,
  screencapture: SCREEN_CAPTURE, osascript: SCREEN_CAPTURE, automator: SCREEN_CAPTURE,
  cliclick: SCREEN_CAPTURE, "screencaptureui": SCREEN_CAPTURE,
  open: GUI_LAUNCH, shortcuts: GUI_LAUNCH, "xdg-open": GUI_LAUNCH, gio: GUI_LAUNCH,
  sudo: PRIVILEGE_PROCESS, doas: PRIVILEGE_PROCESS, su: PRIVILEGE_PROCESS,
  kill: PRIVILEGE_PROCESS, killall: PRIVILEGE_PROCESS, pkill: PRIVILEGE_PROCESS,
  launchctl: PRIVILEGE_PROCESS, systemctl: PRIVILEGE_PROCESS, shutdown: PRIVILEGE_PROCESS,
  reboot: PRIVILEGE_PROCESS, halt: PRIVILEGE_PROCESS,
  security: CREDENTIAL_ACCESS, printenv: CREDENTIAL_ACCESS, env: CREDENTIAL_ACCESS,
  crontab: PERSISTENCE, at: PERSISTENCE, batch: PERSISTENCE,
  mkfs: DESTRUCTIVE_FS, diskutil: DESTRUCTIVE_FS, shred: DESTRUCTIVE_FS, srm: DESTRUCTIVE_FS,
  fdisk: DESTRUCTIVE_FS, hdiutil: DESTRUCTIVE_FS
};

/** Interpreters and shells run arbitrary code the classifier cannot see: always at least write. */
const SCRIPT_PROGRAMS = new Set([
  "node", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php", "lua", "osascript-l",
  "awk", "gawk", "mawk", "nawk", "tclsh", "wish", "expect", "groovy", "kotlin", "scala"
]);

/** Command wrappers that forward to another program (env FOO=bar cmd, nice cmd, ...). */
const WRAPPER_PROGRAMS = new Set(["command", "builtin", "nohup", "nice", "time", "timeout", "gtimeout", "stdbuf", "env"]);

/** Path fragments (substring, case-insensitive) whose mere reference hard-denies the command. */
const PROTECTED_PATH_FRAGMENTS: readonly string[] = [
  "/.ssh", "/.aws", "/.gnupg", "/.netrc", "/.npmrc", "/.docker", "/.kube", "/.config/gcloud",
  "/.config/gh", "/.azure", "/.adpilot/",
  "browser-profiles/", "browser-sessions/",
  "library/cookies", "library/safari",
  "library/application support/google/chrome",
  "library/application support/chromium",
  "library/application support/microsoft edge",
  "library/application support/bravesoftware",
  "library/application support/firefox",
  "library/application support/arc",
  "library/application support/vivaldi",
  "library/application support/com.operasoftware.opera"
];

/** Basenames (or basename globs) that hard-deny regardless of location. */
const PROTECTED_BASENAME = /^(?:approval-secret|pi-auth\.json|audit\.jsonl|id_rsa|id_dsa|id_ecdsa|id_ed25519|known_hosts|authorized_keys|\.netrc|\.npmrc|\.env(?:\..+)?|[^/]*\.pem|[^/]*\.key)$/i;

const TMP_PREFIXES = ["/tmp/", "/var/tmp/", "/private/tmp/", "/var/folders/", "/private/var/folders/", "/dev/null", "/dev/stdout", "/dev/stderr"];

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/** Case-insensitive protected-path test applied to every literal token (paths, redirect targets). */
export function isProtectedToken(token: string): boolean {
  if (!token) return false;
  let candidate = token.replace(/\\/g, "/");
  if (candidate.startsWith("~/")) candidate = candidate.slice(1); // ~ → /Library/... fragments still match
  const lowered = candidate.toLowerCase();
  if (lowered.includes("/.adpilot/skills") || lowered.includes("/.adpilot/prompts") || lowered.startsWith(".adpilot/skills") || lowered.startsWith(".adpilot/prompts")) {
    // The only model-visible subtrees of the private directory; still readable via the read tools.
  } else if (lowered.includes("/.adpilot/") || lowered.startsWith(".adpilot/")) {
    return true;
  }
  for (const fragment of PROTECTED_PATH_FRAGMENTS) {
    if (fragment === "/.adpilot/") continue; // handled above with its public-subtree exception
    if (lowered.includes(fragment)) return true;
  }
  return PROTECTED_BASENAME.test(basenameOf(candidate));
}

/* ------------------------------------------------------------------------ */
/* Simple-command classification                                             */
/* ------------------------------------------------------------------------ */

interface ParsedSegment {
  readonly display: string;
  readonly assignments: readonly string[];
  readonly program: WordToken | null;
  readonly args: readonly WordToken[];
  /** Output redirect targets (writing); input redirects are harmless reads handled by path rules. */
  readonly outputTargets: readonly WordToken[];
  readonly inputTargets: readonly WordToken[];
  readonly dynamic: boolean;
  readonly subshell: boolean;
}

const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function parseSegments(tokens: readonly Token[]): { segments: ParsedSegment[]; complete: boolean } {
  const segments: ParsedSegment[] = [];
  let complete = true;
  let current: Token[] = [];
  const flush = () => {
    if (current.length > 0) {
      segments.push(buildSegment(current));
      current = [];
    }
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "op" && CONTROL_OPERATORS.has(token.value)) { flush(); continue; }
    if (token.kind === "op" && (token.value === "(" || token.value === ")")) {
      complete = false; // subshell grouping: conservative floor applied by the caller
      flush();
      continue;
    }
    current.push(token);
  }
  flush();
  return { segments, complete };
}

function buildSegment(tokens: readonly Token[]): ParsedSegment {
  const assignments: string[] = [];
  const words: WordToken[] = [];
  const outputTargets: WordToken[] = [];
  const inputTargets: WordToken[] = [];
  let dynamic = false;
  let sawProgram = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "op") {
      if (REDIRECT_OPERATORS.has(token.value) || token.value === ">&") {
        const target = tokens[index + 1];
        if (target && target.kind === "word") {
          const isOutput = token.value !== "<" && token.value !== "<<";
          // << target is a heredoc delimiter; >&N targets are fd duplications (>&2), but >&file writes.
          if (isOutput && !(token.value === ">&" && /^\d+$/.test(target.value))) outputTargets.push(target);
          if (!isOutput) inputTargets.push(target);
          index += 1;
        }
      }
      continue;
    }
    dynamic = dynamic || token.dynamic;
    if (!sawProgram && !token.dynamic && ASSIGNMENT_PATTERN.test(token.value)) {
      assignments.push(token.value);
      continue;
    }
    sawProgram = true;
    words.push(token);
  }
  const display = tokens.map((token) => token.value).join(" ").slice(0, 120);
  return {
    display,
    assignments,
    program: words[0] ?? null,
    args: words.slice(1),
    outputTargets,
    inputTargets,
    dynamic,
    subshell: false
  };
}

interface SegmentContext {
  readonly workspaceRoot?: string | undefined;
}

function verdict(read: BashCommandVerdict, rule: string, reason: string): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> {
  return { verdict: read, rule, reason };
}

function classifyRedirectTargets(segment: ParsedSegment, context: SegmentContext): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> | null {
  for (const target of segment.outputTargets) {
    if (target.value === "/dev/null" || target.value === "/dev/stdout" || target.value === "/dev/stderr") continue;
    if (/^\d+$/.test(target.value) || target.value.startsWith("&")) continue; // fd duplication (2>&1)
    if (isProtectedToken(target.value)) {
      return verdict("deny", "protected_path", "redirect target is a protected path (credentials, approval secret, audit chain, or browser profile store)");
    }
    if (target.value.startsWith("/")) {
      if (TMP_PREFIXES.some((prefix) => target.value.startsWith(prefix))) {
        return verdict("write", "file_redirect", "redirect writes to a temp location");
      }
      if (context.workspaceRoot) {
        const root = context.workspaceRoot.endsWith("/") ? context.workspaceRoot : `${context.workspaceRoot}/`;
        if (target.value === context.workspaceRoot || target.value.startsWith(root)) {
          return verdict("write", "file_redirect", "redirect writes inside the workspace");
        }
        return verdict("deny", "redirect_outside_workspace", "redirect target is outside the workspace root and the temp directories");
      }
      return verdict("write", "absolute_redirect_unverified", "absolute redirect target cannot be confinement-checked without a workspace root");
    }
    if (target.dynamic) {
      return verdict("write", "dynamic_redirect", "redirect target contains a substitution the classifier cannot resolve");
    }
    return verdict("write", "file_redirect", "redirect writes a file inside the workspace");
  }
  return null;
}

function classifyTokenPaths(tokens: readonly WordToken[]): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> | null {
  for (const token of tokens) {
    if (isProtectedToken(token.value)) {
      return verdict("deny", "protected_path", "command references a protected path (credentials, approval secret, audit chain, or browser profile store); these are denied without exception, even for reads");
    }
  }
  return null;
}

function optionMatches(value: string, option: string): boolean {
  return value === option || (option.startsWith("--") && value.startsWith(`${option}=`));
}

function hasOption(args: readonly WordToken[], option: string): boolean {
  return args.some((arg) => optionMatches(arg.value, option));
}

function hasAnyOption(args: readonly WordToken[], options: readonly string[]): boolean {
  return options.some((option) => hasOption(args, option));
}

function hasLongOptionPrefix(args: readonly WordToken[], option: string, minimumPrefixLength: number): boolean {
  return args.some((arg) => {
    const candidate = arg.value.split("=", 1)[0]!;
    return candidate.startsWith("--") && candidate.length >= minimumPrefixLength + 2 && option.startsWith(candidate);
  });
}

function hasShortOption(args: readonly WordToken[], options: readonly string[], optionsTakingValues: readonly string[] = []): boolean {
  const sought = new Set(options);
  const takesValue = new Set(optionsTakingValues);
  for (const arg of args) {
    if (!arg.value.startsWith("-") || arg.value.startsWith("--")) continue;
    for (const option of arg.value.slice(1)) {
      if (sought.has(option)) return true;
      if (takesValue.has(option)) break;
    }
  }
  return false;
}

function splitGitInvocation(args: readonly WordToken[]): { name: string; args: readonly WordToken[] } {
  const globalOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
  let index = 0;
  while (index < args.length) {
    const value = args[index]!.value;
    if (!value.startsWith("-")) return { name: value, args: args.slice(index + 1) };
    if (globalOptionsWithValue.has(value)) {
      index += 2;
      continue;
    }
    index += 1;
  }
  return { name: "status", args: [] };
}

function classifyGitBranch(args: readonly WordToken[]): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> {
  const values = args.map((arg) => arg.value);
  const destructiveShort = hasShortOption(args, ["d", "D", "f", "M", "C"], ["u", "t"]);
  const destructiveLong = hasAnyOption(args, ["--delete", "--force"])
    || hasLongOptionPrefix(args, "--delete", 1)
    || hasLongOptionPrefix(args, "--force", 4);
  if (destructiveShort || destructiveLong) {
    return verdict("deny", DESTRUCTIVE_REPOSITORY.rule, "git branch deletion or forced ref replacement can discard repository history");
  }

  const mutationShort = hasShortOption(args, ["m", "c", "t", "u"]);
  if (mutationShort || hasAnyOption(args, [
    "--move", "--copy", "--track", "--no-track", "--set-upstream-to", "--unset-upstream",
    "--create-reflog", "--edit-description", "--recurse-submodules"
  ])) {
    return verdict("write", "git_mutation", "git branch changes repository refs or branch configuration");
  }

  const readLongOptions = [
    "--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged",
    "--points-at", "--format", "--sort", "--column", "--no-column", "--color", "--no-color",
    "--abbrev", "--no-abbrev", "--all", "--remotes", "--verbose", "--no-verbose", "--quiet",
    "--no-quiet", "--omit-empty", "--no-omit-empty", "--ignore-case", "--no-ignore-case"
  ];
  const listingMode = values.some((value) => value === "-l") || hasAnyOption(args, [
    "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"
  ]);
  const unknownOption = values.some((value) => value.startsWith("-")
    && !/^-[avqrli]+$/.test(value)
    && !readLongOptions.some((option) => optionMatches(value, option)));
  if (unknownOption) {
    return verdict("write", "git_mutation", "unrecognized git branch options fail closed because branch options may change repository refs");
  }
  const operands = values.filter((value) => !value.startsWith("-"));
  if (operands.length > 0 && !listingMode) {
    return verdict("write", "git_mutation", "git branch with a branch-name operand creates or changes a repository ref");
  }
  return verdict("read", "read_whitelist", "git branch listing only observes repository refs");
}

function classifyGitTag(args: readonly WordToken[]): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> {
  const values = args.map((arg) => arg.value);
  const destructiveShort = hasShortOption(args, ["d", "f"], ["m", "F", "u", "n"]);
  const destructiveLong = hasAnyOption(args, ["--delete", "--force"])
    || hasLongOptionPrefix(args, "--delete", 1)
    || hasLongOptionPrefix(args, "--force", 4);
  if (destructiveShort || destructiveLong) {
    return verdict("deny", DESTRUCTIVE_REPOSITORY.rule, "git tag deletion or forced replacement can discard repository refs");
  }

  const mutationShort = hasShortOption(args, ["a", "s", "e", "m", "F", "u"], ["m", "F", "u", "n"]);
  if (mutationShort || hasAnyOption(args, [
    "--annotate", "--sign", "--edit", "--message", "--file", "--local-user", "--cleanup",
    "--trailer", "--create-reflog"
  ])) {
    return verdict("write", "git_mutation", "git tag creates or changes a repository ref");
  }

  const readLongOptions = [
    "--list", "--verify", "--contains", "--no-contains", "--merged", "--no-merged",
    "--points-at", "--format", "--sort", "--column", "--no-column", "--color", "--no-color",
    "--omit-empty", "--no-omit-empty", "--ignore-case", "--no-ignore-case"
  ];
  const listingMode = values.some((value) => value === "-l" || value.startsWith("-n") || value === "-v") || hasAnyOption(args, [
    "--list", "--verify", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"
  ]);
  const unknownOption = values.some((value) => value.startsWith("-")
    && !/^-l$|^-v$|^-i$|^-n\d*$/.test(value)
    && !readLongOptions.some((option) => optionMatches(value, option)));
  if (unknownOption) {
    return verdict("write", "git_mutation", "unrecognized git tag options fail closed because tag options may change repository refs");
  }
  const operands = values.filter((value) => !value.startsWith("-"));
  if (operands.length > 0 && !listingMode) {
    return verdict("write", "git_mutation", "git tag with a tag-name operand creates a repository ref");
  }
  return verdict("read", "read_whitelist", "git tag listing or verification only observes repository refs");
}

function classifyGitReflog(args: readonly WordToken[]): Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason"> {
  const action = args.find((arg) => !arg.value.startsWith("-"))?.value;
  const destructiveAction = action && action.length >= 3
    ? ["expire", "delete", "drop"].find((candidate) => candidate.startsWith(action))
    : undefined;
  if (destructiveAction) {
    return verdict("deny", DESTRUCTIVE_REPOSITORY.rule, `git reflog ${destructiveAction} can permanently discard repository recovery history`);
  }
  if (action && action.length >= 3 && "write".startsWith(action)) {
    return verdict("write", "git_mutation", "git reflog write changes repository recovery history");
  }
  return verdict("read", "read_whitelist", "git reflog show/list/exists only observes repository recovery history");
}

function unwrapWrapper(words: readonly WordToken[]): readonly WordToken[] {
  // Peel env VAR=x cmd / nice cmd / nohup cmd / time cmd / command cmd wrappers.
  let rest = words;
  for (;;) {
    const head = rest[0];
    if (!head) return rest;
    const name = basenameOf(head.value);
    if (name === "env") {
      let index = 1;
      while (index < rest.length && (ASSIGNMENT_PATTERN.test(rest[index]!.value) || rest[index]!.value === "-i" || rest[index]!.value === "-u")) {
        index += rest[index]!.value === "-u" ? 2 : 1;
      }
      if (index >= rest.length) return rest.slice(0, 1); // bare env → credential dump
      rest = rest.slice(index);
      continue;
    }
    if (WRAPPER_PROGRAMS.has(name) && name !== "env") {
      let index = 1;
      while (index < rest.length && rest[index]!.value.startsWith("-")) index += 1; // wrapper flags (nice -n 5 handled loosely)
      if (index < rest.length && /^\d+$/.test(rest[index]!.value)) index += 1;
      if (index >= rest.length) return rest.slice(0, 1);
      rest = rest.slice(index);
      continue;
    }
    return rest;
  }
}

function classifySegment(segment: ParsedSegment, context: SegmentContext): SimpleCommandVerdict {
  const base = { command: segment.display || "(empty)", program: segment.program ? basenameOf(segment.program.value) : null };
  const finish = (partial: Pick<SimpleCommandVerdict, "verdict" | "rule" | "reason">, program: string | null): SimpleCommandVerdict => ({
    command: base.command,
    program,
    ...partial
  });

  // Redirect-only segment (`> file`): the redirect is the operation.
  if (!segment.program) {
    const redirect = classifyRedirectTargets(segment, context);
    if (redirect) return finish(redirect, null);
    if (segment.dynamic) return finish(verdict("write", "command_substitution", "assignment contains a substitution the classifier cannot resolve"), null);
    return finish(verdict("read", "assignment", "shell variable assignment without command execution"), null);
  }

  // Unwrap env/nice/nohup/time wrappers to reach the real program.
  const unwrapped = unwrapWrapper([segment.program, ...segment.args]);
  const programToken = unwrapped[0] ?? segment.program;
  const program = basenameOf(programToken.value);
  const args = unwrapped.slice(1);
  const allTokens = [programToken, ...args, ...segment.outputTargets, ...segment.inputTargets];

  // Hard denies first: protected paths anywhere in the command line.
  const pathDeny = classifyTokenPaths(allTokens);
  if (pathDeny) return finish(pathDeny, program);

  // Explicit deny table.
  const denyRule = DENY_PROGRAMS[program];
  if (denyRule) return finish(verdict("deny", denyRule.rule, denyRule.reason), program);

  // Command substitution anywhere in the segment: the classifier cannot
  // resolve the substituted text, so even whitelisted programs floor at write
  // (deny patterns inside the substitution were already caught above).
  if (segment.dynamic) {
    return finish(verdict("write", "command_substitution", "command contains a substitution whose result the classifier cannot resolve"), program);
  }

  // find -exec/-delete executes or removes; -fprint/-fprintf variants write output files.
  if (program === "find") {
    const execIndex = args.findIndex((arg) => arg.value === "-exec" || arg.value === "-execdir" || arg.value === "-ok" || arg.value === "-okdir");
    if (execIndex >= 0) {
      const delegated = args[execIndex + 1] ? basenameOf(args[execIndex + 1]!.value) : undefined;
      const delegatedRule = delegated ? DENY_PROGRAMS[delegated] : undefined;
      if (delegatedRule) return finish(verdict("deny", delegatedRule.rule, `find delegates to ${delegated}: ${delegatedRule.reason}`), program);
      const execFlags = args.filter((arg) => /^-[a-z]+$/i.test(arg.value)).map((arg) => arg.value).join("");
      if (delegated === "rm" && /r/i.test(execFlags) && /f/i.test(execFlags)) {
        return finish(verdict("deny", DESTRUCTIVE_FS.rule, "find -exec rm -rf is irreversible filesystem destruction"), program);
      }
      return finish(verdict("write", "find_exec", "find with -exec runs an arbitrary delegated command"), program);
    }
    if (args.some((arg) => arg.value === "-delete")) {
      return finish(verdict("write", "find_delete", "find -delete removes files"), program);
    }
    if (args.some((arg) => arg.value === "-fprint" || arg.value === "-fprint0" || arg.value === "-fprintf" || arg.value === "-fls")) {
      return finish(verdict("write", "find_output", "find file-output actions write results to a file"), program);
    }
    return finish(verdict("read", "read_whitelist", "find without execution, deletion, or file-output actions only lists paths"), program);
  }

  // rm: recursive+force is a hard deny; plain rm stays Full-Access-only.
  if (program === "rm") {
    const flags = args.filter((arg) => arg.value.startsWith("-")).map((arg) => arg.value).join("");
    if (/r/i.test(flags) && /f/i.test(flags)) {
      return finish(verdict("deny", DESTRUCTIVE_FS.rule, "rm with recursive force flags is irreversible filesystem destruction"), program);
    }
    return finish(verdict("write", "file_mutation", "rm removes files and therefore requires explicit Full Access"), program);
  }

  // dd writing to a device or file outside confinement.
  if (program === "dd") {
    const of = args.find((arg) => arg.value.startsWith("of="));
    if (of) {
      const target = of.value.slice(3);
      if (isProtectedToken(target) || target.startsWith("/dev/")) {
        return finish(verdict("deny", DESTRUCTIVE_FS.rule, "dd target is a device or protected path"), program);
      }
    }
    return finish(verdict("write", "file_mutation", "dd writes raw bytes to its output target"), program);
  }

  // git: read subcommands flow, remotes are network channels, everything else writes.
  if (program === "git") {
    const invocation = splitGitInvocation(args);
    const name = invocation.name;
    const gitArgs = invocation.args;
    if (GIT_DENY_SUBCOMMANDS.has(name)) {
      return finish(verdict("deny", NETWORK_EGRESS.rule, `git ${name} talks to remotes: ${NETWORK_EGRESS.reason}`), program);
    }
    if (name === "branch") return finish(classifyGitBranch(gitArgs), program);
    if (name === "tag") return finish(classifyGitTag(gitArgs), program);
    if (name === "reflog") return finish(classifyGitReflog(gitArgs), program);
    if (name === "stash") {
      const second = gitArgs.find((arg) => !arg.value.startsWith("-"))?.value;
      return finish(second === "list" || second === "show"
        ? verdict("read", "read_whitelist", "git stash list/show only observes")
        : verdict("write", "git_mutation", "git stash mutates repository state"), program);
    }
    if (name === "remote") {
      const second = gitArgs.find((arg) => !arg.value.startsWith("-"))?.value;
      return finish(second === undefined || second === "get-url"
        ? verdict("read", "read_whitelist", "git remote listing only observes")
        : verdict("write", "git_mutation", "git remote mutation changes repository configuration"), program);
    }
    if (name === "config") {
      return finish(verdict("write", "git_mutation", "git config may rewrite credential helpers and remotes"), program);
    }
    if (GIT_READ_SUBCOMMANDS.has(name)) {
      const redirect = classifyRedirectTargets(segment, context);
      if (redirect) return finish(redirect, program);
      return finish(verdict("read", "read_whitelist", `git ${name} only observes repository state`), program);
    }
    return finish(verdict("write", "git_mutation", `git ${name} mutates repository state and requires explicit Full Access`), program);
  }

  // Package managers: registry/publish/auth subcommands are network channels.
  if (program === "npm" || program === "pnpm" || program === "yarn" || program === "bun" || program === "npx") {
    const subcommand = args.find((arg) => !arg.value.startsWith("-"))?.value ?? "";
    if (PACKAGE_MANAGER_DENY_SUBCOMMANDS.has(subcommand)) {
      return finish(verdict("deny", NETWORK_EGRESS.rule, `${program} ${subcommand} talks to the package registry: ${NETWORK_EGRESS.reason}`), program);
    }
    return finish(verdict("write", "package_manager", `${program} ${subcommand || " invocation"} installs or executes code and requires explicit Full Access`), program);
  }

  // Shells: `bash -c 'script'` re-classifies the inner script recursively; running a script file writes.
  if (program === "sh" || program === "bash" || program === "zsh" || program === "dash" || program === "ksh" || program === "fish") {
    const cIndex = args.findIndex((arg) => arg.value === "-c");
    if (cIndex >= 0 && args[cIndex + 1]) {
      const inner = classifyBashCommand(args[cIndex + 1]!.value, context);
      if (inner.verdict === "deny") {
        return finish(verdict("deny", inner.commands.find((command) => command.verdict === "deny")?.rule ?? "nested_script", `${program} -c wraps a denied command: ${inner.reason}`), program);
      }
      return finish(verdict("write", "nested_shell", `${program} -c executes an inline script; inner verdict ${inner.verdict}, floored at write`), program);
    }
    return finish(verdict("write", "script_execution", `${program} executes a script file whose contents the classifier cannot verify`), program);
  }

  // Interpreters and awk: arbitrary code execution, always at least write.
  if (SCRIPT_PROGRAMS.has(program)) {
    return finish(verdict("write", "inline_code", `${program} executes arbitrary code the classifier cannot inspect; sandbox confinement still applies`), program);
  }

  // xargs/parallel execute delegated commands.
  if (program === "xargs" || program === "parallel") {
    const delegated = args.find((arg) => !arg.value.startsWith("-"));
    const delegatedRule = delegated ? DENY_PROGRAMS[basenameOf(delegated.value)] : undefined;
    if (delegatedRule) return finish(verdict("deny", delegatedRule.rule, `${program} delegates to a denied program: ${delegatedRule.reason}`), program);
    return finish(verdict("write", "delegated_execution", `${program} executes a delegated command`), program);
  }

  // Whitelisted read programs, with their write-capable flags checked.
  if (READ_PROGRAMS.has(program)) {
    if (program === "sed") {
      if (args.some((arg) => /^-[a-z]*i/.test(arg.value))) {
        return finish(verdict("write", "file_mutation", "sed -i rewrites files in place"), program);
      }
    }
    if (program === "sort") {
      const output = args.find((arg) => arg.value === "-o" || arg.value.startsWith("-o"));
      if (output) return finish(verdict("write", "file_mutation", "sort -o writes its result to a file"), program);
    }
    if (program === "yq") {
      const inPlace = hasShortOption(args, ["i"], ["p", "o", "I"])
        || hasAnyOption(args, ["--inplace", "--in-place"]);
      if (inPlace) return finish(verdict("write", "file_mutation", "yq in-place mode rewrites input files"), program);
    }
    if (program === "uniq") {
      const output = hasShortOption(args, ["o"], ["f", "s", "w"])
        || hasOption(args, "--output")
        || hasLongOptionPrefix(args, "--output", 1);
      if (output) return finish(verdict("write", "file_mutation", "uniq --output writes its result to a file"), program);
    }
    if (program === "echo" || program === "printf") {
      // harmless without a redirect; the redirect check below decides
    }
    const redirect = classifyRedirectTargets(segment, context);
    if (redirect) return finish(redirect, program);
    return finish(verdict("read", "read_whitelist", `${program} only observes`), program);
  }

  // tee writes its arguments.
  if (program === "tee") {
    const pathDeny2 = classifyTokenPaths(args);
    if (pathDeny2) return finish(pathDeny2, program);
    return finish(verdict("write", "file_mutation", "tee writes its output files"), program);
  }

  const redirect = classifyRedirectTargets(segment, context);
  if (redirect) return finish(redirect, program);

  // Unknown programs fail toward explicit Full Access, never toward read.
  return finish(verdict("write", "unknown_program", `${program} is not on the read-only whitelist; unlisted commands require explicit Full Access`), program);
}

/* ------------------------------------------------------------------------ */
/* Public entry points                                                       */
/* ------------------------------------------------------------------------ */

const SEVERITY: Record<BashCommandVerdict, number> = { read: 0, write: 1, deny: 2 };

export function classifyBashCommand(command: string, options: BashClassifierOptions = {}): BashClassification {
  if (typeof command !== "string" || command.trim().length === 0) {
    return {
      verdict: "write",
      parseable: true,
      commands: [],
      reason: "empty command; fail-closed to the Full-Access-only write level"
    };
  }
  const lexed = lex(command);
  const { segments, complete } = parseSegments(lexed.tokens);
  const parseable = lexed.complete && complete;
  const verdicts = segments.map((segment) => classifySegment(segment, { workspaceRoot: options.workspaceRoot }));
  let overall: BashCommandVerdict = verdicts.reduce<BashCommandVerdict>(
    (acc, item) => (SEVERITY[item.verdict] > SEVERITY[acc] ? item.verdict : acc),
    "read"
  );
  if (!parseable && SEVERITY[overall] < SEVERITY.write) overall = "write";
  const decisive = verdicts.find((item) => item.verdict === overall);
  const reason = !parseable
    ? `command could not be fully parsed (unterminated quote or subshell grouping); conservative ${overall} verdict${decisive ? `: ${decisive.reason}` : ""}`
    : decisive?.reason ?? "no executable commands found";
  return { verdict: overall, parseable, commands: verdicts, reason };
}

/** Pulls the command string out of bash tool arguments and classifies it (gate-level, no workspace root). */
export function classifyBashToolArgs(args: unknown, options: BashClassifierOptions = {}): BashClassification {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const command = typeof record.command === "string" ? record.command : "";
  return classifyBashCommand(command, options);
}

/** Maps a classifier verdict onto the tool-gate permission class. deny maps to destructive so the audit chain records the maximum severity. */
export function bashVerdictToGateClass(verdict: BashCommandVerdict): "read" | "write" | "destructive" {
  if (verdict === "read") return "read";
  if (verdict === "write") return "write";
  return "destructive";
}
