import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

enum PermissionService {
    static func status() -> [String: Any] {
        [
            "screenCapture": permission(CGPreflightScreenCaptureAccess()),
            "accessibility": permission(AXIsProcessTrusted())
        ]
    }

    static func request(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: ["permissions"])

        let requested: [String]
        if let rawPermissions = params["permissions"] {
            guard let values = rawPermissions as? [Any],
                  values.allSatisfy({ $0 is String }) else {
                throw HelperFailure("INVALID_PARAMS", "permissions must be an array of strings")
            }
            requested = values.compactMap { $0 as? String }
        } else {
            requested = ["screenCapture", "accessibility"]
        }

        guard !requested.isEmpty else {
            throw HelperFailure("INVALID_PARAMS", "permissions must not be empty")
        }
        guard Set(requested).count == requested.count else {
            throw HelperFailure("INVALID_PARAMS", "permissions must not contain duplicates")
        }
        let allowed = Set(["screenCapture", "accessibility"])
        let unknown = Set(requested).subtracting(allowed)
        guard unknown.isEmpty else {
            throw HelperFailure(
                "INVALID_PARAMS",
                "unknown permission names",
                details: ["permissions": unknown.sorted()]
            )
        }

        var promptAttempted: [String: Bool] = [
            "screenCapture": false,
            "accessibility": false
        ]
        var grantedAfterRequest: [String: Bool] = [:]

        if requested.contains("screenCapture") {
            promptAttempted["screenCapture"] = true
            grantedAfterRequest["screenCapture"] = CGRequestScreenCaptureAccess()
        }
        if requested.contains("accessibility") {
            promptAttempted["accessibility"] = true
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            grantedAfterRequest["accessibility"] = AXIsProcessTrustedWithOptions(options)
        }

        return [
            "promptAttempted": promptAttempted,
            "grantedAfterRequest": grantedAfterRequest,
            "status": status(),
            // Apple documents that ScreenCaptureKit capture may require an app
            // restart after the first grant. The caller must present this as a
            // recommendation, not claim that the permission is already usable.
            "restartRecommended": requested.contains("screenCapture")
                && (grantedAfterRequest["screenCapture"] ?? false)
                && !CGPreflightScreenCaptureAccess()
        ]
    }

    static func openSettings(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: ["permission"])
        guard let permission = params["permission"] as? String else {
            throw HelperFailure("INVALID_PARAMS", "permission must be a string")
        }
        let urlString: String
        switch permission {
        case "screenCapture":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        case "accessibility":
            urlString = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        default:
            throw HelperFailure(
                "INVALID_PARAMS",
                "permission must be screenCapture or accessibility"
            )
        }
        guard let url = URL(string: urlString), NSWorkspace.shared.open(url) else {
            throw HelperFailure(
                "SYSTEM_SETTINGS_UNAVAILABLE",
                "macOS could not open the requested Privacy & Security pane",
                retryable: true,
                details: ["permission": permission]
            )
        }
        return ["opened": true, "permission": permission]
    }

    private static func permission(_ granted: Bool) -> [String: Any] {
        [
            "state": granted ? "granted" : "notGranted",
            "granted": granted
        ]
    }
}
