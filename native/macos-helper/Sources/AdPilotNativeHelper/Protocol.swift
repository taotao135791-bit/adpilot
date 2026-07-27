import Foundation

let protocolVersion = 2
let helperVersion = "0.2.0"
let authenticationEnvironmentKey = "ADPILOT_NATIVE_HELPER_TOKEN"
let maximumRequestBytes = 64 * 1024
let maximumResponseBytes = 72 * 1024 * 1024
let maximumDeadlineHorizonMilliseconds: Int64 = 300_000
let supportedMethods = [
    "hello",
    "permissions.status",
    "permissions.request",
    "windows.list",
    "frontmost",
    "capture",
    "input.click",
    "input.type",
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
