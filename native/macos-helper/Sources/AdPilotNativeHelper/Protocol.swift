import Foundation

let protocolVersion = 3
let helperVersion = "0.3.0"
let authenticationEnvironmentKey = "ADPILOT_NATIVE_HELPER_TOKEN"
let maximumRequestBytes = 64 * 1024
let maximumResponseBytes = 72 * 1024 * 1024
let maximumDeadlineHorizonMilliseconds: Int64 = 300_000
let supportedMethods = [
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
]

let actionMethods: Set<String> = [
    "application.activate",
    "window.focus",
    "window.close",
    "input.move",
    "input.click",
    "input.drag",
    "input.type",
    "input.keypress",
    "input.scroll"
]

struct HelperFailure: Error, @unchecked Sendable {
    let code: String
    let message: String
    let retryable: Bool
    let details: [String: Any]?

    init(
        _ code: String,
        _ message: String,
        retryable: Bool = false,
        details: [String: Any]? = nil
    ) {
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details
    }
}

struct RequestEnvelope {
    let id: String
    let sessionId: String
    let actionId: String?
    let nonce: String
    let sequence: Int64
    let deadlineUnixMs: Int64
    let method: String
    let params: [String: Any]

    static func parse(_ data: Data, expectedToken: String, nowUnixMs: Int64 = unixMilliseconds()) throws -> RequestEnvelope {
        let raw: Any
        do {
            raw = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw HelperFailure("INVALID_JSON", "request is not valid JSON")
        }

        guard let object = raw as? [String: Any] else {
            throw HelperFailure("INVALID_REQUEST", "request must be a JSON object")
        }
        let allowedKeys: Set<String> = [
            "protocolVersion",
            "id",
            "sessionId",
            "actionId",
            "nonce",
            "sequence",
            "deadlineUnixMs",
            "authToken",
            "method",
            "params"
        ]
        let extraKeys = Set(object.keys).subtracting(allowedKeys)
        guard extraKeys.isEmpty else {
            throw HelperFailure(
                "INVALID_REQUEST",
                "request contains unknown top-level fields",
                details: ["keys": extraKeys.sorted()]
            )
        }
        guard let requestVersion = integer(object["protocolVersion"]), requestVersion == protocolVersion else {
            throw HelperFailure(
                "UNSUPPORTED_PROTOCOL",
                "protocolVersion must be \(protocolVersion)",
                details: ["supportedVersion": protocolVersion]
            )
        }
        guard let id = object["id"] as? String, !id.isEmpty, id.utf8.count <= 128 else {
            throw HelperFailure("INVALID_REQUEST", "id must be a non-empty string of at most 128 bytes")
        }
        guard let sessionId = object["sessionId"] as? String,
              !sessionId.isEmpty,
              sessionId.utf8.count <= 128 else {
            throw HelperFailure(
                "INVALID_REQUEST",
                "sessionId must be a non-empty string of at most 128 bytes"
            )
        }
        let actionId: String?
        if let rawActionId = object["actionId"] {
            guard let parsed = rawActionId as? String,
                  !parsed.isEmpty,
                  parsed.utf8.count <= 128 else {
                throw HelperFailure(
                    "INVALID_REQUEST",
                    "actionId must be a non-empty string of at most 128 bytes"
                )
            }
            actionId = parsed
        } else {
            actionId = nil
        }
        guard let nonce = object["nonce"] as? String,
              nonce.utf8.count <= 64,
              UUID(uuidString: nonce) != nil else {
            throw HelperFailure("INVALID_REQUEST", "nonce must be a UUID")
        }
        guard let sequence = integer64(object["sequence"]), sequence > 0 else {
            throw HelperFailure("INVALID_REQUEST", "sequence must be a positive integer")
        }
        guard let deadlineUnixMs = integer64(object["deadlineUnixMs"]), deadlineUnixMs > 0 else {
            throw HelperFailure("INVALID_REQUEST", "deadlineUnixMs must be a positive integer")
        }
        guard deadlineUnixMs <= nowUnixMs + maximumDeadlineHorizonMilliseconds else {
            throw HelperFailure(
                "INVALID_REQUEST",
                "deadlineUnixMs exceeds the maximum request horizon",
                details: ["maximumHorizonMs": maximumDeadlineHorizonMilliseconds]
            )
        }
        guard let suppliedToken = object["authToken"] as? String,
              constantTimeEqual(suppliedToken, expectedToken) else {
            throw HelperFailure("UNAUTHORIZED", "request authentication failed")
        }
        guard let method = object["method"] as? String, !method.isEmpty, method.utf8.count <= 128 else {
            throw HelperFailure("INVALID_REQUEST", "method must be a non-empty string of at most 128 bytes")
        }
        if actionMethods.contains(method), actionId == nil {
            throw HelperFailure("INVALID_REQUEST", "\(method) requires an actionId")
        }

        let params: [String: Any]
        if let value = object["params"] {
            guard let parsed = value as? [String: Any] else {
                throw HelperFailure("INVALID_PARAMS", "params must be a JSON object")
            }
            params = parsed
        } else {
            params = [:]
        }

        return RequestEnvelope(
            id: id,
            sessionId: sessionId,
            actionId: actionId,
            nonce: nonce.lowercased(),
            sequence: sequence,
            deadlineUnixMs: deadlineUnixMs,
            method: method,
            params: params
        )
    }

    func requireUnexpired(nowUnixMs: Int64 = unixMilliseconds()) throws {
        guard nowUnixMs <= deadlineUnixMs else {
            throw HelperFailure(
                "DEADLINE_EXCEEDED",
                "the request deadline elapsed before execution",
                details: ["deadlineUnixMs": deadlineUnixMs]
            )
        }
    }
}

/// Sequence numbers provide the primary replay barrier. Nonces add an
/// independent, bounded duplicate detector so a malformed client cannot reuse
/// a previously authenticated envelope even if its sequence bookkeeping is
/// reset before the helper exits.
struct ReplayNonceStore {
    private let capacity: Int
    private var ordered: [String] = []
    private var values: Set<String> = []

    init(capacity: Int = 4_096) {
        precondition(capacity > 0)
        self.capacity = capacity
    }

    mutating func insert(_ nonce: String) throws {
        guard !values.contains(nonce) else {
            throw HelperFailure("REPLAY_DETECTED", "request nonce has already been used")
        }
        values.insert(nonce)
        ordered.append(nonce)
        if ordered.count > capacity {
            let evicted = ordered.removeFirst()
            values.remove(evicted)
        }
    }
}

/// Claims semantic action identities for the lifetime of this authenticated
/// helper process. Entries are never evicted: once the bounded capacity is
/// reached the helper rejects new actions and must be restarted, which also
/// rotates the process token. This is safer than allowing an old mutation
/// actionId to become replayable after LRU eviction.
struct ActionClaimStore {
    private let capacity: Int
    private var claimed: Set<String> = []

    init(capacity: Int = 4_096) {
        precondition(capacity > 0)
        self.capacity = capacity
    }

    mutating func claim(sessionId: String, actionId: String) throws {
        let key = "\(sessionId.utf8.count):\(sessionId)\(actionId)"
        guard !claimed.contains(key) else {
            throw HelperFailure(
                "ACTION_REPLAY_DETECTED",
                "actionId has already been claimed in this computer session"
            )
        }
        guard claimed.count < capacity else {
            throw HelperFailure(
                "ACTION_CLAIM_CAPACITY_EXCEEDED",
                "native helper action claim capacity is exhausted; restart the helper before continuing"
            )
        }
        claimed.insert(key)
    }
}

func unixMilliseconds(_ date: Date = Date()) -> Int64 {
    Int64((date.timeIntervalSince1970 * 1_000).rounded(.down))
}

func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        return nil
    }
    let doubleValue = number.doubleValue
    guard doubleValue.isFinite, doubleValue.rounded(.towardZero) == doubleValue else {
        return nil
    }
    return Int(exactly: number.int64Value)
}

func integer64(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        return nil
    }
    let doubleValue = number.doubleValue
    guard doubleValue.isFinite, doubleValue.rounded(.towardZero) == doubleValue else {
        return nil
    }
    return number.int64Value
}

func finiteDouble(_ value: Any?, named name: String) throws -> Double {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
        throw HelperFailure("INVALID_PARAMS", "\(name) must be a number")
    }
    let result = number.doubleValue
    guard result.isFinite else {
        throw HelperFailure("INVALID_PARAMS", "\(name) must be finite")
    }
    return result
}

func boolean(_ value: Any?, named name: String, default defaultValue: Bool? = nil) throws -> Bool {
    if value == nil, let defaultValue {
        return defaultValue
    }
    guard let result = value as? Bool else {
        throw HelperFailure("INVALID_PARAMS", "\(name) must be a boolean")
    }
    return result
}

func boundedInteger(
    _ value: Any?,
    named name: String,
    default defaultValue: Int? = nil,
    range: ClosedRange<Int>
) throws -> Int {
    if value == nil, let defaultValue {
        return defaultValue
    }
    guard let parsed = integer(value), range.contains(parsed) else {
        throw HelperFailure(
            "INVALID_PARAMS",
            "\(name) must be an integer between \(range.lowerBound) and \(range.upperBound)"
        )
    }
    return parsed
}

func strictKeys(_ params: [String: Any], allowed: Set<String>) throws {
    let extras = Set(params.keys).subtracting(allowed)
    guard extras.isEmpty else {
        throw HelperFailure(
            "INVALID_PARAMS",
            "unknown parameter keys",
            details: ["keys": extras.sorted()]
        )
    }
}

private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
    let leftBytes = Array(left.utf8)
    let rightBytes = Array(right.utf8)
    let length = max(leftBytes.count, rightBytes.count)
    var difference = UInt(leftBytes.count ^ rightBytes.count)
    for index in 0..<length {
        let lhs = index < leftBytes.count ? leftBytes[index] : 0
        let rhs = index < rightBytes.count ? rightBytes[index] : 0
        difference |= UInt(lhs ^ rhs)
    }
    return difference == 0
}

func successResponse(for request: RequestEnvelope, result: Any) -> [String: Any] {
    [
        "protocolVersion": protocolVersion,
        "id": request.id,
        "sequence": request.sequence,
        "ok": true,
        "result": result
    ]
}

func failureResponse(
    id: String,
    sequence: Int64,
    failure: HelperFailure
) -> [String: Any] {
    var error: [String: Any] = [
        "code": failure.code,
        "message": failure.message,
        "retryable": failure.retryable
    ]
    if let details = failure.details {
        error["details"] = details
    }
    return [
        "protocolVersion": protocolVersion,
        "id": id,
        "sequence": sequence,
        "ok": false,
        "error": error
    ]
}

func serializeJSONLine(_ value: Any) throws -> Data {
    guard JSONSerialization.isValidJSONObject(value) else {
        throw HelperFailure("INTERNAL_ERROR", "response is not JSON serializable")
    }
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard data.count <= maximumResponseBytes else {
        throw HelperFailure(
            "RESPONSE_TOO_LARGE",
            "response exceeds the bounded JSONL output limit"
        )
    }
    data.append(0x0A)
    return data
}
