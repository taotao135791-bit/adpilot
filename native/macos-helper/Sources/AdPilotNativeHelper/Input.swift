import ApplicationServices
import CoreGraphics
import Foundation

enum InputService {
    static func click(
        _ params: [String: Any],
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(
            params,
            allowed: ["pixelX", "pixelY", "button", "clickCount", "surfaceLease"]
        )
        let pixelX = try finiteDouble(params["pixelX"], named: "pixelX")
        let pixelY = try finiteDouble(params["pixelY"], named: "pixelY")
        let clickCount = try boundedInteger(
            params["clickCount"],
            named: "clickCount",
            default: 1,
            range: 1...3
        )
        let buttonName: String
        if params["button"] == nil {
            buttonName = "left"
        } else if let value = params["button"] as? String {
            buttonName = value
        } else {
            throw HelperFailure("INVALID_PARAMS", "button must be a string")
        }
        let button: CGMouseButton
        let downType: CGEventType
        let upType: CGEventType
        switch buttonName {
        case "left":
            button = .left
            downType = .leftMouseDown
            upType = .leftMouseUp
        case "right":
            button = .right
            downType = .rightMouseDown
            upType = .rightMouseUp
        default:
            throw HelperFailure("INVALID_PARAMS", "button must be left or right")
        }

        let lease = try await resolveLease(
            params["surfaceLease"],
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let point = try lease.globalPoint(pixelX: pixelX, pixelY: pixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibility()
        try lease.identity.requireStillCurrent()

        var pairs: [(CGEvent, CGEvent)] = []
        for clickIndex in 1...clickCount {
            guard let down = CGEvent(
                mouseEventSource: nil,
                mouseType: downType,
                mouseCursorPosition: point,
                mouseButton: button
            ), let up = CGEvent(
                mouseEventSource: nil,
                mouseType: upType,
                mouseCursorPosition: point,
                mouseButton: button
            ) else {
                throw HelperFailure("INPUT_EVENT_FAILED", "could not create a mouse event")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickIndex))
            pairs.append((down, up))
        }

        var eventCount = 0
        for (down, up) in pairs {
            do {
                try requireInputDeadline(deadlineUnixMs, inputStarted: eventCount > 0)
                try lease.identity.requireStillCurrent()
            } catch let failure as HelperFailure {
                throw inputOutcomeFailure(afterEvents: eventCount, underlying: failure)
            }
            // Never leave a mouse-down half posted: a pair is deliberately
            // emitted without an interruptible await or deadline check.
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            eventCount += 2
        }

        return ["posted": true, "eventCount": eventCount]
    }

    static func typeText(
        _ params: [String: Any],
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["text", "surfaceLease"])
        guard let text = params["text"] as? String else {
            throw HelperFailure("INVALID_PARAMS", "text must be a string")
        }
        guard !text.isEmpty else {
            throw HelperFailure("INVALID_PARAMS", "text must not be empty")
        }
        guard text.utf8.count <= 16_384 else {
            throw HelperFailure("INVALID_PARAMS", "text must not exceed 16384 UTF-8 bytes")
        }

        let lease = try await resolveLease(
            params["surfaceLease"],
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibility()
        try lease.identity.requireStillCurrent()

        let utf16 = Array(text.utf16)
        var start = 0
        var eventCount = 0
        while start < utf16.count {
            do {
                try requireInputDeadline(deadlineUnixMs, inputStarted: eventCount > 0)
                try lease.identity.requireStillCurrent()
                var end = min(start + 20, utf16.count)
                if end < utf16.count, (0xD800...0xDBFF).contains(utf16[end - 1]) {
                    end -= 1
                }
                var chunk = Array(utf16[start..<end])
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                    throw HelperFailure("INPUT_EVENT_FAILED", "could not create a keyboard event")
                }
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                // As with clicks, keep each key down/up pair indivisible.
                down.post(tap: .cghidEventTap)
                up.post(tap: .cghidEventTap)
                eventCount += 2
                start = end
            } catch let failure as HelperFailure {
                throw inputOutcomeFailure(afterEvents: eventCount, underlying: failure)
            }
        }

        return ["posted": true, "eventCount": eventCount, "utf8Bytes": text.utf8.count]
    }

    static func scroll(
        _ params: [String: Any],
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(
            params,
            allowed: ["deltaX", "deltaY", "unit", "pixelX", "pixelY", "surfaceLease"]
        )

        let deltaX = try boundedInteger(
            params["deltaX"],
            named: "deltaX",
            default: 0,
            range: -10_000...10_000
        )
        let deltaY = try boundedInteger(
            params["deltaY"],
            named: "deltaY",
            default: 0,
            range: -10_000...10_000
        )
        guard deltaX != 0 || deltaY != 0 else {
            throw HelperFailure("INVALID_PARAMS", "at least one scroll delta must be non-zero")
        }
        let unitName: String
        if params["unit"] == nil {
            unitName = "pixel"
        } else if let value = params["unit"] as? String {
            unitName = value
        } else {
            throw HelperFailure("INVALID_PARAMS", "unit must be a string")
        }
        let unit: CGScrollEventUnit
        switch unitName {
        case "pixel":
            unit = .pixel
        case "line":
            unit = .line
        default:
            throw HelperFailure("INVALID_PARAMS", "unit must be pixel or line")
        }
        let pixelX = try finiteDouble(params["pixelX"], named: "pixelX")
        let pixelY = try finiteDouble(params["pixelY"], named: "pixelY")

        let lease = try await resolveLease(
            params["surfaceLease"],
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let point = try lease.globalPoint(pixelX: pixelX, pixelY: pixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibility()
        try lease.identity.requireStillCurrent()
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: unit,
            wheelCount: 2,
            wheel1: Int32(deltaY),
            wheel2: Int32(deltaX),
            wheel3: 0
        ) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create a scroll event")
        }
        event.location = point

        try lease.identity.requireStillCurrent()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        event.post(tap: .cghidEventTap)
        return ["posted": true, "eventCount": 1]
    }

    private static func resolveLease(
        _ raw: Any?,
        deadlineUnixMs: Int64,
        store: SurfaceLeaseStore
    ) async throws -> WindowSurfaceLease {
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        let descriptor = try WindowSurfaceLease.parse(raw)
        return try await store.resolve(descriptor)
    }

    private static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw HelperFailure(
                "PERMISSION_DENIED",
                "Accessibility permission is not granted",
                details: ["permission": "accessibility"]
            )
        }
    }
}

private func requireInputDeadline(_ deadlineUnixMs: Int64, inputStarted: Bool) throws {
    guard unixMilliseconds() <= deadlineUnixMs else {
        if inputStarted {
            throw HelperFailure(
                "OUTCOME_UNKNOWN",
                "input crossed its absolute deadline after events may have been posted"
            )
        }
        throw HelperFailure("DEADLINE_EXCEEDED", "input deadline elapsed before any event was posted")
    }
}

private func inputOutcomeFailure(afterEvents eventCount: Int, underlying: HelperFailure) -> HelperFailure {
    guard eventCount > 0 else {
        return underlying
    }
    return HelperFailure(
        "OUTCOME_UNKNOWN",
        "input stopped after one or more events may have been posted",
        details: ["eventsPosted": eventCount, "underlyingCode": underlying.code]
    )
}
