import ApplicationServices
import CoreGraphics
import Foundation
import XCTest
@testable import AdPilotNativeHelper

final class ExactTextInputTests: XCTestCase {
    private let identity = WindowSurfaceIdentity(
        windowId: 77,
        ownerPid: 42,
        bundleId: "com.example.browser",
        bounds: CGRect(x: 10, y: 20, width: 800, height: 600)
    )

    func testSelectedTextWriteTargetsOnlyTheBoundElement() throws {
        let element = AXUIElementCreateApplication(getpid())
        let window = AXUIElementCreateApplication(getpid())
        let target = FocusedInputTarget(element: element, window: window)
        var beforeWriteCalls = 0
        var writerCalls = 0

        try target.insertSelectedText(
            "campaign name",
            on: identity,
            beforeWrite: { beforeWriteCalls += 1 },
            resolve: { _ in target },
            isAttributeSettable: { observedElement, attribute, settable in
                XCTAssertTrue(CFEqual(observedElement, element))
                XCTAssertTrue(CFEqual(attribute, kAXSelectedTextAttribute as CFString))
                settable.pointee = DarwinBoolean(true)
                return .success
            },
            setAttributeValue: { observedElement, attribute, value in
                writerCalls += 1
                XCTAssertTrue(CFEqual(observedElement, element))
                XCTAssertTrue(CFEqual(attribute, kAXSelectedTextAttribute as CFString))
                XCTAssertTrue(CFEqual(value, "campaign name" as CFString))
                return .success
            }
        )

        XCTAssertEqual(beforeWriteCalls, 1)
        XCTAssertEqual(writerCalls, 1)
    }

    func testUnsupportedSelectedTextFailsBeforeAnyWrite() {
        let element = AXUIElementCreateApplication(getpid())
        let target = FocusedInputTarget(element: element, window: element)
        var writerCalls = 0

        XCTAssertThrowsError(
            try target.insertSelectedText(
                "never written",
                on: identity,
                resolve: { _ in target },
                isAttributeSettable: { _, _, settable in
                    settable.pointee = DarwinBoolean(false)
                    return .success
                },
                setAttributeValue: { _, _, _ in
                    writerCalls += 1
                    return .success
                }
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "EXACT_TEXT_TARGET_UNAVAILABLE")
        }
        XCTAssertEqual(writerCalls, 0)
    }

    func testFocusChangeDuringProbeFailsBeforeWritingEitherElement() {
        let boundElement = AXUIElementCreateApplication(getpid())
        let changedElement = AXUIElementCreateApplication(getpid() + 1)
        let bound = FocusedInputTarget(element: boundElement, window: boundElement)
        let changed = FocusedInputTarget(element: changedElement, window: boundElement)
        var resolutions = 0
        var writerCalls = 0

        XCTAssertThrowsError(
            try bound.insertSelectedText(
                "never redirected",
                on: identity,
                resolve: { _ in
                    resolutions += 1
                    return resolutions == 1 ? bound : changed
                },
                isAttributeSettable: { _, _, settable in
                    settable.pointee = DarwinBoolean(true)
                    return .success
                },
                setAttributeValue: { _, _, _ in
                    writerCalls += 1
                    return .success
                }
            )
        ) { error in
            XCTAssertEqual((error as? HelperFailure)?.code, "FOCUSED_INPUT_CHANGED")
        }
        XCTAssertEqual(writerCalls, 0)
    }

    func testIndeterminateAccessibilityWriteIsOutcomeUnknown() {
        let element = AXUIElementCreateApplication(getpid())
        let target = FocusedInputTarget(element: element, window: element)

        XCTAssertThrowsError(
            try target.insertSelectedText(
                "possibly written",
                on: identity,
                resolve: { _ in target },
                isAttributeSettable: { _, _, settable in
                    settable.pointee = DarwinBoolean(true)
                    return .success
                },
                setAttributeValue: { _, _, _ in .cannotComplete }
            )
        ) { error in
            let failure = error as? HelperFailure
            XCTAssertEqual(failure?.code, "OUTCOME_UNKNOWN")
            XCTAssertFalse(failure?.message.contains("possibly written") ?? true)
        }
    }
}
