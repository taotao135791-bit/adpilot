import Darwin
import Foundation

@main
struct AdPilotNativeHelper {
    static func main() async {
        guard let token = ProcessInfo.processInfo.environment[authenticationEnvironmentKey],
              token.utf8.count >= 32 else {
            writeStartupFailure(
                HelperFailure(
                    "CONFIGURATION_ERROR",
                    "\(authenticationEnvironmentKey) must contain at least 32 UTF-8 bytes"
                )
            )
            Foundation.exit(64)
        }
        unsetenv(authenticationEnvironmentKey)

        var lastSequence: Int64 = 0
        var framer = BoundedJSONLineFramer(maximumLineBytes: maximumRequestBytes)
        let surfaceLeaseStore = SurfaceLeaseStore()
        do {
            while let chunk = try readStdinChunk() {
                for frame in framer.append(chunk) {
                    switch frame {
                    case .line(let data):
                        await process(
                            data,
                            token: token,
                            lastSequence: &lastSequence,
                            surfaceLeaseStore: surfaceLeaseStore
                        )
                    case .oversized:
                        writeResponse(
                            failureResponse(
                                id: "",
                                sequence: 0,
                                failure: HelperFailure(
                                    "REQUEST_TOO_LARGE",
                                    "request exceeds the \(maximumRequestBytes)-byte JSONL limit"
                                )
                            )
                        )
                    case .truncated:
                        break
                    }
                }
            }
            for frame in framer.finish() {
                if frame == .truncated {
                    writeResponse(
                        failureResponse(
                            id: "",
                            sequence: 0,
                            failure: HelperFailure(
                                "TRUNCATED_REQUEST",
                                "stdin ended before the terminating JSONL newline"
                            )
                        )
                    )
                }
            }
        } catch {
            writeStartupFailure(HelperFailure("INPUT_FAILED", "could not read a framed request"))
            Foundation.exit(74)
        }
    }

    /// POSIX `read` keeps each allocation bounded and, unlike some
    /// `FileHandle.read(upToCount:)` implementations, returns as soon as pipe
    /// data is available instead of waiting to fill the requested count.
    private static func readStdinChunk() throws -> Data? {
        var bytes = [UInt8](repeating: 0, count: 8 * 1024)
        while true {
            let count = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(STDIN_FILENO, buffer.baseAddress, buffer.count)
            }
            if count > 0 {
                return Data(bytes.prefix(count))
            }
            if count == 0 {
                return nil
            }
            if errno != EINTR {
                throw HelperFailure("INPUT_FAILED", "could not read a framed request")
            }
        }
    }

    private static func process(
        _ data: Data,
        token: String,
        lastSequence: inout Int64,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async {
        do {
            let request = try RequestEnvelope.parse(data, expectedToken: token)
            guard request.sequence > lastSequence else {
                throw HelperFailure(
                    "SEQUENCE_VIOLATION",
                    "sequence must increase monotonically",
                    details: ["lastSequence": lastSequence]
                )
            }
            lastSequence = request.sequence
            try request.requireUnexpired()
            let result = try await dispatch(request, surfaceLeaseStore: surfaceLeaseStore)
            writeResponse(successResponse(for: request, result: result))
        } catch let failure as HelperFailure {
            let identity = requestIdentity(from: data)
            writeResponse(
                failureResponse(
                    id: identity.id,
                    sequence: identity.sequence,
                    failure: failure
                )
            )
        } catch {
            let identity = requestIdentity(from: data)
            writeResponse(
                failureResponse(
                    id: identity.id,
                    sequence: identity.sequence,
                    failure: HelperFailure("INTERNAL_ERROR", "the helper encountered an internal error")
                )
            )
        }
    }

    private static func dispatch(
        _ request: RequestEnvelope,
        surfaceLeaseStore: SurfaceLeaseStore
    ) async throws -> Any {
        switch request.method {
        case "hello":
            try strictKeys(request.params, allowed: [])
            return [
                "protocolVersion": protocolVersion,
                "helperVersion": helperVersion,
                "pid": ProcessInfo.processInfo.processIdentifier,
                "platform": "darwin",
                "capabilities": supportedMethods
            ]
        case "permissions.status":
            try strictKeys(request.params, allowed: [])
            return PermissionService.status()
        case "permissions.request":
            return try PermissionService.request(request.params)
        case "windows.list":
            return try WindowService.list(request.params)
        case "frontmost":
            return try WindowService.frontmost(request.params)
        case "capture":
            return try await CaptureService.capture(
                request.params,
                deadlineUnixMs: request.deadlineUnixMs,
                surfaceLeaseStore: surfaceLeaseStore
            )
        case "input.click":
            return try await InputService.click(
                request.params,
                deadlineUnixMs: request.deadlineUnixMs,
                surfaceLeaseStore: surfaceLeaseStore
            )
        case "input.type":
            return try await InputService.typeText(
                request.params,
                deadlineUnixMs: request.deadlineUnixMs,
                surfaceLeaseStore: surfaceLeaseStore
            )
        case "input.scroll":
            return try await InputService.scroll(
                request.params,
                deadlineUnixMs: request.deadlineUnixMs,
                surfaceLeaseStore: surfaceLeaseStore
            )
        default:
            throw HelperFailure(
                "METHOD_NOT_FOUND",
                "unsupported method",
                details: ["method": request.method]
            )
        }
    }

    private static func requestIdentity(from data: Data) -> (id: String, sequence: Int64) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return ("", 0)
        }
        let id = object["id"] as? String ?? ""
        return (String(id.prefix(128)), max(0, integer64(object["sequence"]) ?? 0))
    }

    private static func writeResponse(_ response: [String: Any]) {
        do {
            try FileHandle.standardOutput.write(contentsOf: serializeJSONLine(response))
        } catch {
            writeStartupFailure(HelperFailure("OUTPUT_FAILED", "could not write a response"))
            Foundation.exit(74)
        }
    }

    private static func writeStartupFailure(_ failure: HelperFailure) {
        let payload: [String: Any] = [
            "protocolVersion": protocolVersion,
            "ok": false,
            "error": [
                "code": failure.code,
                "message": failure.message,
                "retryable": failure.retryable
            ]
        ]
        guard let data = try? serializeJSONLine(payload) else {
            return
        }
        try? FileHandle.standardError.write(contentsOf: data)
    }
}
