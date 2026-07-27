import AppKit
import CoreGraphics
import Foundation

enum WindowService {
    static func list(_ params: [String: Any]) throws -> [[String: Any]] {
        try strictKeys(params, allowed: ["includeOffscreen", "owningPid"])

        let includeOffscreen = try boolean(
            params["includeOffscreen"],
            named: "includeOffscreen",
            default: false
        )
        let owningPid: Int?
        if params["owningPid"] == nil {
            owningPid = nil
        } else {
            owningPid = try boundedInteger(
                params["owningPid"],
                named: "owningPid",
                range: 1...Int(Int32.max)
            )
        }

        var options: CGWindowListOption = [.excludeDesktopElements]
        if !includeOffscreen {
            options.insert(.optionOnScreenOnly)
        } else {
            options.insert(.optionAll)
        }

        guard let rawWindows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            throw HelperFailure("WINDOW_QUERY_FAILED", "CoreGraphics did not return a window list", retryable: true)
        }

        var windows: [[String: Any]] = []
        for raw in rawWindows {
            guard let windowNumber = integer(raw[kCGWindowNumber as String]),
                  let ownerPID = integer(raw[kCGWindowOwnerPID as String]),
                  let boundsDictionary = raw[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
                  bounds.width > 1,
                  bounds.height > 1 else {
                continue
            }
            if let owningPid, ownerPID != owningPid {
                continue
            }

            let layer = integer(raw[kCGWindowLayer as String]) ?? 0
            guard layer == 0 else {
                continue
            }

            let application = NSRunningApplication(processIdentifier: pid_t(ownerPID))
            let title = raw[kCGWindowName as String] as? String ?? ""
            let ownerName = raw[kCGWindowOwnerName as String] as? String ?? application?.localizedName ?? ""
            let alpha = (raw[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            let onScreen = raw[kCGWindowIsOnscreen as String] as? Bool ?? false
            // CoreGraphics may list transparent layer-zero companion windows
            // ahead of the application's real front window. They are not
            // visible interaction surfaces and must never win frontmost
            // selection or a surface-lease identity check.
            guard alpha > 0 else {
                continue
            }

            windows.append([
                "windowId": windowNumber,
                "ownerPid": ownerPID,
                "ownerName": ownerName,
                "bundleId": application?.bundleIdentifier ?? "",
                "title": title,
                "layer": layer,
                "alpha": alpha,
                "onScreen": onScreen,
                "bounds": rectangle(bounds)
            ])
        }

        return windows
    }

    static func frontmost(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: [])
        guard let application = NSWorkspace.shared.frontmostApplication else {
            throw HelperFailure("FRONTMOST_UNAVAILABLE", "macOS did not report a frontmost application", retryable: true)
        }
        let pid = Int(application.processIdentifier)
        // Return only a currently visible window. Off-screen utility windows are
        // not guaranteed to appear in ScreenCaptureKit's shareable-content list.
        let candidate = try list(["includeOffscreen": false, "owningPid": pid]).first

        var result: [String: Any] = [
            "ownerPid": pid,
            "ownerName": application.localizedName ?? "",
            "bundleId": application.bundleIdentifier ?? ""
        ]
        if let candidate {
            result["window"] = candidate
        } else {
            result["window"] = NSNull()
        }
        return result
    }

    private static func rectangle(_ rectangle: CGRect) -> [String: Any] {
        [
            "x": rectangle.origin.x,
            "y": rectangle.origin.y,
            "width": rectangle.width,
            "height": rectangle.height
        ]
    }
}
