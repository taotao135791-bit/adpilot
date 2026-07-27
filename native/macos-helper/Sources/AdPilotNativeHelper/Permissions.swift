import ApplicationServices
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
            "status": status()
        ]
    }

    private static func permission(_ granted: Bool) -> [String: Any] {
        [
            "state": granted ? "granted" : "notGranted",
            "granted": granted
        ]
    }
}
