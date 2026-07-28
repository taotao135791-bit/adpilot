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
    /// Returns monotonic HID counters and the current pointer location. The
    /// controller compares two snapshots around an agent action and subtracts
    /// the matching `helperPostedCounters` delta. Any remaining HID events are
    /// treated as user takeover; the helper does not make that policy decision
    /// itself. Counters are typed because a click posts one down and one up,
    /// while only one of those would appear in a generic action count.
    static func status(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: [])
        let location = CGEvent(source: nil)?.location ?? .zero
        return [
            "sampledAtUnixMs": unixMilliseconds(),
            "cursor": ["x": location.x, "y": location.y],
            "counters": [
                "mouseMoved": counter(.mouseMoved),
                "leftMouseDown": counter(.leftMouseDown),
                "leftMouseUp": counter(.leftMouseUp),
                "leftMouseDragged": counter(.leftMouseDragged),
                "rightMouseDown": counter(.rightMouseDown),
                "rightMouseUp": counter(.rightMouseUp),
                "rightMouseDragged": counter(.rightMouseDragged),
                "keyDown": counter(.keyDown),
                "keyUp": counter(.keyUp),
                "flagsChanged": counter(.flagsChanged),
                "scrollWheel": counter(.scrollWheel)
            ],
            "helperPostedCounters": InputActivityTracker.shared.snapshot()
        ]
    }

    private static func counter(_ eventType: CGEventType) -> UInt32 {
        CGEventSource.counterForEventType(.hidSystemState, eventType: eventType)
    }
}

private func counterName(_ eventType: CGEventType) -> String {
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
    case .keyDown:
        return "keyDown"
    case .keyUp:
        return "keyUp"
    case .flagsChanged:
        return "flagsChanged"
    case .scrollWheel:
        return "scrollWheel"
    default:
        return "event-\(eventType.rawValue)"
    }
}
