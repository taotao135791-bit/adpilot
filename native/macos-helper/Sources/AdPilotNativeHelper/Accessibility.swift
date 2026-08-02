import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

enum ApplicationService {
    static func activate(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: ["pid", "bundleId"])
        try requireAccessibilityPermission()
        let pid = try boundedInteger(
            params["pid"],
            named: "pid",
            range: 1...Int(Int32.max)
        )
        guard let bundleId = params["bundleId"] as? String,
              !bundleId.isEmpty,
              bundleId.utf8.count <= 1_024 else {
            throw HelperFailure("INVALID_PARAMS", "bundleId must be a bounded non-empty string")
        }
        guard let application = NSRunningApplication(processIdentifier: pid_t(pid)),
              application.bundleIdentifier == bundleId else {
            throw HelperFailure(
                "APPLICATION_IDENTITY_MISMATCH",
                "the requested pid and bundle identifier do not identify the same running application"
            )
        }
        guard application.activate(options: [.activateAllWindows]) else {
            throw HelperFailure(
                "APPLICATION_ACTIVATION_FAILED",
                "macOS did not activate the requested application",
                retryable: true
            )
        }
        let frontmost = NSWorkspace.shared.frontmostApplication
        return [
            "activated": true,
            "pid": pid,
            "bundleId": bundleId,
            "frontmost": frontmost?.processIdentifier == pid_t(pid)
                && frontmost?.bundleIdentifier == bundleId
        ]
    }
}

enum AccessibilityService {
    private static func exactWindow(
        _ params: [String: Any]
    ) throws -> (windowId: Int, ownerPid: Int, bundleId: String, target: AXUIElement) {
        try strictKeys(params, allowed: ["windowId", "ownerPid", "bundleId"])
        try requireAccessibilityPermission()
        let windowId = try boundedInteger(
            params["windowId"],
            named: "windowId",
            range: 1...Int(UInt32.max)
        )
        let ownerPid = try boundedInteger(
            params["ownerPid"],
            named: "ownerPid",
            range: 1...Int(Int32.max)
        )
        guard let bundleId = params["bundleId"] as? String,
              !bundleId.isEmpty,
              bundleId.utf8.count <= 1_024 else {
            throw HelperFailure("INVALID_PARAMS", "bundleId must be a bounded non-empty string")
        }
        let identity = try WindowSurfaceIdentity.current(windowId: windowId)
        guard identity.ownerPid == ownerPid, identity.bundleId == bundleId else {
            throw HelperFailure(
                "APPLICATION_IDENTITY_MISMATCH",
                "windowId, ownerPid, and bundleId do not identify the same surface"
            )
        }
        let application = AXUIElementCreateApplication(pid_t(ownerPid))
        let windows = try axElements(application, attribute: kAXWindowsAttribute as CFString)
        guard let target = windows.first(where: { axWindowMatches($0, identity: identity) }) else {
            throw HelperFailure(
                "ACCESSIBILITY_WINDOW_NOT_FOUND",
                "Accessibility could not match the requested CoreGraphics window",
                retryable: true,
                details: ["windowId": windowId]
            )
        }
        return (windowId, ownerPid, bundleId, target)
    }

    static func focusWindow(_ params: [String: Any]) throws -> [String: Any] {
        let exact = try exactWindow(params)
        let windowId = exact.windowId
        let ownerPid = exact.ownerPid
        let bundleId = exact.bundleId
        let target = exact.target
        let application = AXUIElementCreateApplication(pid_t(ownerPid))

        let frontmostResult = AXUIElementSetAttributeValue(
            application,
            kAXFrontmostAttribute as CFString,
            kCFBooleanTrue
        )
        guard frontmostResult == .success else {
            throw axFailure("WINDOW_FOCUS_FAILED", "could not make the application frontmost", frontmostResult)
        }
        let focusedResult = AXUIElementSetAttributeValue(
            target,
            kAXFocusedAttribute as CFString,
            kCFBooleanTrue
        )
        guard focusedResult == .success || focusedResult == .attributeUnsupported else {
            throw axFailure("WINDOW_FOCUS_FAILED", "could not focus the requested window", focusedResult)
        }
        let raiseResult = AXUIElementPerformAction(target, kAXRaiseAction as CFString)
        guard raiseResult == .success else {
            throw axFailure("WINDOW_FOCUS_FAILED", "could not raise the requested window", raiseResult)
        }

        return [
            "focused": true,
            "windowId": windowId,
            "ownerPid": ownerPid,
            "bundleId": bundleId
        ]
    }

    static func closeWindow(
        _ params: [String: Any],
        sessionId: String,
        deadlineUnixMs: Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> [String: Any] {
        try strictKeys(params, allowed: ["surfaceLease"])
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        let descriptor = try WindowSurfaceLease.parse(params["surfaceLease"])
        let lease = try await surfaceLeaseStore.resolve(descriptor, sessionId: sessionId)
        try await surfaceLeaseStore.consume(generation: lease.generation)
        let physicalInputGuard = try PhysicalInputGuard(
            captureBaseline: lease.physicalAnyInputBaseline
        )
        try requireAccessibilityPermission()
        let current = try WindowSurfaceIdentity.current(windowId: lease.identity.windowId)
        guard lease.identity.matches(current) else {
            throw HelperFailure(
                "SURFACE_CHANGED",
                "the target window identity or bounds changed after observation",
                details: ["windowId": lease.identity.windowId]
            )
        }
        let exact = try exactWindow([
            "windowId": lease.identity.windowId,
            "ownerPid": lease.identity.ownerPid,
            "bundleId": lease.identity.bundleId
        ])
        var rawCloseButton: CFTypeRef?
        let closeButtonResult = AXUIElementCopyAttributeValue(
            exact.target,
            kAXCloseButtonAttribute as CFString,
            &rawCloseButton
        )
        guard closeButtonResult == .success,
              let rawCloseButton,
              CFGetTypeID(rawCloseButton) == AXUIElementGetTypeID() else {
            throw axFailure(
                "WINDOW_CLOSE_UNAVAILABLE",
                "Accessibility did not expose an exact-window close control",
                closeButtonResult
            )
        }
        let closeButton = unsafeDowncast(rawCloseButton, to: AXUIElement.self)
        try lease.identity.requireStillCurrent()
        try requireInputDeadline(deadlineUnixMs, inputStarted: false)
        try InputCancellationChannel.shared.requireMayContinue()
        try physicalInputGuard.requireUnchanged()
        let pressResult = AXUIElementPerformAction(closeButton, kAXPressAction as CFString)
        guard pressResult == .success else {
            throw axFailure(
                "WINDOW_CLOSE_FAILED",
                "Accessibility could not press the exact-window close control",
                pressResult
            )
        }
        return [
            "closed": true,
            "windowId": exact.windowId,
            "ownerPid": exact.ownerPid,
            "bundleId": exact.bundleId
        ]
    }

    static func snapshot(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: ["pid", "maxDepth", "maxNodes"])
        try requireAccessibilityPermission()
        let pid = try boundedInteger(
            params["pid"],
            named: "pid",
            range: 1...Int(Int32.max)
        )
        let maxDepth = try boundedInteger(
            params["maxDepth"],
            named: "maxDepth",
            default: 8,
            range: 0...16
        )
        let maxNodes = try boundedInteger(
            params["maxNodes"],
            named: "maxNodes",
            default: 1_000,
            range: 1...4_000
        )
        guard NSRunningApplication(processIdentifier: pid_t(pid)) != nil else {
            throw HelperFailure("APPLICATION_NOT_FOUND", "pid does not identify a running application")
        }

        var budget = SnapshotBudget(maximumNodes: maxNodes)
        let root = snapshotNode(
            AXUIElementCreateApplication(pid_t(pid)),
            depth: 0,
            maximumDepth: maxDepth,
            budget: &budget
        )
        return [
            "pid": pid,
            "generatedAt": ISO8601DateFormatter().string(from: Date()),
            "nodeCount": budget.nodeCount,
            "truncated": budget.truncated,
            "root": root
        ]
    }

    static func focusedElement(_ params: [String: Any]) throws -> [String: Any] {
        try strictKeys(params, allowed: ["pid"])
        try requireAccessibilityPermission()
        let expectedPid: Int?
        if params["pid"] == nil {
            expectedPid = nil
        } else {
            expectedPid = try boundedInteger(
                params["pid"],
                named: "pid",
                range: 1...Int(Int32.max)
            )
        }

        let system = AXUIElementCreateSystemWide()
        var raw: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(
            system,
            kAXFocusedUIElementAttribute as CFString,
            &raw
        )
        guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw axFailure(
                "FOCUSED_ELEMENT_UNAVAILABLE",
                "Accessibility did not report a focused element",
                result
            )
        }
        let element = unsafeDowncast(raw, to: AXUIElement.self)
        var pid: pid_t = 0
        let pidResult = AXUIElementGetPid(element, &pid)
        guard pidResult == .success else {
            throw axFailure(
                "FOCUSED_ELEMENT_UNAVAILABLE",
                "Accessibility did not report the focused element owner",
                pidResult
            )
        }
        if let expectedPid, Int(pid) != expectedPid {
            throw HelperFailure(
                "APPLICATION_IDENTITY_MISMATCH",
                "the focused element belongs to a different application",
                details: ["expectedPid": expectedPid, "actualPid": Int(pid)]
            )
        }
        var budget = SnapshotBudget(maximumNodes: 1)
        return [
            "pid": Int(pid),
            "element": snapshotNode(
                element,
                depth: 0,
                maximumDepth: 0,
                budget: &budget
            )
        ]
    }
}

func requireAccessibilityPermission() throws {
    guard AXIsProcessTrusted() else {
        throw HelperFailure(
            "PERMISSION_DENIED",
            "Accessibility permission is not granted",
            details: ["permission": "accessibility"]
        )
    }
}

struct FocusedInputTarget {
    let element: AXUIElement
    let window: AXUIElement

    func matches(_ other: FocusedInputTarget) -> Bool {
        CFEqual(element, other.element) && CFEqual(window, other.window)
    }

    func requireStillCurrent(on identity: WindowSurfaceIdentity) throws {
        try requireStillCurrent(on: identity, resolve: focusedInputTarget)
    }

    func requireStillCurrent(
        on identity: WindowSurfaceIdentity,
        resolve: (WindowSurfaceIdentity) throws -> FocusedInputTarget
    ) throws {
        let current = try resolve(identity)
        guard matches(current) else {
            throw HelperFailure(
                "FOCUSED_INPUT_CHANGED",
                "the focused input target changed after the action was bound",
                details: ["windowId": identity.windowId, "ownerPid": identity.ownerPid]
            )
        }
    }

    /// Inserts text through the exact Accessibility element captured for this
    /// action. Unlike a process-scoped keyboard event, setting
    /// `kAXSelectedTextAttribute` cannot be rerouted to whichever field happens
    /// to gain focus before macOS consumes the request.
    func insertSelectedText(
        _ text: String,
        on identity: WindowSurfaceIdentity,
        beforeWrite: () throws -> Void = {},
        resolve: (WindowSurfaceIdentity) throws -> FocusedInputTarget = focusedInputTarget,
        isAttributeSettable: (
            AXUIElement,
            CFString,
            UnsafeMutablePointer<DarwinBoolean>
        ) -> AXError = AXUIElementIsAttributeSettable,
        setAttributeValue: (
            AXUIElement,
            CFString,
            CFTypeRef
        ) -> AXError = AXUIElementSetAttributeValue
    ) throws {
        try requireStillCurrent(on: identity, resolve: resolve)
        let attribute = kAXSelectedTextAttribute as CFString
        var settable = DarwinBoolean(false)
        let settableResult = isAttributeSettable(element, attribute, &settable)
        guard settableResult == .success, settable.boolValue else {
            throw axFailure(
                "EXACT_TEXT_TARGET_UNAVAILABLE",
                "the focused control does not expose exact-element text insertion",
                settableResult == .success ? .attributeUnsupported : settableResult
            )
        }

        // The settable probe is an IPC call and can take long enough for focus
        // or sensitivity metadata to change. Resolve the exact target again
        // immediately before the element-bound write.
        try requireStillCurrent(on: identity, resolve: resolve)
        try beforeWrite()
        let writeResult = setAttributeValue(element, attribute, text as CFString)
        guard writeResult == .success else {
            // AX messaging errors do not prove that the target rejected the
            // write, so callers must not retry this text automatically.
            throw HelperFailure(
                "OUTCOME_UNKNOWN",
                "exact-element text insertion did not return a definite result",
                details: ["axError": writeResult.rawValue]
            )
        }
    }
}

func requireNonSensitiveFocusedInput(
    on identity: WindowSurfaceIdentity
) throws -> FocusedInputTarget {
    try focusedInputTarget(on: identity)
}

private func focusedInputTarget(on identity: WindowSurfaceIdentity) throws -> FocusedInputTarget {
    // Keep the Accessibility target and the CoreGraphics surface in one
    // fail-closed check. PID equality alone is insufficient because one
    // application process may own multiple windows or transient panels.
    try identity.requireStillCurrent()
    let system = AXUIElementCreateSystemWide()
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(
        system,
        kAXFocusedUIElementAttribute as CFString,
        &raw
    )
    guard result == .success, let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        throw axFailure(
            "FOCUSED_ELEMENT_UNAVAILABLE",
            "Accessibility did not report a focused input target",
            result
        )
    }
    let element = unsafeDowncast(raw, to: AXUIElement.self)
    var ownerPid: pid_t = 0
    guard AXUIElementGetPid(element, &ownerPid) == .success,
          Int(ownerPid) == identity.ownerPid else {
        throw HelperFailure(
            "TARGET_WINDOW_NOT_FRONTMOST",
            "the focused input target belongs to a different application"
        )
    }
    guard let window = axElement(element, attribute: kAXWindowAttribute as CFString),
          axWindowMatches(window, identity: identity) else {
        throw HelperFailure(
            "FOCUSED_INPUT_WINDOW_MISMATCH",
            "the focused input target does not belong to the captured window",
            details: ["windowId": identity.windowId, "ownerPid": identity.ownerPid]
        )
    }
    let application = AXUIElementCreateApplication(pid_t(identity.ownerPid))
    let exactWindows = try axElements(application, attribute: kAXWindowsAttribute as CFString)
        .filter { axWindowMatches($0, identity: identity) }
    guard exactWindows.count == 1, CFEqual(exactWindows[0], window) else {
        throw HelperFailure(
            "FOCUSED_INPUT_WINDOW_MISMATCH",
            "Accessibility could not uniquely bind the focused input to the captured window",
            details: ["windowId": identity.windowId, "ownerPid": identity.ownerPid]
        )
    }
    let role = axString(element, attribute: kAXRoleAttribute as CFString) ?? ""
    let subrole = axString(element, attribute: kAXSubroleAttribute as CFString) ?? ""
    let metadata = [
        axString(element, attribute: kAXTitleAttribute as CFString) ?? "",
        axString(element, attribute: kAXDescriptionAttribute as CFString) ?? "",
        axString(element, attribute: kAXIdentifierAttribute as CFString) ?? "",
        axString(element, attribute: kAXPlaceholderValueAttribute as CFString) ?? ""
    ]
    guard !isSensitiveFocusedField(role: role, subrole: subrole, metadata: metadata) else {
        throw HelperFailure(
            "SENSITIVE_INPUT_REQUIRES_USER",
            "password, passcode, and one-time-code fields require direct user input"
        )
    }
    return FocusedInputTarget(element: element, window: window)
}

func isSensitiveFocusedField(
    role: String,
    subrole: String,
    metadata: [String]
) -> Bool {
    if isSecureTextRole(role: role, subrole: subrole) {
        return true
    }
    let joined = metadata
        .joined(separator: " ")
        .lowercased()
        .replacingOccurrences(of: "-", with: " ")
        .replacingOccurrences(of: "_", with: " ")
    return [
        "password",
        "passcode",
        "one-time",
        "one time",
        "otp",
        "verification code",
        "security code"
    ].contains(where: joined.contains)
}

func redactSensitiveAccessibilityValue(
    role: String,
    subrole: String,
    metadata: [String],
    value: Any?
) -> Any? {
    guard !isSensitiveFocusedField(
        role: role,
        subrole: subrole,
        metadata: metadata
    ) else {
        return nil
    }
    return value
}

private struct SnapshotBudget {
    let maximumNodes: Int
    var nodeCount = 0
    var truncated = false
}

private func snapshotNode(
    _ element: AXUIElement,
    depth: Int,
    maximumDepth: Int,
    budget: inout SnapshotBudget
) -> [String: Any] {
    guard budget.nodeCount < budget.maximumNodes else {
        budget.truncated = true
        return ["truncated": true]
    }
    budget.nodeCount += 1

    let role = axString(element, attribute: kAXRoleAttribute as CFString) ?? ""
    let subrole = axString(element, attribute: kAXSubroleAttribute as CFString) ?? ""
    let title = axString(element, attribute: kAXTitleAttribute as CFString) ?? ""
    let description = axString(element, attribute: kAXDescriptionAttribute as CFString) ?? ""
    let identifier = axString(element, attribute: kAXIdentifierAttribute as CFString) ?? ""
    let placeholder = axString(
        element,
        attribute: kAXPlaceholderValueAttribute as CFString
    ) ?? ""
    let redacted = isSensitiveFocusedField(
        role: role,
        subrole: subrole,
        metadata: [title, description, identifier, placeholder]
    )
    var node: [String: Any] = [
        "role": boundedText(role),
        "subrole": boundedText(subrole),
        "title": boundedText(title),
        "description": boundedText(description),
        "enabled": axBoolean(element, attribute: kAXEnabledAttribute as CFString) ?? false,
        "focused": axBoolean(element, attribute: kAXFocusedAttribute as CFString) ?? false,
        "redacted": redacted
    ]
    if let bounds = axBounds(element) {
        node["bounds"] = [
            "x": bounds.origin.x,
            "y": bounds.origin.y,
            "width": bounds.width,
            "height": bounds.height
        ]
    } else {
        node["bounds"] = NSNull()
    }
    if let value = redactSensitiveAccessibilityValue(
        role: role,
        subrole: subrole,
        metadata: [title, description, identifier, placeholder],
        value: axSafeScalar(element, attribute: kAXValueAttribute as CFString)
    ) {
        node["value"] = value
    } else {
        node["value"] = NSNull()
    }

    guard depth < maximumDepth, budget.nodeCount < budget.maximumNodes else {
        if depth < maximumDepth {
            budget.truncated = true
        }
        node["children"] = []
        return node
    }

    let rawChildren = (try? axElements(element, attribute: kAXChildrenAttribute as CFString)) ?? []
    var children: [[String: Any]] = []
    for child in rawChildren {
        guard budget.nodeCount < budget.maximumNodes else {
            budget.truncated = true
            break
        }
        children.append(
            snapshotNode(
                child,
                depth: depth + 1,
                maximumDepth: maximumDepth,
                budget: &budget
            )
        )
    }
    node["children"] = children
    return node
}

private func axWindowMatches(_ element: AXUIElement, identity: WindowSurfaceIdentity) -> Bool {
    guard let bounds = axBounds(element), approximatelyEqualAX(bounds, identity.bounds) else {
        return false
    }
    return true
}

private func axElements(_ element: AXUIElement, attribute: CFString) throws -> [AXUIElement] {
    var raw: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, attribute, &raw)
    guard result == .success else {
        throw axFailure(
            "ACCESSIBILITY_QUERY_FAILED",
            "could not read Accessibility children",
            result
        )
    }
    guard let values = raw as? [AXUIElement] else {
        return []
    }
    return values
}

private func axElement(_ element: AXUIElement, attribute: CFString) -> AXUIElement? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let raw,
          CFGetTypeID(raw) == AXUIElementGetTypeID() else {
        return nil
    }
    return unsafeDowncast(raw, to: AXUIElement.self)
}

private func axString(_ element: AXUIElement, attribute: CFString) -> String? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else {
        return nil
    }
    return raw as? String
}

private func axBoolean(_ element: AXUIElement, attribute: CFString) -> Bool? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else {
        return nil
    }
    return raw as? Bool
}

private func axSafeScalar(_ element: AXUIElement, attribute: CFString) -> Any? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success, let raw else {
        return nil
    }
    if let value = raw as? String {
        return boundedText(value)
    }
    if let value = raw as? NSNumber {
        return value
    }
    return nil
}

private func axBounds(_ element: AXUIElement) -> CGRect? {
    var rawPosition: CFTypeRef?
    var rawSize: CFTypeRef?
    guard AXUIElementCopyAttributeValue(
        element,
        kAXPositionAttribute as CFString,
        &rawPosition
    ) == .success,
    AXUIElementCopyAttributeValue(
        element,
        kAXSizeAttribute as CFString,
        &rawSize
    ) == .success,
    let rawPosition,
    let rawSize,
    CFGetTypeID(rawPosition) == AXValueGetTypeID(),
    CFGetTypeID(rawSize) == AXValueGetTypeID() else {
        return nil
    }
    let positionValue = unsafeDowncast(rawPosition, to: AXValue.self)
    let sizeValue = unsafeDowncast(rawSize, to: AXValue.self)
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size),
          size.width > 0,
          size.height > 0 else {
        return nil
    }
    return CGRect(origin: position, size: size)
}

private func isSecureTextRole(role: String, subrole: String) -> Bool {
    role.localizedCaseInsensitiveContains("secure")
        || subrole.localizedCaseInsensitiveContains("secure")
}

private func boundedText(_ value: String, maximumScalars: Int = 4_096) -> String {
    String(value.unicodeScalars.prefix(maximumScalars))
}

private func approximatelyEqualAX(
    _ left: CGRect,
    _ right: CGRect,
    tolerance: CGFloat = 2
) -> Bool {
    abs(left.minX - right.minX) <= tolerance
        && abs(left.minY - right.minY) <= tolerance
        && abs(left.width - right.width) <= tolerance
        && abs(left.height - right.height) <= tolerance
}

private func axFailure(_ code: String, _ message: String, _ result: AXError) -> HelperFailure {
    HelperFailure(
        code,
        message,
        retryable: result == .cannotComplete,
        details: ["axError": result.rawValue]
    )
}
