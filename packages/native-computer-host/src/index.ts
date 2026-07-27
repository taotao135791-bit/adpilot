import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";

export const NATIVE_COMPUTER_PROTOCOL_VERSION = 2 as const;
export const NATIVE_HELPER_TOKEN_ENV = "ADPILOT_NATIVE_HELPER_TOKEN" as const;
const MUTATING_METHODS = new Set<NativeMethod>(["input.click", "input.type", "input.scroll"]);
const ALLOWED_HELPER_ENVIRONMENT_KEYS = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "__CF_USER_TEXT_ENCODING"
]);

export const NativeMethodSchema = z.enum([
  "hello",
  "permissions.status",
  "permissions.request",
  "windows.list",
  "frontmost",
  "capture",
  "input.click",
  "input.type",
  "input.scroll"
]);
export type NativeMethod = z.infer<typeof NativeMethodSchema>;

export const PermissionNameSchema = z.enum(["screenCapture", "accessibility"]);
export type PermissionName = z.infer<typeof PermissionNameSchema>;

const EmptyParamsSchema = z.object({}).strict();
const PermissionValueSchema = z.object({
  state: z.enum(["granted", "notGranted"]),
  granted: z.boolean()
}).strict().superRefine((value, context) => {
  if ((value.state === "granted") !== value.granted) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "permission state and granted disagree" });
  }
});

export const PermissionsStatusSchema = z.object({
  screenCapture: PermissionValueSchema,
  accessibility: PermissionValueSchema
}).strict();
export type PermissionsStatus = z.infer<typeof PermissionsStatusSchema>;

const PermissionSelectionSchema = z.object({
  screenCapture: z.boolean().optional(),
  accessibility: z.boolean().optional()
}).strict();

export const PermissionsRequestResultSchema = z.object({
  promptAttempted: z.object({
    screenCapture: z.boolean(),
    accessibility: z.boolean()
  }).strict(),
  grantedAfterRequest: PermissionSelectionSchema,
  status: PermissionsStatusSchema
}).strict();
export type PermissionsRequestResult = z.infer<typeof PermissionsRequestResultSchema>;

export const NativeRectangleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive()
}).strict();
export type NativeRectangle = z.infer<typeof NativeRectangleSchema>;

const CapturePixelsSchema = z.object({
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192)
}).strict();

export const NativeWindowSchema = z.object({
  windowId: z.number().int().positive(),
  ownerPid: z.number().int().positive(),
  ownerName: z.string(),
  bundleId: z.string(),
  title: z.string(),
  layer: z.number().int(),
  alpha: z.number().finite(),
  onScreen: z.boolean(),
  bounds: NativeRectangleSchema
}).strict();
export type NativeWindow = z.infer<typeof NativeWindowSchema>;

export const FrontmostResultSchema = z.object({
  ownerPid: z.number().int().positive(),
  ownerName: z.string(),
  bundleId: z.string(),
  window: NativeWindowSchema.nullable()
}).strict();
export type FrontmostResult = z.infer<typeof FrontmostResultSchema>;

export const NativeWindowSurfaceLeaseSchema = z.object({
  generation: z.string().uuid(),
  target: z.literal("window"),
  windowId: z.number().int().positive().max(4_294_967_295),
  ownerPid: z.number().int().positive().max(2_147_483_647),
  bundleId: z.string().max(1_024),
  bounds: NativeRectangleSchema,
  capturePixels: CapturePixelsSchema,
  capturedAtUnixMs: z.number().int().positive(),
  expiresAtUnixMs: z.number().int().positive()
}).strict().superRefine((value, context) => {
  if (value.expiresAtUnixMs < value.capturedAtUnixMs) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "surface lease expires before it was captured"
    });
  }
});
export type NativeWindowSurfaceLease = z.infer<typeof NativeWindowSurfaceLeaseSchema>;

const CaptureResultBaseSchema = z.object({
  format: z.literal("png"),
  base64: z.string().startsWith("iVBORw0KGgo", "capture must contain PNG base64"),
  width: z.number().int().positive().max(8_192),
  height: z.number().int().positive().max(8_192),
  capturedAt: z.string().datetime()
});
export const CaptureResultSchema = z.union([
  CaptureResultBaseSchema.extend({
    source: z.object({
      target: z.literal("window"),
      windowId: z.number().int().positive()
    }).strict(),
    surfaceLease: NativeWindowSurfaceLeaseSchema
  }).strict().superRefine((value, context) => {
    if (
      value.width !== value.surfaceLease.capturePixels.width
      || value.height !== value.surfaceLease.capturePixels.height
      || value.source.windowId !== value.surfaceLease.windowId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "window capture and surface lease metadata disagree"
      });
    }
  }),
  CaptureResultBaseSchema.extend({
    source: z.object({
      target: z.literal("screen"),
      displayId: z.number().int().nonnegative()
    }).strict(),
    surfaceLease: z.null()
  }).strict()
]);
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

export const HelloResultSchema = z.object({
  protocolVersion: z.literal(NATIVE_COMPUTER_PROTOCOL_VERSION),
  helperVersion: z.string().min(1),
  pid: z.number().int().positive(),
  platform: z.literal("darwin"),
  capabilities: z.array(NativeMethodSchema)
}).strict().superRefine((value, context) => {
  const capabilities = new Set(value.capabilities);
  const missing = NativeMethodSchema.options.filter((method) => !capabilities.has(method));
  if (missing.length > 0 || capabilities.size !== value.capabilities.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: missing.length > 0
        ? `helper is missing capabilities: ${missing.join(", ")}`
        : "helper capabilities must not contain duplicates"
    });
  }
});
export type HelloResult = z.infer<typeof HelloResultSchema>;

const PostedInputResultSchema = z.object({
  posted: z.literal(true),
  eventCount: z.number().int().positive(),
  utf8Bytes: z.number().int().nonnegative().optional()
}).strict();

export const NativeMethodSchemas = {
  hello: {
    params: EmptyParamsSchema,
    result: HelloResultSchema
  },
  "permissions.status": {
    params: EmptyParamsSchema,
    result: PermissionsStatusSchema
  },
  "permissions.request": {
    params: z.object({
      permissions: z.array(PermissionNameSchema)
        .min(1)
        .max(2)
        .refine((values) => new Set(values).size === values.length, "permissions must not contain duplicates")
        .optional()
    }).strict(),
    result: PermissionsRequestResultSchema
  },
  "windows.list": {
    params: z.object({
      includeOffscreen: z.boolean().optional(),
      owningPid: z.number().int().positive().max(2_147_483_647).optional()
    }).strict(),
    result: z.array(NativeWindowSchema)
  },
  frontmost: {
    params: EmptyParamsSchema,
    result: FrontmostResultSchema
  },
  capture: {
    params: z.discriminatedUnion("target", [
      z.object({
        target: z.literal("window"),
        windowId: z.number().int().positive().max(4_294_967_295),
        includeCursor: z.boolean().optional(),
        leaseDurationMs: z.number().int().min(1_000).max(30_000).optional()
      }).strict(),
      z.object({
        target: z.literal("screen"),
        displayId: z.number().int().nonnegative().max(4_294_967_295).optional(),
        includeCursor: z.boolean().optional()
      }).strict()
    ]),
    result: CaptureResultSchema
  },
  "input.click": {
    params: z.object({
      pixelX: z.number().finite().nonnegative(),
      pixelY: z.number().finite().nonnegative(),
      button: z.enum(["left", "right"]).optional(),
      clickCount: z.number().int().min(1).max(3).optional(),
      surfaceLease: NativeWindowSurfaceLeaseSchema
    }).strict().superRefine((value, context) => {
      if (
        value.pixelX >= value.surfaceLease.capturePixels.width
        || value.pixelY >= value.surfaceLease.capturePixels.height
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "click coordinates must be inside surfaceLease.capturePixels"
        });
      }
    }),
    result: PostedInputResultSchema
  },
  "input.type": {
    params: z.object({
      text: z.string().min(1).refine(
        (value) => Buffer.byteLength(value, "utf8") <= 16_384,
        "text must not exceed 16384 UTF-8 bytes"
      ),
      surfaceLease: NativeWindowSurfaceLeaseSchema
    }).strict(),
    result: PostedInputResultSchema
  },
  "input.scroll": {
    params: z.object({
      deltaX: z.number().int().min(-10_000).max(10_000).optional(),
      deltaY: z.number().int().min(-10_000).max(10_000).optional(),
      unit: z.enum(["pixel", "line"]).optional(),
      pixelX: z.number().finite().nonnegative(),
      pixelY: z.number().finite().nonnegative(),
      surfaceLease: NativeWindowSurfaceLeaseSchema
    }).strict().superRefine((value, context) => {
      if ((value.deltaX ?? 0) === 0 && (value.deltaY ?? 0) === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "at least one scroll delta must be non-zero"
        });
      }
      if (
        value.pixelX >= value.surfaceLease.capturePixels.width
        || value.pixelY >= value.surfaceLease.capturePixels.height
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "scroll coordinates must be inside surfaceLease.capturePixels"
        });
      }
    }),
    result: PostedInputResultSchema
  }
} as const;

type MethodSchemas = typeof NativeMethodSchemas;
export type NativeParams<M extends NativeMethod> = z.input<MethodSchemas[M]["params"]>;
export type NativeResult<M extends NativeMethod> = z.output<MethodSchemas[M]["result"]>;

export const NativeHelperErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional()
}).strict().superRefine((value, context) => {
  if (value.code === "OUTCOME_UNKNOWN" && value.retryable) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OUTCOME_UNKNOWN must never be retryable"
    });
  }
});
export type NativeHelperError = z.infer<typeof NativeHelperErrorSchema>;

export const NativeWireRequestSchema = z.object({
  protocolVersion: z.literal(NATIVE_COMPUTER_PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  deadlineUnixMs: z.number().int().positive(),
  authToken: z.string().min(32),
  method: NativeMethodSchema,
  params: z.record(z.unknown())
}).strict();

export const NativeWireResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    protocolVersion: z.literal(NATIVE_COMPUTER_PROTOCOL_VERSION),
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    ok: z.literal(true),
    result: z.unknown()
  }).strict(),
  z.object({
    protocolVersion: z.literal(NATIVE_COMPUTER_PROTOCOL_VERSION),
    id: z.string(),
    sequence: z.number().int().nonnegative(),
    ok: z.literal(false),
    error: NativeHelperErrorSchema
  }).strict()
]);
export type NativeWireResponse = z.infer<typeof NativeWireResponseSchema>;

export interface NativeHostLogger {
  debug?(event: string, fields: Readonly<Record<string, unknown>>): void;
  warn?(event: string, fields: Readonly<Record<string, unknown>>): void;
}

export interface NativeComputerHostOptions {
  executablePath: string;
  args?: readonly string[] | undefined;
  cwd?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
  defaultTimeoutMs?: number | undefined;
  startupTimeoutMs?: number | undefined;
  maxMessageBytes?: number | undefined;
  maxQueueDepth?: number | undefined;
  logger?: NativeHostLogger | undefined;
}

export interface NativeRequestOptions {
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

type PendingRequest = {
  id: string;
  sequence: number;
  method: NativeMethod;
  startedAt: number;
  deadlineUnixMs: number;
  line: string;
  written: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal | undefined;
  abortListener?: (() => void) | undefined;
};

export class NativeComputerHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NativeComputerHostError";
    this.code = code;
  }
}

export class NativeHostRemoteError extends NativeComputerHostError {
  readonly retryable: boolean;
  readonly details: unknown;
  readonly outcomeUnknown: boolean;

  constructor(error: NativeHelperError) {
    super(error.code, error.message);
    this.name = "NativeHostRemoteError";
    this.retryable = error.retryable;
    this.details = error.details;
    this.outcomeUnknown = error.code === "OUTCOME_UNKNOWN";
  }
}

export class NativeHostProtocolError extends NativeComputerHostError {
  constructor(message: string, options?: ErrorOptions) {
    super("PROTOCOL_ERROR", message, options);
    this.name = "NativeHostProtocolError";
  }
}

export class NativeHostTimeoutError extends NativeComputerHostError {
  constructor(method: NativeMethod, timeoutMs: number) {
    super("TIMEOUT", `${method} timed out after ${timeoutMs}ms`);
    this.name = "NativeHostTimeoutError";
  }
}

export class NativeHostAbortError extends NativeComputerHostError {
  constructor(method: NativeMethod, reason?: unknown) {
    super("ABORTED", `${method} was aborted`, reason instanceof Error ? { cause: reason } : undefined);
    this.name = "NativeHostAbortError";
  }
}

export class NativeHostClosedError extends NativeComputerHostError {
  constructor(message = "native computer host is closed", options?: ErrorOptions) {
    super("HOST_CLOSED", message, options);
    this.name = "NativeHostClosedError";
  }
}

export class NativeHostOutcomeUnknownError extends NativeComputerHostError {
  readonly retryable = false;
  readonly outcomeUnknown = true;
  readonly method: NativeMethod;

  constructor(method: NativeMethod, reason: "timeout" | "abort" | "disconnect") {
    super(
      "OUTCOME_UNKNOWN",
      `${method} may have posted native input before the helper ${reason}; never retry automatically`
    );
    this.name = "NativeHostOutcomeUnknownError";
    this.method = method;
  }
}

export class NativeHostQueueFullError extends NativeComputerHostError {
  constructor(maxQueueDepth: number) {
    super("QUEUE_FULL", `native helper queue is limited to ${maxQueueDepth} requests`);
    this.name = "NativeHostQueueFullError";
  }
}

export class NativeComputerHost {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #authToken: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxQueueDepth: number;
  readonly #logger: NativeHostLogger;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #queue: string[] = [];
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #sequence = 0;
  #activeId: string | undefined;
  #stdoutBuffer = Buffer.alloc(0);
  #closed = false;
  #stderrBytes = 0;

  private constructor(
    options: NativeComputerHostOptions,
    executablePath: string,
    authToken: string
  ) {
    this.#authToken = authToken;
    this.#defaultTimeoutMs = boundedOption(options.defaultTimeoutMs ?? 10_000, "defaultTimeoutMs", 1, 300_000);
    this.#maxMessageBytes = boundedOption(options.maxMessageBytes ?? 96 * 1024 * 1024, "maxMessageBytes", 1_024, 256 * 1024 * 1024);
    this.#maxQueueDepth = boundedOption(options.maxQueueDepth ?? 32, "maxQueueDepth", 1, 1_024);
    this.#logger = options.logger ?? {};
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    const environment = minimalEnvironment(options.env);
    environment[NATIVE_HELPER_TOKEN_ENV] = authToken;
    this.#child = spawn(executablePath, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#attachProcessHandlers();
  }

  static async launch(options: NativeComputerHostOptions): Promise<NativeComputerHost> {
    const executablePath = await validateExecutablePath(options.executablePath);
    const authToken = randomBytes(32).toString("base64url");
    const host = new NativeComputerHost(options, executablePath, authToken);
    try {
      await host.request("hello", {}, { timeoutMs: options.startupTimeoutMs ?? 5_000 });
      return host;
    } catch (error) {
      await host.close().catch(() => undefined);
      throw error;
    }
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get closed(): boolean {
    return this.#closed;
  }

  request<M extends NativeMethod>(
    method: M,
    params: NativeParams<M>,
    options: NativeRequestOptions = {}
  ): Promise<NativeResult<M>> {
    if (this.#closed) {
      return Promise.reject(new NativeHostClosedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(new NativeHostAbortError(method, options.signal.reason));
    }

    const schemas = NativeMethodSchemas[method];
    if (!schemas) {
      return Promise.reject(new NativeHostProtocolError(`unsupported native method: ${String(method)}`));
    }
    let parsedParams: unknown;
    try {
      parsedParams = schemas.params.parse(params);
    } catch (error) {
      return Promise.reject(error);
    }

    const timeoutMs = boundedOption(options.timeoutMs ?? this.#defaultTimeoutMs, "timeoutMs", 1, 300_000);
    if (this.#pending.size >= this.#maxQueueDepth) {
      return Promise.reject(new NativeHostQueueFullError(this.#maxQueueDepth));
    }
    if (this.#sequence >= Number.MAX_SAFE_INTEGER) {
      const error = new NativeHostProtocolError("request sequence exhausted");
      this.#terminate(error);
      return Promise.reject(error);
    }

    const sequence = ++this.#sequence;
    const id = randomUUID();
    const startedAt = Date.now();
    const deadlineUnixMs = startedAt + timeoutMs;
    const wireRequest = NativeWireRequestSchema.parse({
      protocolVersion: NATIVE_COMPUTER_PROTOCOL_VERSION,
      id,
      sequence,
      deadlineUnixMs,
      authToken: this.#authToken,
      method,
      params: parsedParams
    });
    const line = `${JSON.stringify(wireRequest)}\n`;
    if (Buffer.byteLength(line, "utf8") > 64 * 1024 + 1) {
      return Promise.reject(new NativeHostProtocolError("native helper request exceeds the framing limit"));
    }

    return new Promise<NativeResult<M>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#expire(id, new NativeHostTimeoutError(method, timeoutMs), "timeout");
      }, timeoutMs);
      timeout.unref();

      const pending: PendingRequest = {
        id,
        sequence,
        method,
        startedAt,
        deadlineUnixMs,
        line,
        written: false,
        resolve: (value) => resolve(value as NativeResult<M>),
        reject,
        timeout,
        signal: options.signal
      };
      if (options.signal) {
        pending.abortListener = () => {
          this.#expire(
            id,
            new NativeHostAbortError(method, options.signal?.reason),
            "abort"
          );
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.#pending.set(id, pending);
      this.#queue.push(id);
      this.#pump();
    });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      const error = new NativeHostClosedError();
      this.#rejectForDisconnect(error);
      this.#child.stdin.end();
      this.#child.kill("SIGTERM");
    }

    const forceKill = setTimeout(() => {
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
        this.#child.kill("SIGKILL");
      }
    }, 1_000);
    forceKill.unref();
    await this.#exitPromise;
    clearTimeout(forceKill);
  }

  #attachProcessHandlers(): void {
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#consumeStdout(chunk);
    });
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
    });
    this.#child.on("error", (error) => {
      this.#terminate(new NativeHostClosedError("native helper process failed", { cause: error }));
    });
    this.#child.on("close", (code, signal) => {
      if (!this.#closed) {
        this.#closed = true;
        this.#rejectForDisconnect(
          new NativeHostClosedError(
            `native helper exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`
          )
        );
      }
      this.#log("debug", "native-helper.exit", {
        code,
        signal,
        stderrBytes: this.#stderrBytes
      });
      this.#resolveExit();
    });
    this.#child.stdin.on("error", (error) => {
      if (!this.#closed) {
        this.#terminate(new NativeHostClosedError("native helper stdin failed", { cause: error }));
      }
    });
    this.#child.stdout.on("error", (error) => {
      if (!this.#closed) {
        this.#terminate(new NativeHostClosedError("native helper stdout failed", { cause: error }));
      }
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.byteLength > this.#maxMessageBytes && !this.#stdoutBuffer.includes(0x0a)) {
      this.#terminate(new NativeHostProtocolError("native helper response exceeds maxMessageBytes"));
      return;
    }

    while (!this.#closed) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.byteLength > this.#maxMessageBytes) {
          this.#terminate(new NativeHostProtocolError("native helper response exceeds maxMessageBytes"));
        }
        break;
      }
      if (newline > this.#maxMessageBytes) {
        this.#terminate(new NativeHostProtocolError("native helper response exceeds maxMessageBytes"));
        return;
      }
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(
          this.#stdoutBuffer.subarray(0, newline)
        );
      } catch (error) {
        this.#terminate(
          new NativeHostProtocolError("native helper emitted invalid UTF-8", { cause: error })
        );
        return;
      }
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.length === 0) {
        this.#terminate(new NativeHostProtocolError("native helper emitted an empty response"));
        return;
      }
      this.#handleResponseLine(line);
    }
  }

  #handleResponseLine(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      this.#terminate(new NativeHostProtocolError("native helper emitted invalid JSON", { cause: error }));
      return;
    }
    const parsed = NativeWireResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.#terminate(new NativeHostProtocolError("native helper emitted an invalid response envelope"));
      return;
    }

    const response = parsed.data;
    const pending = this.#pending.get(response.id);
    if (
      !pending
      || !pending.written
      || this.#activeId !== pending.id
      || pending.sequence !== response.sequence
    ) {
      this.#terminate(new NativeHostProtocolError("native helper response does not match a pending request"));
      return;
    }
    const durationMs = Date.now() - pending.startedAt;

    if (!response.ok) {
      this.#removePending(pending);
      const remote = new NativeHostRemoteError({
        ...response.error,
        message: this.#redactText(response.error.message),
        details: this.#redactValue(response.error.details)
      });
      this.#log("warn", "native-helper.remote-error", {
        id: pending.id,
        sequence: pending.sequence,
        method: pending.method,
        durationMs,
        code: remote.code,
        retryable: remote.retryable
      });
      pending.reject(remote);
      this.#pump();
      return;
    }

    const resultSchema = NativeMethodSchemas[pending.method].result;
    const result = resultSchema.safeParse(response.result);
    if (!result.success) {
      const error = new NativeHostProtocolError(
        `native helper returned an invalid ${pending.method} result`
      );
      // A malformed success envelope cannot prove whether native input was
      // posted. Keep the request pending so #terminate can conservatively
      // upgrade every written mutation to OUTCOME_UNKNOWN.
      this.#terminate(error, pending.id);
      return;
    }
    this.#removePending(pending);
    this.#log("debug", "native-helper.response", {
      id: pending.id,
      sequence: pending.sequence,
      method: pending.method,
      durationMs
    });
    pending.resolve(result.data);
    this.#pump();
  }

  #removePending(pending: PendingRequest): void {
    this.#pending.delete(pending.id);
    const queueIndex = this.#queue.indexOf(pending.id);
    if (queueIndex >= 0) {
      this.#queue.splice(queueIndex, 1);
    }
    if (this.#activeId === pending.id) {
      this.#activeId = undefined;
    }
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
  }

  #pump(): void {
    if (this.#closed || this.#activeId !== undefined) {
      return;
    }
    while (!this.#closed && this.#activeId === undefined) {
      const id = this.#queue.shift();
      if (!id) {
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        continue;
      }
      if (Date.now() > pending.deadlineUnixMs) {
        this.#removePending(pending);
        pending.reject(
          new NativeHostTimeoutError(
            pending.method,
            Math.max(1, pending.deadlineUnixMs - pending.startedAt)
          )
        );
        continue;
      }

      this.#activeId = id;
      pending.written = true;
      this.#log("debug", "native-helper.request", {
        id,
        sequence: pending.sequence,
        method: pending.method,
        deadlineUnixMs: pending.deadlineUnixMs
      });
      this.#child.stdin.write(pending.line, "utf8", (error) => {
        if (error && this.#pending.has(id)) {
          this.#terminate(
            new NativeHostClosedError("could not write to native helper", { cause: error }),
            id
          );
        }
      });
    }
  }

  #expire(
    id: string,
    definiteError: NativeHostTimeoutError | NativeHostAbortError,
    reason: "timeout" | "abort"
  ): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    if (!pending.written) {
      this.#removePending(pending);
      pending.reject(definiteError);
      this.#pump();
      return;
    }
    const error = MUTATING_METHODS.has(pending.method)
      ? new NativeHostOutcomeUnknownError(pending.method, reason)
      : definiteError;
    this.#terminate(error, id);
  }

  #rejectForDisconnect(error: Error, primaryId?: string): void {
    for (const pending of [...this.#pending.values()]) {
      this.#removePending(pending);
      if (pending.written && MUTATING_METHODS.has(pending.method)) {
        pending.reject(
          error instanceof NativeHostOutcomeUnknownError
            ? error
            : new NativeHostOutcomeUnknownError(pending.method, "disconnect")
        );
      } else if (pending.id === primaryId) {
        pending.reject(error);
      } else {
        pending.reject(
          primaryId === undefined
            ? error
            : new NativeHostClosedError("native helper stopped while another command was cancelled")
        );
      }
    }
  }

  #terminate(error: Error, primaryId?: string): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectForDisconnect(error, primaryId);
    this.#child.stdin.destroy();
    this.#child.kill("SIGKILL");
    this.#log("warn", "native-helper.terminated", {
      code: error instanceof NativeComputerHostError ? error.code : "UNKNOWN"
    });
  }

  #redactText(value: string): string {
    return value
      .split(this.#authToken).join("[REDACTED]")
      .replace(
        /((?:auth(?:entication)?[_-]?token|token|secret|password)\s*[:=]\s*)[^\s,;]+/giu,
        "$1[REDACTED]"
      );
  }

  #redactValue(value: unknown, depth = 0): unknown {
    if (depth > 6) {
      return "[OMITTED]";
    }
    if (typeof value === "string") {
      return this.#redactText(value);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((item) => this.#redactValue(item, depth + 1));
    }
    if (value && typeof value === "object") {
      const redacted: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        redacted[key] = /auth|token|secret|password/iu.test(key)
          ? "[REDACTED]"
          : this.#redactValue(item, depth + 1);
      }
      return redacted;
    }
    return value;
  }

  #log(
    level: "debug" | "warn",
    event: string,
    fields: Readonly<Record<string, unknown>>
  ): void {
    try {
      this.#logger[level]?.(event, fields);
    } catch {
      // Logging is observational and must never affect the helper actor.
    }
  }
}

function minimalEnvironment(additional?: Readonly<Record<string, string>>): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: "/usr/bin:/bin"
  };
  for (const key of ALLOWED_HELPER_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value) {
      environment[key] = value;
    }
  }
  for (const [key, value] of Object.entries(additional ?? {})) {
    if (!ALLOWED_HELPER_ENVIRONMENT_KEYS.has(key)) {
      throw new NativeComputerHostError(
        "INVALID_CONFIGURATION",
        `helper environment key is not allowlisted: ${key}`
      );
    }
    environment[key] = value;
  }
  return environment;
}

async function validateExecutablePath(executablePath: string): Promise<string> {
  if (!isAbsolute(executablePath)) {
    throw new NativeComputerHostError(
      "INVALID_CONFIGURATION",
      "executablePath must be absolute"
    );
  }

  let linkMetadata;
  let resolvedPath: string;
  let metadata;
  try {
    [linkMetadata, resolvedPath] = await Promise.all([
      lstat(executablePath),
      realpath(executablePath)
    ]);
    metadata = await stat(resolvedPath);
    await access(resolvedPath, fsConstants.X_OK);
  } catch (error) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper path is unavailable or not executable",
      { cause: error }
    );
  }

  if (linkMetadata.isSymbolicLink() || resolvedPath !== executablePath) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper path must be canonical and must not contain symlink indirection"
    );
  }
  if (
    !linkMetadata.isFile()
    || !metadata.isFile()
    || linkMetadata.dev !== metadata.dev
    || linkMetadata.ino !== metadata.ino
  ) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper must resolve to the same regular file inspected with lstat"
    );
  }

  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (metadata.uid !== 0 && (currentUid === undefined || metadata.uid !== currentUid)) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper must be owned by root or the current user"
    );
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper must not be writable by group or other users"
    );
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new NativeComputerHostError(
      "INVALID_HELPER_EXECUTABLE",
      "native helper has no executable mode bit"
    );
  }

  return resolvedPath;
}

function boundedOption(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new NativeComputerHostError(
      "INVALID_CONFIGURATION",
      `${name} must be an integer between ${minimum} and ${maximum}`
    );
  }
  return value;
}
