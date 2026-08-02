import ApplicationServices
import CoreGraphics
import Foundation
import XCTest
@testable import AdPilotNativeHelper

final class ProtocolTests: XCTestCase {
    private let token = "0123456789abcdef0123456789abcdef"

    func testAdvertisesEveryVersionThreeMethodExactlyOnce() {
        XCTAssertEqual(Set(supportedMethods).count, supportedMethods.count)
        XCTAssertEqual(
            Set(supportedMethods),
            Set([
                "hello",
                "permissions.status",
                "permissions.request",
                "permissions.openSettings",
                "displays.list",
                "windows.list",
                "frontmost",
                "application.activate",
                "window.focus",
                "window.close",
                "accessibility.snapshot",
                "accessibility.focusedElement",
                "capture",
                "input.activity",
                "input.move",
                "input.click",
                "input.drag",
                "input.type",
                "input.keypress",
                "input.scroll",
                "wait"
            ])
        )
    }

    func testParsesAuthenticatedVersionedRequest() throws {
        let now: Int64 = 1_700_000_000_000
        let request = try RequestEnvelope.parse(
            jsonData([
                "protocolVersion": 3,
                "id": "request-1",
                "sessionId": "session-1",
                "nonce": "00000000-0000-4000-8000-000000000001",
                "sequence": 7,
                "deadlineUnixMs": now + 5_000,
                "authToken": token,
                "method": "permissions.status",
                "params": [:]
            ]),
            expectedToken: token,
            nowUnixMs: now
        )

        XCTAssertEqual(request.id, "request-1")
        XCTAssertEqual(request.sessionId, "session-1")
        XCTAssertNil(request.actionId)
        XCTAssertEqual(request.sequence, 7)
        XCTAssertEqual(request.deadlineUnixMs, now + 5_000)
        XCTAssertEqual(request.method, "permissions.status")
        XCTAssertTrue(request.params.isEmpty)
    }

    func testRejectsIncorrectAuthenticationWithoutEchoingToken() throws {
        XCTAssertThrowsError(
            try RequestEnvelope.parse(
                jsonData([
                    "protocolVersion": 3,
                    "id": "request-2",
                    "sessionId": "session-1",
                    "nonce": "00000000-0000-4000-8000-000000000002",
                    "sequence": 8,
                    "deadlineUnixMs": 1_700_000_005_000,
                    "authToken": "wrong-token",
                    "method": "hello",
                    "params": [:]
                ]),
                expectedToken: token,
                nowUnixMs: 1_700_000_000_000
            )
        ) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "UNAUTHORIZED")
            XCTAssertFalse(failure?.message.contains(self.token) ?? true)
        }
    }

    func testRejectsUnknownEnvelopeFields() throws {
        XCTAssertThrowsError(
            try RequestEnvelope.parse(
                jsonData([
                    "protocolVersion": 3,
                    "id": "request-extra",
                    "sessionId": "session-1",
                    "nonce": "00000000-0000-4000-8000-000000000003",
                    "sequence": 9,
                    "deadlineUnixMs": 1_700_000_005_000,
                    "authToken": token,
                    "method": "hello",
                    "params": [:],
                    "unexpected": true
                ]),
                expectedToken: token,
                nowUnixMs: 1_700_000_000_000
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_REQUEST")
        }
    }

    func testRequiresSessionNonceAndActionIdentityForNativeInput() throws {
        XCTAssertThrowsError(
            try RequestEnvelope.parse(
                jsonData([
                    "protocolVersion": 3,
                    "id": "missing-action",
                    "sessionId": "session-1",
                    "nonce": "00000000-0000-4000-8000-000000000006",
                    "sequence": 10,
                    "deadlineUnixMs": 1_700_000_005_000,
                    "authToken": token,
                    "method": "input.click",
                    "params": [:]
                ]),
                expectedToken: token,
                nowUnixMs: 1_700_000_000_000
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_REQUEST")
        }

        let parsed = try RequestEnvelope.parse(
            jsonData([
                "protocolVersion": 3,
                "id": "with-action",
                "sessionId": "session-1",
                "actionId": "action-1",
                "nonce": "00000000-0000-4000-8000-000000000007",
                "sequence": 11,
                "deadlineUnixMs": 1_700_000_005_000,
                "authToken": token,
                "method": "input.click",
                "params": [:]
            ]),
            expectedToken: token,
            nowUnixMs: 1_700_000_000_000
        )
        XCTAssertEqual(parsed.actionId, "action-1")
    }

    func testRejectsReplayedNonce() throws {
        var store = ReplayNonceStore(capacity: 2)
        try store.insert("00000000-0000-4000-8000-000000000008")
        XCTAssertThrowsError(
            try store.insert("00000000-0000-4000-8000-000000000008")
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "REPLAY_DETECTED")
        }
        try store.insert("00000000-0000-4000-8000-000000000009")
        try store.insert("00000000-0000-4000-8000-000000000010")
        XCTAssertNoThrow(
            try store.insert("00000000-0000-4000-8000-000000000008")
        )
    }

    func testActionClaimsRejectSemanticReplayWithoutCrossingSessions() throws {
        var claims = ActionClaimStore(capacity: 2)
        try claims.claim(sessionId: "session-a", actionId: "action-1")
        XCTAssertThrowsError(
            try claims.claim(sessionId: "session-a", actionId: "action-1")
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "ACTION_REPLAY_DETECTED")
        }
        XCTAssertNoThrow(
            try claims.claim(sessionId: "session-b", actionId: "action-1")
        )
        XCTAssertThrowsError(
            try claims.claim(sessionId: "session-a", actionId: "action-2")
        ) { error in
            XCTAssertEqual(
                (error as? HelperFailure)?.code,
                "ACTION_CLAIM_CAPACITY_EXCEEDED"
            )
        }
    }

    func testRejectsUnknownParameters() {
        XCTAssertThrowsError(try strictKeys(["authToken": "caller-token"], allowed: [])) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_PARAMS")
        }
    }

    func testRejectsDuplicatePermissionRequestsBeforePrompting() {
        XCTAssertThrowsError(
            try PermissionService.request([
                "permissions": ["screenCapture", "screenCapture"]
            ])
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_PARAMS")
        }
    }

    func testRejectsNoOpTypingBeforeCheckingAccessibility() async {
        do {
            _ = try await InputService.typeText(
                ["text": ""],
                sessionId: "session-1",
                deadlineUnixMs: unixMilliseconds() + 1_000,
                surfaceLeaseStore: SurfaceLeaseStore()
            )
            XCTFail("typing should reject empty text")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_PARAMS")
        }
    }

    func testCaptureValidatesTargetBeforeCheckingScreenPermission() async {
        do {
            _ = try await CaptureService.capture(
                [:],
                sessionId: "session-1",
                deadlineUnixMs: unixMilliseconds() + 1_000,
                surfaceLeaseStore: SurfaceLeaseStore()
            )
            XCTFail("capture should reject a missing target")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_PARAMS")
        }
    }

    func testPermissionStatusReportsCurrentSystemStateWithoutPrompting() throws {
        let status = PermissionService.status()
        let screen = try XCTUnwrap(status["screenCapture"] as? [String: Any])
        let accessibility = try XCTUnwrap(status["accessibility"] as? [String: Any])

        XCTAssertEqual(screen["granted"] as? Bool, CGPreflightScreenCaptureAccess())
        XCTAssertEqual(accessibility["granted"] as? Bool, AXIsProcessTrusted())
        XCTAssertEqual(
            screen["state"] as? String,
            CGPreflightScreenCaptureAccess() ? "granted" : "notGranted"
        )
        XCTAssertEqual(
            accessibility["state"] as? String,
            AXIsProcessTrusted() ? "granted" : "notGranted"
        )
    }

    func testSerializesStructuredFailureAsOneJSONLine() throws {
        let response = failureResponse(
            id: "request-3",
            sequence: 9,
            failure: HelperFailure(
                "PERMISSION_DENIED",
                "Screen Recording permission is not granted",
                details: ["permission": "screenCapture"]
            )
        )
        let data = try serializeJSONLine(response)
        XCTAssertEqual(data.last, 0x0A)

        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any]
        )
        XCTAssertEqual(object["ok"] as? Bool, false)
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "PERMISSION_DENIED")
        XCTAssertEqual(error["retryable"] as? Bool, false)
    }

    func testRejectsExpiredAndUnreasonablyDistantDeadlines() throws {
        let now: Int64 = 1_700_000_000_000
        let expired = try RequestEnvelope.parse(
            jsonData([
                "protocolVersion": 3,
                "id": "expired",
                "sessionId": "session-1",
                "nonce": "00000000-0000-4000-8000-000000000004",
                "sequence": 1,
                "deadlineUnixMs": now - 1,
                "authToken": token,
                "method": "hello",
                "params": [:]
            ]),
            expectedToken: token,
            nowUnixMs: now
        )
        XCTAssertThrowsError(try expired.requireUnexpired(nowUnixMs: now)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "DEADLINE_EXCEEDED")
        }

        XCTAssertThrowsError(
            try RequestEnvelope.parse(
                jsonData([
                    "protocolVersion": 3,
                    "id": "distant",
                    "sessionId": "session-1",
                    "nonce": "00000000-0000-4000-8000-000000000005",
                    "sequence": 2,
                    "deadlineUnixMs": now + maximumDeadlineHorizonMilliseconds + 1,
                    "authToken": token,
                    "method": "hello",
                    "params": [:]
                ]),
                expectedToken: token,
                nowUnixMs: now
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_REQUEST")
        }
    }

    func testBoundedFramerHandlesChunksOversizeAndTruncation() throws {
        var framer = BoundedJSONLineFramer(maximumLineBytes: 5)
        XCTAssertTrue(framer.append(Data("123".utf8)).isEmpty)
        XCTAssertEqual(framer.append(Data("45\n".utf8)), [.line(Data("12345".utf8))])
        XCTAssertEqual(
            framer.append(Data("123456\nok\n".utf8)),
            [.oversized, .line(Data("ok".utf8))]
        )
        XCTAssertTrue(framer.append(Data("tail".utf8)).isEmpty)
        XCTAssertEqual(framer.finish(), [.truncated])
    }

    func testSurfaceLeaseMapsScreenshotPixelsAndIsOneShot() async throws {
        let store = SurfaceLeaseStore()
        let lease = await store.issue(
            identity: WindowSurfaceIdentity(
                windowId: 77,
                ownerPid: 42,
                bundleId: "com.example.browser",
                bounds: CGRect(x: 100, y: 50, width: 800, height: 600)
            ),
            sessionId: "session-1",
            capturePixelWidth: 1_600,
            capturePixelHeight: 1_200,
            durationMs: 10_000,
            physicalAnyInputBaseline: 123,
            nowUnixMs: 1_700_000_000_000
        )
        XCTAssertNil(lease.dictionary["physicalAnyInputBaseline"])
        let descriptor = try WindowSurfaceLease.parse(lease.dictionary)
        XCTAssertNil(descriptor.physicalAnyInputBaseline)
        let point = try descriptor.globalPoint(pixelX: 800, pixelY: 600)
        XCTAssertEqual(point.x, 500, accuracy: 0.001)
        XCTAssertEqual(point.y, 350, accuracy: 0.001)
        let resolved = try await store.resolve(
            descriptor,
            sessionId: "session-1",
            nowUnixMs: 1_700_000_001_000
        )
        XCTAssertEqual(resolved.physicalAnyInputBaseline, 123)
        try await store.consume(
            generation: descriptor.generation,
            nowUnixMs: 1_700_000_001_000
        )
        do {
            _ = try await store.resolve(
                descriptor,
                sessionId: "session-1",
                nowUnixMs: 1_700_000_001_001
            )
            XCTFail("consumed lease must not resolve twice")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.code, "SURFACE_LEASE_INVALID")
        }
    }

    func testSurfaceLeaseRejectsOutOfImageCoordinates() throws {
        let descriptor = try WindowSurfaceLease.parse([
            "generation": "00000000-0000-4000-8000-000000000001",
            "sessionId": "session-1",
            "target": "window",
            "windowId": 77,
            "ownerPid": 42,
            "bundleId": "com.example.browser",
            "bounds": ["x": 0, "y": 0, "width": 800, "height": 600],
            "capturePixels": ["width": 1_600, "height": 1_200],
            "capturedAtUnixMs": 1_700_000_000_000,
            "expiresAtUnixMs": 1_700_000_010_000
        ])
        XCTAssertThrowsError(try descriptor.globalPoint(pixelX: 1_600, pixelY: 0)) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INVALID_PARAMS")
        }
    }

    func testSurfaceLeaseCannotCrossComputerSessions() async throws {
        let store = SurfaceLeaseStore()
        let lease = await store.issue(
            identity: WindowSurfaceIdentity(
                windowId: 77,
                ownerPid: 42,
                bundleId: "com.example.browser",
                bounds: CGRect(x: 0, y: 0, width: 800, height: 600)
            ),
            sessionId: "session-a",
            capturePixelWidth: 800,
            capturePixelHeight: 600,
            durationMs: 10_000,
            physicalAnyInputBaseline: 123,
            nowUnixMs: 1_700_000_000_000
        )
        do {
            _ = try await store.resolve(
                lease,
                sessionId: "session-b",
                nowUnixMs: 1_700_000_001_000
            )
            XCTFail("a surface lease must be bound to its capture session")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.code, "SESSION_MISMATCH")
        }
    }

    func testRegionCoordinatesSupportNegativeOriginDisplaysAndRejectSpanning() throws {
        let local = try captureLocalRegion(
            globalBounds: CGRect(x: -1_900, y: 40, width: 600, height: 400),
            displayBounds: CGRect(x: -1_920, y: 0, width: 1_920, height: 1_080)
        )
        XCTAssertEqual(local, CGRect(x: 20, y: 40, width: 600, height: 400))
        XCTAssertThrowsError(
            try captureLocalRegion(
                globalBounds: CGRect(x: -100, y: 20, width: 200, height: 100),
                displayBounds: CGRect(x: 0, y: 0, width: 1_920, height: 1_080)
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "REGION_OUTSIDE_DISPLAY")
        }
    }

    func testCrossDisplayWindowUsesCenterDisplayAndPreservesNegativeCoordinateMapping() throws {
        let displays = [
            (id: 1, bounds: CGRect(x: -1_920, y: 0, width: 1_920, height: 1_080)),
            (id: 2, bounds: CGRect(x: 0, y: 0, width: 2_560, height: 1_440))
        ]
        XCTAssertEqual(
            preferredDisplayIdentifier(
                windowBounds: CGRect(x: -400, y: 100, width: 1_000, height: 700),
                displays: displays,
                mainDisplayId: 2
            ),
            2
        )
        XCTAssertEqual(
            preferredDisplayIdentifier(
                windowBounds: CGRect(x: -1_300, y: 100, width: 1_400, height: 700),
                displays: displays,
                mainDisplayId: 2
            ),
            1
        )

        let lease = WindowSurfaceLease(
            generation: "00000000-0000-4000-8000-000000000011",
            sessionId: "session-1",
            identity: WindowSurfaceIdentity(
                windowId: 90,
                ownerPid: 42,
                bundleId: "com.example.browser",
                bounds: CGRect(x: -400, y: 100, width: 1_000, height: 700)
            ),
            capturePixelWidth: 2_000,
            capturePixelHeight: 1_400,
            capturedAtUnixMs: 1_700_000_000_000,
            expiresAtUnixMs: 1_700_000_010_000
        )
        let globalCenter = try lease.globalPoint(pixelX: 1_000, pixelY: 700)
        XCTAssertEqual(globalCenter.x, 100, accuracy: 0.001)
        XCTAssertEqual(globalCenter.y, 450, accuracy: 0.001)
    }

    func testSensitiveFocusedFieldsAreNeverEligibleForModelTyping() {
        XCTAssertTrue(
            isSensitiveFocusedField(
                role: "AXTextField",
                subrole: "AXSecureTextField",
                metadata: []
            )
        )
        XCTAssertTrue(
            isSensitiveFocusedField(
                role: "AXTextField",
                subrole: "",
                metadata: ["", "", "otp-input", "One-time verification code"]
            )
        )
        XCTAssertTrue(
            isSensitiveFocusedField(
                role: "AXTextField",
                subrole: "",
                metadata: ["", "", "verification-code", ""]
            )
        )
        XCTAssertFalse(
            isSensitiveFocusedField(
                role: "AXTextField",
                subrole: "",
                metadata: ["Campaign name"]
            )
        )
        XCTAssertNil(
            redactSensitiveAccessibilityValue(
                role: "AXTextField",
                subrole: "",
                metadata: ["", "", "otp-input", ""],
                value: "123456"
            )
        )
        XCTAssertEqual(
            redactSensitiveAccessibilityValue(
                role: "AXTextField",
                subrole: "",
                metadata: ["Campaign name"],
                value: "Brand Search"
            ) as? String,
            "Brand Search"
        )
    }

    func testInputActivityTracksHelperPostedEventsSeparately() {
        let before = InputActivityTracker.shared.snapshot()["leftMouseDown"] ?? 0
        InputActivityTracker.shared.record(.leftMouseDown)
        let after = InputActivityTracker.shared.snapshot()["leftMouseDown"] ?? 0
        XCTAssertEqual(after, before + 1)
    }

    func testInputActivityPhysicalCountersAlwaysUseHidSystemState() {
        var observedSources: [CGEventSourceStateID] = []
        var observedEventTypes: [CGEventType] = []
        let counters = InputActivityService.physicalCounters { source, eventType in
            observedSources.append(source)
            observedEventTypes.append(eventType)
            return eventType == .keyDown ? 7 : 0
        }

        XCTAssertEqual(counters["keyDown"], 7)
        XCTAssertEqual(observedSources.count, 17)
        XCTAssertTrue(observedSources.allSatisfy { $0 == .hidSystemState })
        XCTAssertTrue(observedEventTypes.contains(InputActivityService.anyInputEventType))
        XCTAssertNotNil(counters["anyInput"])
        XCTAssertTrue(observedEventTypes.contains(.otherMouseDown))
        XCTAssertTrue(observedEventTypes.contains(.otherMouseUp))
        XCTAssertTrue(observedEventTypes.contains(.otherMouseDragged))
        XCTAssertTrue(observedEventTypes.contains(.tabletPointer))
        XCTAssertTrue(observedEventTypes.contains(.tabletProximity))
    }

    func testPhysicalInputGuardNeverSubtractsSameTypeHelperEvents() throws {
        var anyInputCounter: UInt32 = 10
        let guardrail = try PhysicalInputGuard(
            captureBaseline: 10,
            anyInputCounter: { anyInputCounter },
            hasActiveInput: { false }
        )
        let helperBefore = InputActivityTracker.shared.snapshot()["leftMouseDown"] ?? 0

        InputActivityTracker.shared.record(.leftMouseDown)
        XCTAssertEqual(
            InputActivityTracker.shared.snapshot()["leftMouseDown"],
            helperBefore + 1
        )
        XCTAssertNoThrow(try guardrail.requireUnchanged())

        // The physical and Helper deltas now have the same event type and
        // magnitude. A subtraction-based guard would incorrectly cancel them.
        anyInputCounter = 11
        XCTAssertThrowsError(try guardrail.requireUnchanged()) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "PHYSICAL_INPUT_DETECTED")
            XCTAssertEqual(failure?.details?["counterChanged"] as? Bool, true)
            XCTAssertEqual(failure?.details?["activeInput"] as? Bool, false)
        }
    }

    func testPhysicalInputGuardRejectsInputHeldBeforeTheActionStarts() throws {
        let guardrail = try PhysicalInputGuard(
            captureBaseline: 10,
            anyInputCounter: { 10 },
            hasActiveInput: { true }
        )
        XCTAssertThrowsError(try guardrail.requireUnchanged()) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "PHYSICAL_INPUT_DETECTED")
            XCTAssertEqual(failure?.details?["counterChanged"] as? Bool, false)
            XCTAssertEqual(failure?.details?["activeInput"] as? Bool, true)
        }
    }

    func testPhysicalInputGuardDoubleReadsAroundTheHeldStateScan() throws {
        var counterReads = 0
        let guardrail = try PhysicalInputGuard(
            captureBaseline: 10,
            anyInputCounter: {
                counterReads += 1
                return counterReads == 1 ? 10 : 11
            },
            hasActiveInput: { false }
        )
        XCTAssertThrowsError(try guardrail.requireUnchanged()) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "PHYSICAL_INPUT_DETECTED")
        }
        XCTAssertEqual(counterReads, 2)
    }

    func testPhysicalInputGuardRejectsALeaseWithoutCaptureBaseline() {
        XCTAssertThrowsError(
            try PhysicalInputGuard(
                captureBaseline: nil,
                anyInputCounter: { 10 },
                hasActiveInput: { false }
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "PHYSICAL_INPUT_BASELINE_MISSING")
        }
    }

    func testActivePhysicalInputChecksAllMouseButtonsAndKeysInHidState() {
        var observedSources: [CGEventSourceStateID] = []
        var observedButtons: [UInt32] = []
        XCTAssertTrue(
            InputActivityService.hasActivePhysicalInput(
                buttonState: { source, button in
                    observedSources.append(source)
                    observedButtons.append(button.rawValue)
                    return button.rawValue == 7
                },
                keyState: { _, _ in false },
                flagsState: { _ in [] }
            )
        )
        XCTAssertEqual(observedButtons, Array(UInt32(0)...7))
        XCTAssertTrue(observedSources.allSatisfy { $0 == .hidSystemState })

        var observedKeys: [CGKeyCode] = []
        XCTAssertTrue(
            InputActivityService.hasActivePhysicalInput(
                buttonState: { _, _ in false },
                keyState: { source, key in
                    observedSources.append(source)
                    observedKeys.append(key)
                    return key == 255
                },
                flagsState: { _ in [] }
            )
        )
        XCTAssertEqual(observedKeys, Array(CGKeyCode(0)...255))
        XCTAssertTrue(observedSources.allSatisfy { $0 == .hidSystemState })
    }

    func testActivePhysicalInputIgnoresLatchedCapsLockButRejectsHeldModifier() {
        XCTAssertFalse(
            InputActivityService.hasActivePhysicalInput(
                buttonState: { _, _ in false },
                keyState: { _, _ in false },
                flagsState: { _ in [.maskAlphaShift] }
            )
        )
        XCTAssertTrue(
            InputActivityService.hasActivePhysicalInput(
                buttonState: { _, _ in false },
                keyState: { _, _ in false },
                flagsState: { _ in [.maskShift] }
            )
        )
    }

    func testProcessScopedInputPosterUsesTheExactOwnerPidWithoutPosting() throws {
        let event = try XCTUnwrap(
            CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        )
        var observedPid: pid_t?

        try postInputEvent(event, ownerPid: 42_424) { ownerPid, _ in
            observedPid = ownerPid
        }

        XCTAssertEqual(observedPid, pid_t(42_424))
    }

    func testProcessScopedInputPosterRejectsInvalidPidsBeforePosting() throws {
        let event = try XCTUnwrap(
            CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        )
        var didPost = false

        XCTAssertThrowsError(
            try postInputEvent(event, ownerPid: 0) { _, _ in
                didPost = true
            }
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INPUT_EVENT_FAILED")
        }
        XCTAssertFalse(didPost)
    }

    func testInputCancellationChannelFailsClosedAfterCancellationMarker() throws {
        let channel = InputCancellationChannel()
        XCTAssertNoThrow(try channel.requireMayContinue())
        channel.cancelForTesting()
        XCTAssertThrowsError(try channel.requireMayContinue()) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "INPUT_CANCELLED")
        }
    }

    func testBoundedDragChecksEveryPhaseAndPostsOneBalancedRelease() async throws {
        let events = try dragFixtureEvents()
        var posted: [CGEventType] = []
        var cancellationChecks = 0
        var deadlineChecks: [Bool] = []
        var surfaceChecks = 0
        var physicalInputChecks = 0

        let count = try await performBoundedDrag(
            down: events.down,
            startRelease: events.startRelease,
            stages: events.stages,
            ownerPid: 42,
            downType: .leftMouseDown,
            draggedType: .leftMouseDragged,
            upType: .leftMouseUp,
            delayMilliseconds: 0,
            validateSurface: { surfaceChecks += 1 },
            checkCancellation: { cancellationChecks += 1 },
            checkPhysicalInput: { physicalInputChecks += 1 },
            checkDeadline: { deadlineChecks.append($0) },
            post: { posted.append($0.type) },
            delay: { _ in }
        )

        XCTAssertEqual(count, 4)
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseDragged, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(cancellationChecks, 4)
        XCTAssertEqual(deadlineChecks, [false, true, true, true])
        XCTAssertEqual(surfaceChecks, 4)
        XCTAssertEqual(physicalInputChecks, 4)
    }

    func testBoundedClickPhysicalInputAfterMouseDownPostsRelease() throws {
        let down = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: CGPoint(x: 10, y: 20),
            mouseButton: .left
        ))
        let up = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: CGPoint(x: 10, y: 20),
            mouseButton: .left
        ))
        var checkpointCount = 0
        var posted: [CGEventType] = []

        XCTAssertThrowsError(
            try performBoundedClickPair(
                down: down,
                up: up,
                ownerPid: 42,
                downType: .leftMouseDown,
                upType: .leftMouseUp,
                checkpoint: { _ in
                    checkpointCount += 1
                    if checkpointCount == 2 {
                        throw HelperFailure(
                            "PHYSICAL_INPUT_DETECTED",
                            "test physical takeover"
                        )
                    }
                },
                post: { posted.append($0.type) }
            )
        ) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "OUTCOME_UNKNOWN")
            XCTAssertEqual(
                failure?.details?["underlyingCode"] as? String,
                "PHYSICAL_INPUT_DETECTED"
            )
        }
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp])
    }

    func testBoundedDragCancellationAfterMouseDownPostsRelease() async throws {
        let events = try dragFixtureEvents()
        var posted: [CGEventType] = []
        var cancellationChecks = 0

        do {
            _ = try await performBoundedDrag(
                down: events.down,
                startRelease: events.startRelease,
                stages: events.stages,
                ownerPid: 42,
                downType: .leftMouseDown,
                draggedType: .leftMouseDragged,
                upType: .leftMouseUp,
                delayMilliseconds: 0,
                validateSurface: {},
                checkCancellation: {
                    cancellationChecks += 1
                    if cancellationChecks == 3 {
                        throw HelperFailure("INPUT_CANCELLED", "test cancellation")
                    }
                },
                checkPhysicalInput: {},
                checkDeadline: { _ in },
                post: { posted.append($0.type) },
                delay: { _ in }
            )
            XCTFail("drag should have failed closed")
        } catch let failure as HelperFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN")
            XCTAssertEqual(failure.details?["underlyingCode"] as? String, "INPUT_CANCELLED")
        }
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
    }

    func testBoundedDragDeadlineAfterMouseDownPostsRelease() async throws {
        let events = try dragFixtureEvents()
        var posted: [CGEventType] = []
        var deadlineChecks = 0

        do {
            _ = try await performBoundedDrag(
                down: events.down,
                startRelease: events.startRelease,
                stages: events.stages,
                ownerPid: 42,
                downType: .leftMouseDown,
                draggedType: .leftMouseDragged,
                upType: .leftMouseUp,
                delayMilliseconds: 0,
                validateSurface: {},
                checkCancellation: {},
                checkPhysicalInput: {},
                checkDeadline: { _ in
                    deadlineChecks += 1
                    if deadlineChecks == 2 {
                        throw HelperFailure("OUTCOME_UNKNOWN", "test deadline")
                    }
                },
                post: { posted.append($0.type) },
                delay: { _ in }
            )
            XCTFail("drag should have failed closed")
        } catch let failure as HelperFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN")
            XCTAssertEqual(failure.details?["underlyingCode"] as? String, "OUTCOME_UNKNOWN")
        }
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp])
    }

    func testBoundedDragSurfaceChangeAfterMouseDownPostsRelease() async throws {
        let events = try dragFixtureEvents()
        var posted: [CGEventType] = []
        var surfaceChecks = 0

        do {
            _ = try await performBoundedDrag(
                down: events.down,
                startRelease: events.startRelease,
                stages: events.stages,
                ownerPid: 42,
                downType: .leftMouseDown,
                draggedType: .leftMouseDragged,
                upType: .leftMouseUp,
                delayMilliseconds: 0,
                validateSurface: {
                    surfaceChecks += 1
                    if surfaceChecks == 2 {
                        throw HelperFailure("SURFACE_CHANGED", "test surface change")
                    }
                },
                checkCancellation: {},
                checkPhysicalInput: {},
                checkDeadline: { _ in },
                post: { posted.append($0.type) },
                delay: { _ in }
            )
            XCTFail("drag should have failed closed")
        } catch let failure as HelperFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN")
            XCTAssertEqual(failure.details?["underlyingCode"] as? String, "SURFACE_CHANGED")
        }
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseUp])
    }

    func testBoundedDragPhysicalInputAfterDelayPostsRelease() async throws {
        let events = try dragFixtureEvents()
        var posted: [CGEventType] = []
        var physicalInputChanged = false

        do {
            _ = try await performBoundedDrag(
                down: events.down,
                startRelease: events.startRelease,
                stages: events.stages,
                ownerPid: 42,
                downType: .leftMouseDown,
                draggedType: .leftMouseDragged,
                upType: .leftMouseUp,
                delayMilliseconds: 1,
                validateSurface: {},
                checkCancellation: {},
                checkPhysicalInput: {
                    if physicalInputChanged {
                        throw HelperFailure(
                            "PHYSICAL_INPUT_DETECTED",
                            "test physical takeover"
                        )
                    }
                },
                checkDeadline: { _ in },
                post: { posted.append($0.type) },
                delay: { _ in physicalInputChanged = true }
            )
            XCTFail("drag should have stopped after physical input")
        } catch let failure as HelperFailure {
            XCTAssertEqual(failure.code, "OUTCOME_UNKNOWN")
            XCTAssertEqual(
                failure.details?["underlyingCode"] as? String,
                "PHYSICAL_INPUT_DETECTED"
            )
        }
        XCTAssertEqual(posted, [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
    }

    func testFocusedInputTargetRejectsElementOrWindowChanges() throws {
        let application = AXUIElementCreateApplication(getpid())
        let sameApplication = AXUIElementCreateApplication(getpid())
        let otherApplication = AXUIElementCreateApplication(getpid() + 1)
        let bound = FocusedInputTarget(element: application, window: application)
        XCTAssertTrue(bound.matches(FocusedInputTarget(element: sameApplication, window: sameApplication)))
        XCTAssertFalse(bound.matches(FocusedInputTarget(element: otherApplication, window: sameApplication)))
        XCTAssertFalse(bound.matches(FocusedInputTarget(element: sameApplication, window: otherApplication)))
    }

    func testProductionInputDispatchIsBoundToTheLeaseOwnerPid() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let inputSource = try String(
            contentsOf: packageRoot
                .appendingPathComponent("Sources")
                .appendingPathComponent("AdPilotNativeHelper")
                .appendingPathComponent("Input.swift"),
            encoding: .utf8
        )

        XCTAssertFalse(inputSource.contains(".post(tap:"))
        XCTAssertFalse(inputSource.contains("CGEventPost("))
        XCTAssertTrue(inputSource.contains("event.postToPid(ownerPid)"))

        let dispatchLines = inputSource
            .split(separator: "\n")
            .filter {
                $0.contains("postInputEvent(")
                    && !$0.contains("func postInputEvent(")
            }
        XCTAssertEqual(dispatchLines.count, 4)
        for line in dispatchLines {
            XCTAssertTrue(
                line.contains("ownerPid: lease.identity.ownerPid"),
                "input dispatch must use the exact PID from its surface lease: \(line)"
            )
        }

        for operation in ["move", "click", "drag", "scroll"] {
            let marker = "static func \(operation)("
            let start = try XCTUnwrap(inputSource.range(of: marker))
            let remainder = inputSource[start.lowerBound...]
            let nextOperation = remainder.dropFirst(marker.count).range(of: "\n    static func ")
            let nextHelper = remainder.dropFirst(marker.count).range(of: "\n    private static func ")
            let end = [nextOperation?.lowerBound, nextHelper?.lowerBound]
                .compactMap { $0 }
                .min() ?? inputSource.endIndex
            let body = inputSource[start.lowerBound..<end]
            XCTAssertTrue(
                body.contains("postInputEvent("),
                "\(operation) must dispatch through the process-scoped input poster"
            )
        }

        for operation in ["move", "click", "typeText", "drag", "keypress", "scroll"] {
            let marker = "static func \(operation)("
            let start = try XCTUnwrap(inputSource.range(of: marker))
            let remainder = inputSource[start.lowerBound...]
            let nextOperation = remainder.dropFirst(marker.count).range(of: "\n    static func ")
            let nextHelper = remainder.dropFirst(marker.count).range(of: "\n    private static func ")
            let end = [nextOperation?.lowerBound, nextHelper?.lowerBound]
                .compactMap { $0 }
                .min() ?? inputSource.endIndex
            let body = inputSource[start.lowerBound..<end]
            XCTAssertTrue(
                body.contains("captureBaseline: lease.physicalAnyInputBaseline"),
                "\(operation) must use the HID baseline bound to the captured lease"
            )
            XCTAssertTrue(
                body.contains("physicalInputGuard.requireUnchanged()"),
                "\(operation) must check physical-HID takeover before native input"
            )
        }

        let typeStart = try XCTUnwrap(inputSource.range(of: "static func typeText("))
        let typeRemainder = inputSource[typeStart.lowerBound...]
        let typeEnd = try XCTUnwrap(typeRemainder.range(of: "\n    static func drag("))
        let typeBody = inputSource[typeStart.lowerBound..<typeEnd.lowerBound]
        XCTAssertTrue(typeBody.contains("focusedTarget.insertSelectedText("))
        XCTAssertTrue(typeBody.contains("physicalInputGuard.requireUnchanged()"))
        XCTAssertFalse(typeBody.contains("postInputEvent("))
        XCTAssertFalse(typeBody.contains("keyboardSetUnicodeString"))
        XCTAssertFalse(typeBody.contains("kAXValueAttribute"))

        let keypressStart = try XCTUnwrap(inputSource.range(of: "static func keypress("))
        let keypressRemainder = inputSource[keypressStart.lowerBound...]
        let keypressEnd = try XCTUnwrap(keypressRemainder.range(of: "\n    static func scroll("))
        let keypressBody = inputSource[keypressStart.lowerBound..<keypressEnd.lowerBound]
        XCTAssertTrue(keypressBody.contains("EXACT_KEY_TARGET_UNAVAILABLE"))
        XCTAssertFalse(keypressBody.contains("postInputEvent("))
        XCTAssertFalse(keypressBody.contains("CGEvent(keyboardEventSource:"))

        XCTAssertTrue(inputSource.contains("checkDeadline: { inputStarted in"))
        XCTAssertTrue(inputSource.contains("validateSurface: { try lease.identity.requireStillCurrent() }"))
    }

    func testSurfaceIdentityRequiresWindowPidBundleAndBoundsToRemainStable() {
        let identity = WindowSurfaceIdentity(
            windowId: 77,
            ownerPid: 42,
            bundleId: "com.example.browser",
            bounds: CGRect(x: 10, y: 20, width: 800, height: 600)
        )
        XCTAssertTrue(identity.matches(identity))
        XCTAssertFalse(
            identity.matches(
                WindowSurfaceIdentity(
                    windowId: 78,
                    ownerPid: 42,
                    bundleId: "com.example.browser",
                    bounds: identity.bounds
                )
            )
        )
        XCTAssertFalse(
            identity.matches(
                WindowSurfaceIdentity(
                    windowId: 77,
                    ownerPid: 43,
                    bundleId: "com.example.browser",
                    bounds: identity.bounds
                )
            )
        )
        XCTAssertFalse(
            identity.matches(
                WindowSurfaceIdentity(
                    windowId: 77,
                    ownerPid: 42,
                    bundleId: "com.example.other",
                    bounds: identity.bounds
                )
            )
        )
        XCTAssertFalse(
            identity.matches(
                WindowSurfaceIdentity(
                    windowId: 77,
                    ownerPid: 42,
                    bundleId: "com.example.browser",
                    bounds: CGRect(x: 11, y: 20, width: 800, height: 600)
                )
            )
        )
    }

    private func dragFixtureEvents() throws -> (
        down: CGEvent,
        startRelease: CGEvent,
        stages: [DragEventStage]
    ) {
        let start = CGPoint(x: 10, y: 20)
        let middle = CGPoint(x: 30, y: 40)
        let end = CGPoint(x: 50, y: 60)
        let down = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDown,
            mouseCursorPosition: start,
            mouseButton: .left
        ))
        let startRelease = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: start,
            mouseButton: .left
        ))
        let middleDrag = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDragged,
            mouseCursorPosition: middle,
            mouseButton: .left
        ))
        let middleRelease = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: middle,
            mouseButton: .left
        ))
        let endDrag = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseDragged,
            mouseCursorPosition: end,
            mouseButton: .left
        ))
        let endRelease = try XCTUnwrap(CGEvent(
            mouseEventSource: nil,
            mouseType: .leftMouseUp,
            mouseCursorPosition: end,
            mouseButton: .left
        ))
        return (
            down,
            startRelease,
            [
                DragEventStage(drag: middleDrag, release: middleRelease),
                DragEventStage(drag: endDrag, release: endRelease)
            ]
        )
    }

    private func jsonData(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
