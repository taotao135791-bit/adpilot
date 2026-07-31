import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

enum InputService {
    static func move(
        _ params: [String: Any],
        sessionId: String,
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["pixelX", "pixelY", "surfaceLease"])
        let pixelX = try finiteDouble(params["pixelX"], named: "pixelX")
        let pixelY = try finiteDouble(params["pixelY"], named: "pixelY")
        let lease = try await resolveLease(
            params["surfaceLease"],
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let point = try lease.globalPoint(pixelX: pixelX, pixelY: pixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create a mouse movement event")
        }
        event.post(tap: .cghidEventTap)
        InputActivityTracker.shared.record(.mouseMoved)
        return ["posted": true, "eventCount": 1]
    }

    static func click(
        _ params: [String: Any],
        sessionId: String,
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
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let point = try lease.globalPoint(pixelX: pixelX, pixelY: pixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
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
            InputActivityTracker.shared.record(downType)
            InputActivityTracker.shared.record(upType)
            eventCount += 2
        }

        return ["posted": true, "eventCount": eventCount]
    }

    static func typeText(
        _ params: [String: Any],
        sessionId: String,
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
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()
        try requireNonSensitiveFocusedInput(expectedPid: lease.identity.ownerPid)

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
                InputActivityTracker.shared.record(.keyDown)
                InputActivityTracker.shared.record(.keyUp)
                eventCount += 2
                start = end
            } catch let failure as HelperFailure {
                throw inputOutcomeFailure(afterEvents: eventCount, underlying: failure)
            }
        }

        return ["posted": true, "eventCount": eventCount, "utf8Bytes": text.utf8.count]
    }

    static func drag(
        _ params: [String: Any],
        sessionId: String,
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(
            params,
            allowed: [
                "fromPixelX",
                "fromPixelY",
                "toPixelX",
                "toPixelY",
                "button",
                "durationMs",
                "surfaceLease"
            ]
        )
        let fromPixelX = try finiteDouble(params["fromPixelX"], named: "fromPixelX")
        let fromPixelY = try finiteDouble(params["fromPixelY"], named: "fromPixelY")
        let toPixelX = try finiteDouble(params["toPixelX"], named: "toPixelX")
        let toPixelY = try finiteDouble(params["toPixelY"], named: "toPixelY")
        let durationMs = try boundedInteger(
            params["durationMs"],
            named: "durationMs",
            default: 250,
            range: 0...2_000
        )
        let buttonName = params["button"] as? String ?? "left"
        let button: CGMouseButton
        let downType: CGEventType
        let draggedType: CGEventType
        let upType: CGEventType
        switch buttonName {
        case "left":
            button = .left
            downType = .leftMouseDown
            draggedType = .leftMouseDragged
            upType = .leftMouseUp
        case "right":
            button = .right
            downType = .rightMouseDown
            draggedType = .rightMouseDragged
            upType = .rightMouseUp
        default:
            throw HelperFailure("INVALID_PARAMS", "button must be left or right")
        }

        let lease = try await resolveLease(
            params["surfaceLease"],
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let start = try lease.globalPoint(pixelX: fromPixelX, pixelY: fromPixelY)
        let end = try lease.globalPoint(pixelX: toPixelX, pixelY: toPixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()

        let stepCount = max(1, min(20, durationMs / 20))
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: start,
            mouseButton: button
        ), let up = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: end,
            mouseButton: button
        ) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create drag boundary events")
        }
        var dragEvents: [CGEvent] = []
        for step in 1...stepCount {
            let fraction = CGFloat(step) / CGFloat(stepCount)
            let point = CGPoint(
                x: start.x + (end.x - start.x) * fraction,
                y: start.y + (end.y - start.y) * fraction
            )
            guard let event = CGEvent(
                mouseEventSource: nil,
                mouseType: draggedType,
                mouseCursorPosition: point,
                mouseButton: button
            ) else {
                throw HelperFailure("INPUT_EVENT_FAILED", "could not create a drag movement event")
            }
            dragEvents.append(event)
        }

        // Once mouse-down is posted, finish the bounded drag without an
        // interruptible await so the helper can never strand the system in a
        // pressed-button state. A timeout after this point is outcome-unknown.
        down.post(tap: .cghidEventTap)
        let delayMicroseconds = stepCount > 0 ? (durationMs * 1_000) / stepCount : 0
        for event in dragEvents {
            event.post(tap: .cghidEventTap)
            if delayMicroseconds > 0 {
                usleep(useconds_t(delayMicroseconds))
            }
        }
        up.post(tap: .cghidEventTap)
        InputActivityTracker.shared.record(downType)
        InputActivityTracker.shared.record(draggedType, count: dragEvents.count)
        InputActivityTracker.shared.record(upType)
        return ["posted": true, "eventCount": dragEvents.count + 2]
    }

    static func keypress(
        _ params: [String: Any],
        sessionId: String,
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["key", "modifiers", "surfaceLease"])
        guard let key = params["key"] as? String,
              let keyCode = virtualKeyCode(key) else {
            throw HelperFailure("INVALID_PARAMS", "key is not a supported macOS key name")
        }
        let modifierNames: [String]
        if let raw = params["modifiers"] {
            guard let values = raw as? [Any], values.allSatisfy({ $0 is String }) else {
                throw HelperFailure("INVALID_PARAMS", "modifiers must be an array of strings")
            }
            modifierNames = values.compactMap { $0 as? String }
        } else {
            modifierNames = []
        }
        guard Set(modifierNames).count == modifierNames.count else {
            throw HelperFailure("INVALID_PARAMS", "modifiers must not contain duplicates")
        }
        let flags = try eventFlags(modifierNames)

        let lease = try await resolveLease(
            params["surfaceLease"],
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()
        try requireNonSensitiveFocusedInput(expectedPid: lease.identity.ownerPid)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create a keypress event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        InputActivityTracker.shared.record(.keyDown)
        InputActivityTracker.shared.record(.keyUp)
        return ["posted": true, "eventCount": 2]
    }

    static func scroll(
        _ params: [String: Any],
        sessionId: String,
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
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        let point = try lease.globalPoint(pixelX: pixelX, pixelY: pixelY)
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        try requireAccessibilityPermission()
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
        InputActivityTracker.shared.record(.scrollWheel)
        return ["posted": true, "eventCount": 1]
    }

    private static func resolveLease(
        _ raw: Any?,
        sessionId: String,
        deadlineUnixMs: Int64,
        store: SurfaceLeaseStore
    ) async throws -> WindowSurfaceLease {
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        let descriptor = try WindowSurfaceLease.parse(raw)
        return try await store.resolve(descriptor, sessionId: sessionId)
    }
}

enum WaitService {
    static func wait(
        _ params: [String: Any],
        deadlineUnixMs: Int64
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["durationMs"])
        let durationMs = try boundedInteger(
            params["durationMs"],
            named: "durationMs",
            range: 0...30_000
        )
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        guard unixMilliseconds() + Int64(durationMs) <= deadlineUnixMs else {
            throw HelperFailure(
                "DEADLINE_EXCEEDED",
                "wait duration exceeds the request deadline"
            )
        }
        if durationMs > 0 {
            try await Task.sleep(for: .milliseconds(durationMs))
        }
        return ["waited": true, "durationMs": durationMs]
    }
}

private func eventFlags(_ modifiers: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier {
        case "command":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "option":
            flags.insert(.maskAlternate)
        case "control":
            flags.insert(.maskControl)
        case "capsLock":
            flags.insert(.maskAlphaShift)
        case "function":
            flags.insert(.maskSecondaryFn)
        default:
            throw HelperFailure(
                "INVALID_PARAMS",
                "modifiers may contain command, shift, option, control, capsLock, or function"
            )
        }
    }
    return flags
}

private func virtualKeyCode(_ raw: String) -> CGKeyCode? {
    let key = raw.lowercased()
    let named: [String: CGKeyCode] = [
        "return": 36,
        "enter": 36,
        "tab": 48,
        "space": 49,
        "delete": 51,
        "backspace": 51,
        "escape": 53,
        "left": 123,
        "right": 124,
        "down": 125,
        "up": 126,
        "home": 115,
        "end": 119,
        "pageup": 116,
        "pagedown": 121,
        "forwarddelete": 117
    ]
    if let keyCode = named[key] {
        return keyCode
    }
    let ansi: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5,
        "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
        "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18,
        "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
        "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30,
        "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
        "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "`": 50
    ]
    guard key.count == 1, let character = key.first else {
        return nil
    }
    return ansi[character]
}

func requireInputDeadline(_ deadlineUnixMs: Int64, inputStarted: Bool) throws {
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
