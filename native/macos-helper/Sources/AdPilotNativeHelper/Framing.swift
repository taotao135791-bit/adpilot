import Foundation

enum JSONLineFrame: Equatable {
    case line(Data)
    case oversized
    case truncated
}

/// Incremental JSONL framing with a hard per-line bound. It never accumulates
/// more than `maximumLineBytes` for an attacker-controlled unterminated line.
struct BoundedJSONLineFramer {
    private let maximumLineBytes: Int
    private var buffer = Data()
    private var discardingOversizedLine = false

    init(maximumLineBytes: Int) {
        precondition(maximumLineBytes > 0)
        self.maximumLineBytes = maximumLineBytes
    }

    mutating func append(_ bytes: Data) -> [JSONLineFrame] {
        var frames: [JSONLineFrame] = []
        var start = bytes.startIndex

        while start < bytes.endIndex {
            if let newline = bytes[start...].firstIndex(of: 0x0A) {
                let fragment = bytes[start..<newline]
                appendFragment(fragment, completesLine: true, into: &frames)
                start = bytes.index(after: newline)
            } else {
                appendFragment(bytes[start..<bytes.endIndex], completesLine: false, into: &frames)
                start = bytes.endIndex
            }
        }
        return frames
    }

    mutating func finish() -> [JSONLineFrame] {
        guard discardingOversizedLine || !buffer.isEmpty else {
            return []
        }
        buffer.removeAll(keepingCapacity: false)
        discardingOversizedLine = false
        return [.truncated]
    }

    private mutating func appendFragment(
        _ fragment: Data.SubSequence,
        completesLine: Bool,
        into frames: inout [JSONLineFrame]
    ) {
        if discardingOversizedLine {
            if completesLine {
                discardingOversizedLine = false
            }
            return
        }

        if buffer.count + fragment.count > maximumLineBytes {
            buffer.removeAll(keepingCapacity: false)
            frames.append(.oversized)
            discardingOversizedLine = !completesLine
            return
        }

        buffer.append(contentsOf: fragment)
        guard completesLine else {
            return
        }

        if buffer.last == 0x0D {
            buffer.removeLast()
        }
        frames.append(.line(buffer))
        buffer = Data()
    }
}
