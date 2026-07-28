import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function command(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: "utf8",
    ...options
  })?.trim();
}

export default async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  const helperAppPath = join(
    appPath,
    "Contents",
    "Resources",
    "native",
    "AdPilot Computer Helper.app"
  );
  const helperExecutable = join(
    helperAppPath,
    "Contents",
    "MacOS",
    "adpilot-native-helper"
  );
  await access(helperExecutable, fsConstants.X_OK);

  const mainBundleId = command(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(appPath, "Contents", "Info.plist")]
  );
  const helperBundleId = command(
    "/usr/libexec/PlistBuddy",
    [
      "-c",
      "Print :CFBundleIdentifier",
      join(helperAppPath, "Contents", "Info.plist")
    ]
  );
  if (
    mainBundleId !== "com.adpilot.desktop"
    || helperBundleId !== "com.adpilot.computer-helper"
  ) {
    throw new Error("packaged AdPilot bundle identifiers are not stable");
  }

  // electron-builder applies entitlementsInherit to every nested application,
  // including extraResources. Strip Electron's JIT entitlements from the
  // Computer Helper, then reseal the containing app. Developer ID builds use
  // the normal certificate path and must be validated with release credentials.
  if (context.packager.platformSpecificBuildOptions.identity === "-") {
    command(
      "/usr/bin/codesign",
      [
        "--force",
        "--deep",
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        join(repoRoot, "build", "entitlements.helper.plist"),
        "--sign",
        "-",
        helperAppPath
      ],
      { stdio: "inherit" }
    );
    command(
      "/usr/bin/codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        join(repoRoot, "build", "entitlements.mac.plist"),
        "--sign",
        "-",
        appPath
      ],
      { stdio: "inherit" }
    );
  }

  command(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    { stdio: "inherit" }
  );
}
