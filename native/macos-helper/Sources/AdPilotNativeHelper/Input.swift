import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

nonisolated(unsafe) private var nativeInputCancellationWriteFD: Int32 = -1

private func nativeInputCancellationSignalHandler(_ signal: Int32) {
    guard signal == SIGTERM, nativeInputCancellationWriteFD >= 0 else {
        return
    }
    var marker: UInt8 = 1
    withUnsafePointer(to: &marker) { pointer in
        _ = Darwin.write(nativeInputCancellationWriteFD, pointer, 1)
    }
}

/// Converts the host's catchable SIGTERM into a non-blocking self-pipe marker.
/// The signal handler only calls async-signal-safe `write`; normal Swift code
/// consumes the marker at bounded input checkpoints.
final class InputCancellationChannel: @unchecked Sendable {
    static let shared = InputCancellationChannel(installSignalHandler: true)

    private let readFD: Int32
    private let writeFD: Int32
    private let setupFailure: HelperFailure?

    init(installSignalHandler: Bool = false) {
        var descriptors = [Int32](repeating: -1, count: 2)
        guard Darwin.pipe(&descriptors) == 0 else {
            readFD = -1
            writeFD = -1
            setupFailure = HelperFailure(
                "INPUT_CANCELLATION_UNAVAILABLE",
                "could not create the bounded native input cancellation channel"
            )
            return
        }
        readFD = descriptors[0]
        writeFD = descriptors[1]
        setupFailure = nil
        _ = Darwin.fcntl(readFD, F_SETFL, O_NONBLOCK)
        _ = Darwin.fcntl(writeFD, F_SETFL, O_NONBLOCK)
        if installSignalHandler {
            nativeInputCancellationWriteFD = writeFD
            _ = Darwin.signal(SIGTERM, nativeInputCancellationSignalHandler)
        }
    }

    deinit {
        if readFD >= 0 {
            _ = Darwin.close(readFD)
        }
        if writeFD >= 0 {
            _ = Darwin.close(writeFD)
        }
    }

    func requireMayContinue() throws {
        if let setupFailure {
            throw setupFailure
        }
        if Task.isCancelled {
            throw HelperFailure("INPUT_CANCELLED", "native input was cancelled")
        }
        var marker: UInt8 = 0
        let count = withUnsafeMutablePointer(to: &marker) { pointer in
            Darwin.read(readFD, pointer, 1)
        }
        if count > 0 {
            throw HelperFailure("INPUT_CANCELLED", "native input was cancelled")
        }
        if count < 0, errno != EAGAIN, errno != EWOULDBLOCK {
            throw HelperFailure(
                "INPUT_CANCELLATION_UNAVAILABLE",
                "could not read the native input cancellation channel"
            )
        }
    }

    func cancelForTesting() {
        guard writeFD >= 0 else {
            return
        }
        var marker: UInt8 = 1
        withUnsafePointer(to: &marker) { pointer in
            _ = Darwin.write(writeFD, pointer, 1)
        }
    }
}

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
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()
        try InputCancellationChannel.shared.requireMayContinue()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create a mouse movement event")
        }
        try physicalInputGuard.requireUnchanged()
        try postInputEvent(event, ownerPid: lease.identity.ownerPid)
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
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
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
                let priorEventCount = eventCount
                let pairEventCount = try performBoundedClickPair(
                    down: down,
                    up: up,
                    ownerPid: lease.identity.ownerPid,
                    downType: downType,
                    upType: upType,
                    checkpoint: { pairStarted in
                        try lease.identity.requireStillCurrent()
                        try requireInputDeadline(
                            deadlineUnixMs,
                            inputStarted: priorEventCount > 0 || pairStarted
                        )
                        try InputCancellationChannel.shared.requireMayContinue()
                        try physicalInputGuard.requireUnchanged()
                    },
                    post: { event in
                        try postInputEvent(event, ownerPid: lease.identity.ownerPid)
                    }
                )
                eventCount += pairEventCount
            } catch let failure as HelperFailure {
                throw inputOutcomeFailure(afterEvents: eventCount, underlying: failure)
            }
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
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
        try requireAccessibilityPermission()
        try InputCancellationChannel.shared.requireMayContinue()
        let focusedTarget = try requireNonSensitiveFocusedInput(on: lease.identity)

        do {
            // Text is one exact-element Accessibility mutation. There is no
            // fallback to focus-routed CGEvents, the clipboard, or a whole-
            // value replacement if the target cannot insert selected text.
            try focusedTarget.insertSelectedText(
                text,
                on: lease.identity,
                beforeWrite: {
                    // Accessibility probes are cross-process IPC. Recheck all
                    // non-target control signals at the last possible point.
                    try requireInputDeadline(deadlineUnixMs, inputStarted: false)
                    try InputCancellationChannel.shared.requireMayContinue()
                    try physicalInputGuard.requireUnchanged()
                }
            )
        } catch let failure as HelperFailure {
            throw inputOutcomeFailure(afterEvents: 0, underlying: failure)
        }

        return ["posted": true, "eventCount": 1, "utf8Bytes": text.utf8.count]
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
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()

        let stepCount = max(1, min(20, durationMs / 20))
        guard let down = CGEvent(
            mouseEventSource: nil,
            mouseType: downType,
            mouseCursorPosition: start,
            mouseButton: button
        ), let startRelease = CGEvent(
            mouseEventSource: nil,
            mouseType: upType,
            mouseCursorPosition: start,
            mouseButton: button
        ) else {
            throw HelperFailure("INPUT_EVENT_FAILED", "could not create drag boundary events")
        }
        var stages: [DragEventStage] = []
        for step in 1...stepCount {
            let fraction = CGFloat(step) / CGFloat(stepCount)
            let point = CGPoint(
                x: start.x + (end.x - start.x) * fraction,
                y: start.y + (end.y - start.y) * fraction
            )
            guard let drag = CGEvent(
                mouseEventSource: nil,
                mouseType: draggedType,
                mouseCursorPosition: point,
                mouseButton: button
            ), let release = CGEvent(
                mouseEventSource: nil,
                mouseType: upType,
                mouseCursorPosition: point,
                mouseButton: button
            ) else {
                throw HelperFailure("INPUT_EVENT_FAILED", "could not create a drag movement event")
            }
            stages.append(DragEventStage(drag: drag, release: release))
        }

        let delayMilliseconds = stepCount > 0 ? durationMs / stepCount : 0
        let eventCount = try await performBoundedDrag(
            down: down,
            startRelease: startRelease,
            stages: stages,
            ownerPid: lease.identity.ownerPid,
            downType: downType,
            draggedType: draggedType,
            upType: upType,
            delayMilliseconds: delayMilliseconds,
            validateSurface: { try lease.identity.requireStillCurrent() },
            checkCancellation: { try InputCancellationChannel.shared.requireMayContinue() },
            checkPhysicalInput: { try physicalInputGuard.requireUnchanged() },
            checkDeadline: { inputStarted in
                try requireInputDeadline(deadlineUnixMs, inputStarted: inputStarted)
            },
            post: { event in
                try postInputEvent(event, ownerPid: lease.identity.ownerPid)
            },
            delay: { milliseconds in
                if milliseconds > 0 {
                    try await Task.sleep(for: .milliseconds(milliseconds))
                }
            }
        )
        return ["posted": true, "eventCount": eventCount]
    }

    static func keypress(
        _ params: [String: Any],
        sessionId: String,
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["key", "modifiers", "surfaceLease"])
        guard let key = params["key"] as? String,
              virtualKeyCode(key) != nil else {
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
        _ = try eventFlags(modifierNames)

        let lease = try await resolveLease(
            params["surfaceLease"],
            sessionId: sessionId,
            deadlineUnixMs: deadlineUnixMs,
            store: surfaceLeaseStore
        )
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
        try requireAccessibilityPermission()
        try lease.identity.requireStillCurrent()
        try InputCancellationChannel.shared.requireMayContinue()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try physicalInputGuard.requireUnchanged()
        throw HelperFailure(
            "EXACT_KEY_TARGET_UNAVAILABLE",
            "focus-routed keypress and hotkey input is disabled because macOS cannot bind it to an exact Accessibility element"
        )
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
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
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
        try InputCancellationChannel.shared.requireMayContinue()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try physicalInputGuard.requireUnchanged()
        try postInputEvent(event, ownerPid: lease.identity.ownerPid)
        InputActivityTracker.shared.record(.scrollWheel)
        return ["posted": true, "eventCount": 1]
    }

    private static func resolveLease(
        _ raw: Any?,
        sessionId: String,
        deadlineUnixMs: Int64,
        store: SurfaceLeaseStore
    ) async throws -> WindowSurfaceLease {
        try InputCancellationChannel.shared.requireMayContinue()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        let descriptor = try WindowSurfaceLease.parse(raw)
        return try await store.resolve(descriptor, sessionId: sessionId)
    }
}

struct DragEventStage {
    let drag: CGEvent
    let release: CGEvent
}

/// Posts one click pair with a takeover checkpoint before both the down and
/// up events. If authority changes after down, cleanup still targets the
/// original lease owner and the result is outcome-unknown rather than success.
func performBoundedClickPair(
    down: CGEvent,
    up: CGEvent,
    ownerPid: Int,
    downType: CGEventType,
    upType: CGEventType,
    checkpoint: (Bool) throws -> Void,
    post: (CGEvent) throws -> Void
) throws -> Int {
    var eventCount = 0
    var mouseDownMayBePosted = false
    do {
        try checkpoint(false)
        // A throwing transport cannot prove that mouse-down was not posted.
        mouseDownMayBePosted = true
        try post(down)
        InputActivityTracker.shared.record(downType)
        eventCount += 1

        try checkpoint(true)
        try post(up)
        InputActivityTracker.shared.record(upType)
        eventCount += 1
        mouseDownMayBePosted = false
        return eventCount
    } catch {
        let underlying: HelperFailure
        if let failure = error as? HelperFailure {
            underlying = failure
        } else if error is CancellationError {
            underlying = HelperFailure("INPUT_CANCELLED", "native input was cancelled")
        } else {
            underlying = HelperFailure(
                "INPUT_EVENT_FAILED",
                "the bounded click pair failed while native input was in flight"
            )
        }
        if mouseDownMayBePosted {
            do {
                // Cleanup bypasses the failed authority check so a takeover
                // cannot strand the lease owner's mouse button in down state.
                try post(up)
                InputActivityTracker.shared.record(upType)
                eventCount += 1
                mouseDownMayBePosted = false
            } catch {
                throw HelperFailure(
                    "MOUSE_RELEASE_FAILED",
                    "native click cleanup could not post mouse-up to the lease owner",
                    details: [
                        "eventsPosted": eventCount,
                        "ownerPid": ownerPid,
                        "underlyingCode": underlying.code
                    ]
                )
            }
        }
        throw inputOutcomeFailure(afterEvents: eventCount, underlying: underlying)
    }
}

/// Posts a drag as a sequence of independently authorized stages. Every normal
/// event is preceded by cancellation, deadline, exact-surface, and physical-HID
/// validation. Once a down event may have been posted, all error paths attempt
/// a process-scoped up event at the last authorized point before propagating an
/// outcome-unknown failure.
func performBoundedDrag(
    down: CGEvent,
    startRelease: CGEvent,
    stages: [DragEventStage],
    ownerPid: Int,
    downType: CGEventType,
    draggedType: CGEventType,
    upType: CGEventType,
    delayMilliseconds: Int,
    validateSurface: () throws -> Void,
    checkCancellation: () throws -> Void,
    checkPhysicalInput: () throws -> Void,
    checkDeadline: (Bool) throws -> Void,
    post: (CGEvent) throws -> Void,
    delay: (Int) async throws -> Void
) async throws -> Int {
    var eventCount = 0
    var mouseDownMayBePosted = false
    var releaseEvent = startRelease

    func checkpoint(inputStarted: Bool) throws {
        try validateSurface()
        try checkDeadline(inputStarted)
        try checkCancellation()
        try checkPhysicalInput()
    }

    do {
        try checkpoint(inputStarted: false)
        // Mark this before calling the poster: a thrown transport error cannot
        // prove that the target process did not receive the mouse-down.
        mouseDownMayBePosted = true
        try post(down)
        InputActivityTracker.shared.record(downType)
        eventCount += 1

        for stage in stages {
            try checkpoint(inputStarted: true)
            try post(stage.drag)
            InputActivityTracker.shared.record(draggedType)
            eventCount += 1
            releaseEvent = stage.release
            if delayMilliseconds > 0 {
                try await delay(delayMilliseconds)
            }
        }

        try checkpoint(inputStarted: true)
        try post(releaseEvent)
        InputActivityTracker.shared.record(upType)
        eventCount += 1
        mouseDownMayBePosted = false
        return eventCount
    } catch {
        let underlying: HelperFailure
        if let failure = error as? HelperFailure {
            underlying = failure
        } else if error is CancellationError {
            underlying = HelperFailure("INPUT_CANCELLED", "native input was cancelled")
        } else {
            underlying = HelperFailure(
                "INPUT_EVENT_FAILED",
                "the bounded drag sequence failed while native input was in flight"
            )
        }

        if mouseDownMayBePosted {
            do {
                // Cleanup intentionally bypasses surface/deadline/cancel/HID
                // checks: releasing the lease owner's button is safer than
                // preserving a logically pressed state after authority changed.
                try post(releaseEvent)
                InputActivityTracker.shared.record(upType)
                eventCount += 1
                mouseDownMayBePosted = false
            } catch {
                throw HelperFailure(
                    "MOUSE_RELEASE_FAILED",
                    "native drag cleanup could not post mouse-up to the lease owner",
                    details: [
                        "eventsPosted": eventCount,
                        "ownerPid": ownerPid,
                        "underlyingCode": underlying.code
                    ]
                )
            }
        }
        throw inputOutcomeFailure(afterEvents: eventCount, underlying: underlying)
    }
}

typealias ProcessScopedInputPost = (_ ownerPid: pid_t, _ event: CGEvent) -> Void

// Route every synthetic event directly to the process captured by the
// one-shot surface lease. A global event stream would let a focus change in
// the validation-to-post gap redirect input into an unrelated application.
func postInputEvent(
    _ event: CGEvent,
    ownerPid: Int,
    using postToProcess: ProcessScopedInputPost = { ownerPid, event in
        event.postToPid(ownerPid)
    }
) throws {
    guard ownerPid > 0, ownerPid <= Int(Int32.max) else {
        throw HelperFailure(
            "INPUT_EVENT_FAILED",
            "the target process identifier is invalid"
        )
    }
    postToProcess(pid_t(ownerPid), event)
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
