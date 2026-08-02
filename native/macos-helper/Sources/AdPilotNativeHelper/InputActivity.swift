import CoreGraphics
import Foundation

final class InputActivityTracker: @unchecked Sendable {
    static let shared = InputActivityTracker()

    private let lock = NSLock()
    private var helperPostedCounters: [String: UInt64] = [:]

    private init() {}

    func record(_ eventType: CGEventType, count: Int = 1) {
        guard count > 0 else {
            return
        }
        let key = counterName(eventType)
        lock.lock()
        helperPostedCounters[key, default: 0] += UInt64(count)
        lock.unlock()
    }

    func snapshot() -> [String: UInt64] {
        lock.lock()
        defer { lock.unlock() }
        return helperPostedCounters
    }
}

enum InputActivityService {
    /// Swift does not import CoreGraphics' `kCGAnyInputEventType` macro, whose
    /// C value is `~0`. Keep the exact sentinel so one counter covers every
    /// keyboard, mouse, and tablet event, including future event classes.
    static let anyInputEventType = CGEventType(rawValue: ~UInt32(0))!

    static let monitoredEventTypes: [CGEventType] = [
        anyInputEventType,
        .mouseMoved,
        .leftMouseDown,
        .leftMouseUp,
        .leftMouseDragged,
        .rightMouseDown,
        .rightMouseUp,
        .rightMouseDragged,
        .otherMouseDown,
        .otherMouseUp,
        .otherMouseDragged,
        .keyDown,
        .keyUp,
        .flagsChanged,
        .scrollWheel,
        .tabletPointer,
        .tabletProximity
    ]

    /// Returns monotonic physical-HID counters and the current pointer
    /// location. `hidSystemState` excludes CGEvents posted by this Helper, so
    /// the controller must compare `counters` directly and must never subtract
    /// `helperPostedCounters`. The latter remains diagnostic telemetry only.
    static func status(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: [])
        let location = CGEvent(source: nil)?.location ?? .zero
        return [
            "sampledAtUnixMs": unixMilliseconds(),
            "cursor": ["x": location.x, "y": location.y],
            "counters": physicalCounters(),
            "helperPostedCounters": InputActivityTracker.shared.snapshot()
        ]
    }

    /// Injectable only so tests can lock the event-source invariant without
    /// generating real user input. Production always uses CoreGraphics.
    static func physicalCounters(
        counter: (CGEventSourceStateID, CGEventType) -> UInt32 = {
            CGEventSource.counterForEventType($0, eventType: $1)
        }
    ) -> [String: UInt32] {
        Dictionary(uniqueKeysWithValues: monitoredEventTypes.map { eventType in
            (
                counterName(eventType),
                counter(.hidSystemState, eventType)
            )
        })
    }

    static func anyInputCounter(
        counter: (CGEventSourceStateID, CGEventType) -> UInt32 = {
            CGEventSource.counterForEventType($0, eventType: $1)
        }
    ) -> UInt32 {
        counter(.hidSystemState, anyInputEventType)
    }

    /// A counter cannot reveal a button or key that was already held when the
    /// capture lease was issued. Check current HID state as a second,
    /// independent takeover signal. Caps Lock is intentionally excluded from
    /// the flag mask because its latched state is not a currently held key;
    /// the physical key itself is covered by `keyState` while pressed.
    static func hasActivePhysicalInput(
        buttonState: (CGEventSourceStateID, CGMouseButton) -> Bool = {
            CGEventSource.buttonState($0, button: $1)
        },
        keyState: (CGEventSourceStateID, CGKeyCode) -> Bool = {
            CGEventSource.keyState($0, key: $1)
        },
        flagsState: (CGEventSourceStateID) -> CGEventFlags = {
            CGEventSource.flagsState($0)
        }
    ) -> Bool {
        for rawButton in UInt32(0)..<32 {
            if let button = CGMouseButton(rawValue: rawButton),
               buttonState(.hidSystemState, button) {
                return true
            }
        }
        // `NX_NUMKEYCODES` is 256 on macOS. Scan the full virtual-key space so
        // a high-numbered key held before capture cannot evade the counters.
        for rawKey in UInt16(0)...255 where keyState(.hidSystemState, CGKeyCode(rawKey)) {
            return true
        }
        let heldModifierMask: CGEventFlags = [
            .maskShift,
            .maskControl,
            .maskAlternate,
            .maskCommand,
            .maskSecondaryFn
        ]
        return !flagsState(.hidSystemState).intersection(heldModifierMask).isEmpty
    }
}

/// Binds one native action to the physical-HID state captured with its surface
/// lease. CoreGraphics' `.hidSystemState` counter excludes events posted by
/// this Helper, so helper telemetry must never be subtracted from this value.
struct PhysicalInputGuard {
    private let captureBaseline: UInt32
    private let anyInputCounter: () -> UInt32
    private let hasActiveInput: () -> Bool

    init(
        captureBaseline: UInt32?,
        anyInputCounter: @escaping () -> UInt32 = {
            InputActivityService.anyInputCounter()
        },
        hasActiveInput: @escaping () -> Bool = {
            InputActivityService.hasActivePhysicalInput()
        }
    ) throws {
        guard let captureBaseline else {
            throw HelperFailure(
                "PHYSICAL_INPUT_BASELINE_MISSING",
                "the captured surface lease has no physical-input baseline"
            )
        }
        self.captureBaseline = captureBaseline
        self.anyInputCounter = anyInputCounter
        self.hasActiveInput = hasActiveInput
    }

    func requireUnchanged() throws {
        // Double-read the aggregate around the active-state scan. An event
        // completed during the scan changes the second counter; an event still
        // held is caught by the state scan even if its down preceded capture.
        let counterBeforeStateScan = anyInputCounter()
        let activeInput = hasActiveInput()
        let counterAfterStateScan = anyInputCounter()
        guard counterBeforeStateScan == captureBaseline,
              counterAfterStateScan == captureBaseline,
              !activeInput else {
            throw HelperFailure(
                "PHYSICAL_INPUT_DETECTED",
                "physical keyboard or pointer input changed after capture or remains active",
                details: [
                    "counterChanged": counterBeforeStateScan != captureBaseline
                        || counterAfterStateScan != captureBaseline,
                    "activeInput": activeInput
                ]
            )
        }
    }
}

private func counterName(_ eventType: CGEventType) -> String {
    if eventType.rawValue == InputActivityService.anyInputEventType.rawValue {
        return "anyInput"
    }
    switch eventType {
    case .mouseMoved:
        return "mouseMoved"
    case .leftMouseDown:
        return "leftMouseDown"
    case .leftMouseUp:
        return "leftMouseUp"
    case .leftMouseDragged:
        return "leftMouseDragged"
    case .rightMouseDown:
        return "rightMouseDown"
    case .rightMouseUp:
        return "rightMouseUp"
    case .rightMouseDragged:
        return "rightMouseDragged"
    case .otherMouseDown:
        return "otherMouseDown"
    case .otherMouseUp:
        return "otherMouseUp"
    case .otherMouseDragged:
        return "otherMouseDragged"
    case .keyDown:
        return "keyDown"
    case .keyUp:
        return "keyUp"
    case .flagsChanged:
        return "flagsChanged"
    case .scrollWheel:
        return "scrollWheel"
    case .tabletPointer:
        return "tabletPointer"
    case .tabletProximity:
        return "tabletProximity"
    default:
        return "event-\(eventType.rawValue)"
    }
}
