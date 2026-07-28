import AppKit
import CoreGraphics
import Foundation

enum DisplayService {
    static func list(_ params: [String: Any]) throws -> [[String: Any]] {
        try strictKeys(params, allowed: [])

        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success else {
            throw HelperFailure(
                "DISPLAY_QUERY_FAILED",
                "CoreGraphics could not count active displays",
                retryable: true
            )
        }
        guard count > 0 else {
            return []
        }

        var identifiers = [CGDirectDisplayID](repeating: 0, count: Int(count))
        let queryResult = identifiers.withUnsafeMutableBufferPointer { buffer in
            CGGetActiveDisplayList(count, buffer.baseAddress, &count)
        }
        guard queryResult == .success else {
            throw HelperFailure(
                "DISPLAY_QUERY_FAILED",
                "CoreGraphics could not enumerate active displays",
                retryable: true
            )
        }

        return identifiers.prefix(Int(count)).map { displayId in
            let bounds = CGDisplayBounds(displayId)
            let mode = CGDisplayCopyDisplayMode(displayId)
            let pointWidth = max(1, Int(bounds.width.rounded()))
            let pointHeight = max(1, Int(bounds.height.rounded()))
            let pixelWidth = mode?.pixelWidth ?? pointWidth
            let pixelHeight = mode?.pixelHeight ?? pointHeight
            return [
                "displayId": Int(displayId),
                "isMain": CGDisplayIsMain(displayId) != 0,
                "isBuiltin": CGDisplayIsBuiltin(displayId) != 0,
                "rotationDegrees": CGDisplayRotation(displayId),
                "scaleFactor": Double(pixelWidth) / Double(pointWidth),
                "bounds": [
                    "x": bounds.origin.x,
                    "y": bounds.origin.y,
                    "width": bounds.width,
                    "height": bounds.height
                ],
                "pixels": [
                    "width": pixelWidth,
                    "height": pixelHeight
                ]
            ]
        }
    }
}
