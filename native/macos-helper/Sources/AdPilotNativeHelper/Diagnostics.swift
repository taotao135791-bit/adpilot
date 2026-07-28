import Foundation
import Security

struct HelperProcessIdentity {
    let pid: Int
    let bundleIdentifier: String
    let bundleName: String
    let executableName: String
    let signingIdentifier: String

    static func current() -> HelperProcessIdentity {
        let bundle = Bundle.main
        let executablePath = ProcessInfo.processInfo.arguments.first ?? ""
        return HelperProcessIdentity(
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            bundleIdentifier: bundle.bundleIdentifier ?? "",
            bundleName: bundle.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? "AdPilot Computer Helper",
            executableName: URL(fileURLWithPath: executablePath).lastPathComponent,
            signingIdentifier: currentSigningIdentifier()
        )
    }

    var dictionary: [String: Any] {
        [
            "pid": pid,
            "bundleIdentifier": bundleIdentifier,
            "bundleName": bundleName,
            "executableName": executableName,
            "signingIdentifier": signingIdentifier
        ]
    }
}

private func currentSigningIdentifier() -> String {
    let executableURL = Bundle.main.executableURL
        ?? URL(fileURLWithPath: ProcessInfo.processInfo.arguments.first ?? "")
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(
        executableURL as CFURL,
        [],
        &staticCode
    ) == errSecSuccess,
    let staticCode else {
        return ""
    }
    var signingInformation: CFDictionary?
    guard SecCodeCopySigningInformation(
        staticCode,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &signingInformation
    ) == errSecSuccess,
    let information = signingInformation as? [String: Any] else {
        return ""
    }
    return information[kSecCodeInfoIdentifier as String] as? String ?? ""
}
