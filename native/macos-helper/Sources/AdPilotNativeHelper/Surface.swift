import AppKit
import CoreGraphics
import Foundation

struct WindowSurfaceIdentity: Equatable, Sendable {
    let windowId: Int
    let ownerPid: Int
    let bundleId: String
    let bounds: CGRect

    static func current(windowId: Int) throws -> WindowSurfaceIdentity {
        let windows = try WindowService.list(["includeOffscreen": false])
        guard let raw = windows.first(where: { integer($0["windowId"]) == windowId }),
              let ownerPid = integer(raw["ownerPid"]),
              let bundleId = raw["bundleId"] as? String,
              let rawBounds = raw["bounds"] as? [String: Any],
              let bounds = rectangle(from: rawBounds) else {
            throw HelperFailure(
                "SURFACE_CHANGED",
                "the captured window is no longer an on-screen target",
                details: ["windowId": windowId]
            )
        }
        return WindowSurfaceIdentity(
            windowId: windowId,
            ownerPid: ownerPid,
            bundleId: bundleId,
            bounds: bounds
        )
    }

    func requireStillCurrent() throws {
        let current = try Self.current(windowId: windowId)
        guard matches(current) else {
            throw HelperFailure(
                "SURFACE_CHANGED",
                "the target window identity or bounds changed after capture",
                details: ["windowId": windowId]
            )
        }

        guard let frontmost = NSWorkspace.shared.frontmostApplication,
              Int(frontmost.processIdentifier) == ownerPid,
              (frontmost.bundleIdentifier ?? "") == bundleId else {
            throw HelperFailure(
                "TARGET_NOT_FRONTMOST",
                "the captured application is no longer frontmost",
                details: ["windowId": windowId, "ownerPid": ownerPid, "bundleId": bundleId]
            )
        }
        let frontWindow = try WindowService.list([
            "includeOffscreen": false,
            "owningPid": ownerPid
        ]).first
        guard integer(frontWindow?["windowId"]) == windowId else {
            throw HelperFailure(
                "TARGET_WINDOW_NOT_FRONTMOST",
                "the captured window is no longer the application's front window",
                details: ["windowId": windowId, "ownerPid": ownerPid]
            )
        }
    }

    func matches(_ other: WindowSurfaceIdentity) -> Bool {
        other.windowId == windowId
            && other.ownerPid == ownerPid
            && other.bundleId == bundleId
            && approximatelyEqual(other.bounds, bounds)
    }
}

struct WindowSurfaceLease: Equatable, Sendable {
    let generation: String
    let sessionId: String
    let identity: WindowSurfaceIdentity
    let capturePixelWidth: Int
    let capturePixelHeight: Int
    let capturedAtUnixMs: Int64
    let expiresAtUnixMs: Int64
    /// Internal-only HID aggregate sampled immediately before the screenshot.
    /// It is deliberately omitted from the public descriptor so callers
    /// cannot select or replace the takeover authority stored by the Helper.
    let physicalAnyInputBaseline: UInt32?

    init(
        generation: String,
        sessionId: String,
        identity: WindowSurfaceIdentity,
        capturePixelWidth: Int,
        capturePixelHeight: Int,
        capturedAtUnixMs: Int64,
        expiresAtUnixMs: Int64,
        physicalAnyInputBaseline: UInt32? = nil
    ) {
        self.generation = generation
        self.sessionId = sessionId
        self.identity = identity
        self.capturePixelWidth = capturePixelWidth
        self.capturePixelHeight = capturePixelHeight
        self.capturedAtUnixMs = capturedAtUnixMs
        self.expiresAtUnixMs = expiresAtUnixMs
        self.physicalAnyInputBaseline = physicalAnyInputBaseline
    }

    var dictionary: [String: Any] {
        [
            "generation": generation,
            "sessionId": sessionId,
            "target": "window",
            "windowId": identity.windowId,
            "ownerPid": identity.ownerPid,
            "bundleId": identity.bundleId,
            "bounds": [
                "x": identity.bounds.origin.x,
                "y": identity.bounds.origin.y,
                "width": identity.bounds.width,
                "height": identity.bounds.height
            ],
            "capturePixels": [
                "width": capturePixelWidth,
                "height": capturePixelHeight
            ],
            "capturedAtUnixMs": capturedAtUnixMs,
            "expiresAtUnixMs": expiresAtUnixMs
        ]
    }

    static func parse(_ raw: Any?) throws -> WindowSurfaceLease {
        guard let object = raw as? [String: Any] else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease must be an object")
        }
        try strictKeys(
            object,
            allowed: [
                "generation",
                "sessionId",
                "target",
                "windowId",
                "ownerPid",
                "bundleId",
                "bounds",
                "capturePixels",
                "capturedAtUnixMs",
                "expiresAtUnixMs"
            ]
        )
        guard object["target"] as? String == "window" else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease.target must be window")
        }
        guard let generation = object["generation"] as? String,
              UUID(uuidString: generation) != nil else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease.generation must be a UUID")
        }
        guard let sessionId = object["sessionId"] as? String,
              !sessionId.isEmpty,
              sessionId.utf8.count <= 128 else {
            throw HelperFailure(
                "INVALID_PARAMS",
                "surfaceLease.sessionId must be a bounded non-empty string"
            )
        }
        let windowId = try boundedInteger(
            object["windowId"],
            named: "surfaceLease.windowId",
            range: 1...Int(UInt32.max)
        )
        let ownerPid = try boundedInteger(
            object["ownerPid"],
            named: "surfaceLease.ownerPid",
            range: 1...Int(Int32.max)
        )
        guard let bundleId = object["bundleId"] as? String, bundleId.utf8.count <= 1_024 else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease.bundleId must be a bounded string")
        }
        guard let rawBounds = object["bounds"] as? [String: Any],
              let bounds = rectangle(from: rawBounds) else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease.bounds is invalid")
        }
        try strictKeys(rawBounds, allowed: ["x", "y", "width", "height"])
        guard let rawPixels = object["capturePixels"] as? [String: Any] else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease.capturePixels must be an object")
        }
        try strictKeys(rawPixels, allowed: ["width", "height"])
        let capturePixelWidth = try boundedInteger(
            rawPixels["width"],
            named: "surfaceLease.capturePixels.width",
            range: 1...8_192
        )
        let capturePixelHeight = try boundedInteger(
            rawPixels["height"],
            named: "surfaceLease.capturePixels.height",
            range: 1...8_192
        )
        guard let capturedAtUnixMs = integer64(object["capturedAtUnixMs"]), capturedAtUnixMs > 0,
              let expiresAtUnixMs = integer64(object["expiresAtUnixMs"]),
              expiresAtUnixMs >= capturedAtUnixMs else {
            throw HelperFailure("INVALID_PARAMS", "surfaceLease timestamps are invalid")
        }
        return WindowSurfaceLease(
            generation: generation.lowercased(),
            sessionId: sessionId,
            identity: WindowSurfaceIdentity(
                windowId: windowId,
                ownerPid: ownerPid,
                bundleId: bundleId,
                bounds: bounds
            ),
            capturePixelWidth: capturePixelWidth,
            capturePixelHeight: capturePixelHeight,
            capturedAtUnixMs: capturedAtUnixMs,
            expiresAtUnixMs: expiresAtUnixMs
        )
    }

    func matchesPublicDescriptor(_ descriptor: WindowSurfaceLease) -> Bool {
        generation == descriptor.generation
            && sessionId == descriptor.sessionId
            && identity == descriptor.identity
            && capturePixelWidth == descriptor.capturePixelWidth
            && capturePixelHeight == descriptor.capturePixelHeight
            && capturedAtUnixMs == descriptor.capturedAtUnixMs
            && expiresAtUnixMs == descriptor.expiresAtUnixMs
    }

    func globalPoint(pixelX: Double, pixelY: Double) throws -> CGPoint {
        guard pixelX >= 0, pixelX < Double(capturePixelWidth),
              pixelY >= 0, pixelY < Double(capturePixelHeight) else {
            throw HelperFailure(
                "INVALID_PARAMS",
                "click coordinates must be inside the captured image",
                details: [
                    "capturePixelWidth": capturePixelWidth,
                    "capturePixelHeight": capturePixelHeight
                ]
            )
        }
        return CGPoint(
            x: identity.bounds.minX + (pixelX / Double(capturePixelWidth)) * identity.bounds.width,
            y: identity.bounds.minY + (pixelY / Double(capturePixelHeight)) * identity.bounds.height
        )
    }
}

actor SurfaceLeaseStore {
    private let maximumLeases: Int
    private var leases: [String: WindowSurfaceLease] = [:]

    init(maximumLeases: Int = 64) {
        self.maximumLeases = maximumLeases
    }

    func issue(
        identity: WindowSurfaceIdentity,
        sessionId: String,
        capturePixelWidth: Int,
        capturePixelHeight: Int,
        durationMs: Int,
        physicalAnyInputBaseline: UInt32,
        nowUnixMs: Int64 = unixMilliseconds()
    ) -> WindowSurfaceLease {
        prune(nowUnixMs: nowUnixMs)
        if leases.count >= maximumLeases,
           let oldest = leases.values.min(by: { $0.capturedAtUnixMs < $1.capturedAtUnixMs }) {
            leases.removeValue(forKey: oldest.generation)
        }
        let lease = WindowSurfaceLease(
            generation: UUID().uuidString.lowercased(),
            sessionId: sessionId,
            identity: identity,
            capturePixelWidth: capturePixelWidth,
            capturePixelHeight: capturePixelHeight,
            capturedAtUnixMs: nowUnixMs,
            expiresAtUnixMs: nowUnixMs + Int64(durationMs),
            physicalAnyInputBaseline: physicalAnyInputBaseline
        )
        leases[lease.generation] = lease
        return lease
    }

    func resolve(
        _ descriptor: WindowSurfaceLease,
        sessionId: String,
        nowUnixMs: Int64 = unixMilliseconds()
    ) throws -> WindowSurfaceLease {
        guard let stored = leases[descriptor.generation],
              stored.matchesPublicDescriptor(descriptor) else {
            throw HelperFailure(
                "SURFACE_LEASE_INVALID",
                "surface lease is unknown, consumed, or does not match its issued generation"
            )
        }
        guard stored.sessionId == sessionId else {
            throw HelperFailure(
                "SESSION_MISMATCH",
                "surface lease belongs to a different computer session"
            )
        }
        guard nowUnixMs <= stored.expiresAtUnixMs else {
            leases.removeValue(forKey: stored.generation)
            throw HelperFailure("SURFACE_LEASE_EXPIRED", "surface lease expired before input execution")
        }
        prune(nowUnixMs: nowUnixMs)
        return stored
    }

    func consume(generation: String, nowUnixMs: Int64 = unixMilliseconds()) throws {
        guard let lease = leases.removeValue(forKey: generation) else {
            throw HelperFailure("SURFACE_LEASE_INVALID", "surface lease was already consumed")
        }
        guard nowUnixMs <= lease.expiresAtUnixMs else {
            throw HelperFailure("SURFACE_LEASE_EXPIRED", "surface lease expired before input execution")
        }
    }

    private func prune(nowUnixMs: Int64) {
        leases = leases.filter { $0.value.expiresAtUnixMs >= nowUnixMs }
    }
}

private func rectangle(from object: [String: Any]) -> CGRect? {
    guard let x = try? finiteDouble(object["x"], named: "x"),
          let y = try? finiteDouble(object["y"], named: "y"),
          let width = try? finiteDouble(object["width"], named: "width"),
          let height = try? finiteDouble(object["height"], named: "height"),
          width > 0,
          height > 0 else {
        return nil
    }
    return CGRect(x: x, y: y, width: width, height: height)
}

private func approximatelyEqual(_ left: CGRect, _ right: CGRect, tolerance: CGFloat = 0.5) -> Bool {
    abs(left.minX - right.minX) <= tolerance
        && abs(left.minY - right.minY) <= tolerance
        && abs(left.width - right.width) <= tolerance
        && abs(left.height - right.height) <= tolerance
}
