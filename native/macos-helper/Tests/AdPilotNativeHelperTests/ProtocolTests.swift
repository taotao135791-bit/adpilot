import ApplicationServices
import CoreGraphics
import Foundation
import XCTest
@testable import AdPilotNativeHelper

final class ProtocolTests: XCTestCase {
    private let token = "0123456789abcdef0123456789abcdef"

    func testAdvertisesEveryVersionTwoMethodExactlyOnce() {
        XCTAssertEqual(Set(supportedMethods).count, supportedMethods.count)
        XCTAssertEqual(
            Set(supportedMethods),
            Set([
                "hello",
                "permissions.status",
                "permissions.request",
                "windows.list",
                "frontmost",
                "capture",
                "input.click",
                "input.type",
                "input.scroll"
            ])
        )
    }

    func testParsesAuthenticatedVersionedRequest() throws {
        let now: Int64 = 1_700_000_000_000
        let request = try RequestEnvelope.parse(
            jsonData([
                "protocolVersion": 2,
                "id": "request-1",
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
        XCTAssertEqual(request.sequence, 7)
        XCTAssertEqual(request.deadlineUnixMs, now + 5_000)
        XCTAssertEqual(request.method, "permissions.status")
        XCTAssertTrue(request.params.isEmpty)
    }

    func testRejectsIncorrectAuthenticationWithoutEchoingToken() throws {
        XCTAssertThrowsError(
            try RequestEnvelope.parse(
                jsonData([
                    "protocolVersion": 2,
                    "id": "request-2",
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
                    "protocolVersion": 2,
                    "id": "request-extra",
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
                "protocolVersion": 2,
                "id": "expired",
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
                    "protocolVersion": 2,
                    "id": "distant",
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
            capturePixelWidth: 1_600,
            capturePixelHeight: 1_200,
            durationMs: 10_000,
            nowUnixMs: 1_700_000_000_000
        )
        let descriptor = try WindowSurfaceLease.parse(lease.dictionary)
        let point = try descriptor.globalPoint(pixelX: 800, pixelY: 600)
        XCTAssertEqual(point.x, 500, accuracy: 0.001)
        XCTAssertEqual(point.y, 350, accuracy: 0.001)
        _ = try await store.resolve(descriptor, nowUnixMs: 1_700_000_001_000)
        try await store.consume(
            generation: descriptor.generation,
            nowUnixMs: 1_700_000_001_000
        )
        do {
            _ = try await store.resolve(descriptor, nowUnixMs: 1_700_000_001_001)
            XCTFail("consumed lease must not resolve twice")
        } catch {
            XCTAssertEqual((error as? HelperFailure)?.code, "SURFACE_LEASE_INVALID")
        }
    }

    func testSurfaceLeaseRejectsOutOfImageCoordinates() throws {
        let descriptor = try WindowSurfaceLease.parse([
            "generation": "00000000-0000-4000-8000-000000000001",
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

    private func jsonData(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }
}
