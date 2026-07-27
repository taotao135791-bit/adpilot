import AppKit
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum CaptureService {
    private static let maximumDimension = 8_192
    private static let maximumPixels = 24 * 1024 * 1024
    private static let maximumPngBytes = 48 * 1024 * 1024

    private enum RequestedTarget {
        case window(Int)
        case screen(Int?)
    }

    static func capture(
        _ params: [String: Any],
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(
            params,
            allowed: ["target", "windowId", "displayId", "includeCursor", "leaseDurationMs"]
        )
        try requireDeadline(deadlineUnixMs)

        guard let target = params["target"] as? String, ["window", "screen"].contains(target) else {
            throw HelperFailure("INVALID_PARAMS", "target must be window or screen")
        }
        let includeCursor = try boolean(
            params["includeCursor"],
            named: "includeCursor",
            default: true
        )
        let requestedTarget: RequestedTarget
        let leaseDurationMs: Int?
        if target == "window" {
            guard params["displayId"] == nil else {
                throw HelperFailure("INVALID_PARAMS", "displayId is not valid for a window capture")
            }
            leaseDurationMs = try boundedInteger(
                params["leaseDurationMs"],
                named: "leaseDurationMs",
                default: 15_000,
                range: 1_000...30_000
            )
            requestedTarget = .window(
                try boundedInteger(
                    params["windowId"],
                    named: "windowId",
                    range: 1...Int(UInt32.max)
                )
            )
        } else {
            guard params["windowId"] == nil else {
                throw HelperFailure("INVALID_PARAMS", "windowId is not valid for a screen capture")
            }
            guard params["leaseDurationMs"] == nil else {
                throw HelperFailure("INVALID_PARAMS", "leaseDurationMs is only valid for a window capture")
            }
            leaseDurationMs = nil
            if let rawDisplayId = params["displayId"] {
                requestedTarget = .screen(
                    try boundedInteger(
                        rawDisplayId,
                        named: "displayId",
                        range: 0...Int(UInt32.max)
                    )
                )
            } else {
                requestedTarget = .screen(nil)
            }
        }

        guard CGPreflightScreenCaptureAccess() else {
            throw HelperFailure(
                "PERMISSION_DENIED",
                "Screen Recording permission is not granted",
                details: ["permission": "screenCapture"]
            )
        }
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
        } catch {
            throw HelperFailure(
                "CAPTURE_ENUMERATION_FAILED",
                "ScreenCaptureKit could not enumerate shareable content",
                retryable: true,
                details: ["underlying": sanitizedError(error)]
            )
        }
        try requireDeadline(deadlineUnixMs)

        let filter: SCContentFilter
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = includeCursor
        configuration.capturesAudio = false
        configuration.pixelFormat = kCVPixelFormatType_32BGRA

        var source: [String: Any]
        var capturedWindowIdentity: WindowSurfaceIdentity?
        switch requestedTarget {
        case .window(let windowId):
            let identity = try WindowSurfaceIdentity.current(windowId: windowId)
            guard let window = content.windows.first(where: { Int($0.windowID) == windowId }) else {
                throw HelperFailure(
                    "WINDOW_NOT_FOUND",
                    "the requested window is not currently shareable",
                    retryable: true,
                    details: ["windowId": windowId]
                )
            }
            guard let owningApplication = window.owningApplication,
                  Int(owningApplication.processID) == identity.ownerPid,
                  owningApplication.bundleIdentifier == identity.bundleId else {
                throw HelperFailure(
                    "SURFACE_CHANGED",
                    "ScreenCaptureKit and CoreGraphics disagree about the target window owner",
                    details: ["windowId": windowId]
                )
            }
            filter = SCContentFilter(desktopIndependentWindow: window)
            let scale = content.displays
                .first(where: { $0.frame.intersects(window.frame) })
                .map { displayScale($0.displayID) } ?? 1
            let dimensions = boundedCaptureDimensions(
                width: window.frame.width * scale,
                height: window.frame.height * scale
            )
            configuration.width = dimensions.width
            configuration.height = dimensions.height
            // Excluding the shadow makes captured pixels map exactly to the
            // CoreGraphics window bounds used for click coordinates.
            configuration.ignoreShadowsSingleWindow = true
            source = ["target": "window", "windowId": windowId]
            capturedWindowIdentity = identity
        case .screen(let requestedDisplayId):
            let display: SCDisplay
            if let displayId = requestedDisplayId {
                guard let selected = content.displays.first(where: { Int($0.displayID) == displayId }) else {
                    throw HelperFailure(
                        "DISPLAY_NOT_FOUND",
                        "the requested display is not currently shareable",
                        retryable: true
                    )
                }
                display = selected
            } else if let mainDisplayId = NSScreen.main?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
                      let selected = content.displays.first(where: { $0.displayID == mainDisplayId.uint32Value }) {
                display = selected
            } else if let selected = content.displays.first {
                display = selected
            } else {
                throw HelperFailure("DISPLAY_NOT_FOUND", "no shareable display is available", retryable: true)
            }
            filter = SCContentFilter(display: display, excludingWindows: [])
            let scale = displayScale(display.displayID)
            let dimensions = boundedCaptureDimensions(
                width: CGFloat(display.width) * scale,
                height: CGFloat(display.height) * scale
            )
            configuration.width = dimensions.width
            configuration.height = dimensions.height
            source = ["target": "screen", "displayId": Int(display.displayID)]
        }

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
        } catch {
            throw HelperFailure(
                "CAPTURE_FAILED",
                "ScreenCaptureKit could not capture the requested content",
                retryable: true,
                details: ["underlying": sanitizedError(error)]
            )
        }
        try requireDeadline(deadlineUnixMs)
        guard image.width <= maximumDimension,
              image.height <= maximumDimension,
              image.width * image.height <= maximumPixels else {
            throw HelperFailure(
                "CAPTURE_TOO_LARGE",
                "captured image exceeds the bounded pixel budget"
            )
        }

        let png = try pngData(image)
        guard png.count <= maximumPngBytes else {
            throw HelperFailure(
                "CAPTURE_TOO_LARGE",
                "encoded screenshot exceeds the bounded PNG budget"
            )
        }
        var result: [String: Any] = [
            "format": "png",
            "base64": png.base64EncodedString(),
            "width": image.width,
            "height": image.height,
            "capturedAt": ISO8601DateFormatter().string(from: Date()),
            "source": source
        ]
        if let capturedWindowIdentity, let leaseDurationMs {
            let current = try WindowSurfaceIdentity.current(windowId: capturedWindowIdentity.windowId)
            guard capturedWindowIdentity.matches(current) else {
                throw HelperFailure(
                    "SURFACE_CHANGED",
                    "the target window changed while its screenshot was being captured",
                    details: ["windowId": capturedWindowIdentity.windowId]
                )
            }
            let lease = await surfaceLeaseStore.issue(
                identity: current,
                capturePixelWidth: image.width,
                capturePixelHeight: image.height,
                durationMs: leaseDurationMs
            )
            result["surfaceLease"] = lease.dictionary
        } else {
            result["surfaceLease"] = NSNull()
        }
        return result
    }

    private static func pngData(_ image: CGImage) throws -> Data {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            UTType.png.identifier as CFString,
            1,
            nil
        ) else {
            throw HelperFailure("ENCODING_FAILED", "could not create a PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw HelperFailure("ENCODING_FAILED", "could not encode capture as PNG")
        }
        return data as Data
    }

    private static func displayScale(_ displayId: CGDirectDisplayID) -> CGFloat {
        guard let mode = CGDisplayCopyDisplayMode(displayId), mode.width > 0 else {
            return 1
        }
        return CGFloat(mode.pixelWidth) / CGFloat(mode.width)
    }

    private static func boundedCaptureDimensions(
        width requestedWidth: CGFloat,
        height requestedHeight: CGFloat
    ) -> (width: Int, height: Int) {
        let width = max(1, requestedWidth)
        let height = max(1, requestedHeight)
        let dimensionScale = min(
            1,
            CGFloat(maximumDimension) / width,
            CGFloat(maximumDimension) / height
        )
        let pixelScale = sqrt(CGFloat(maximumPixels) / (width * height))
        let scale = min(dimensionScale, pixelScale)
        return (
            max(1, Int((width * scale).rounded(.down))),
            max(1, Int((height * scale).rounded(.down)))
        )
    }

    private static func sanitizedError(_ error: Error) -> String {
        let nsError = error as NSError
        return "\(nsError.domain):\(nsError.code)"
    }
}

private func requireDeadline(_ deadlineUnixMs: Int64) throws {
    guard unixMilliseconds() <= deadlineUnixMs else {
        throw HelperFailure("DEADLINE_EXCEEDED", "capture exceeded its absolute request deadline")
    }
}
