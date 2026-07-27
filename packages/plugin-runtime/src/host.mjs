import { randomUUID } from "node:crypto";
import path from "node:path";
import vm from "node:vm";

const pendingCapabilities = new Map();
let activeInvocation;
const capabilityApi = Object.freeze({ call: capabilityCall });

function send(message) {
  if (process.connected) process.send(message);
}

function capabilityCall(capability, args) {
  if (!activeInvocation) {
    throw new Error("Capability calls are allowed only during an active invocation");
  }
  const requestId = randomUUID();
  const promise = new Promise((resolve, reject) => {
    pendingCapabilities.set(requestId, { resolve, reject });
    send({ type: "capability", requestId, capability, args });
  });
  const tracked = promise
    .then(
      () => undefined,
      (error) => {
        activeInvocation?.failures.push(error);
      }
    )
    .finally(() => {
      activeInvocation?.pending.delete(requestId);
    });
  activeInvocation.pending.set(requestId, tracked);
  return promise;
}

function serialize(value) {
  if (value instanceof Error) {
    return {
      message: value.message,
      stack: value.stack,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
      ...(typeof value.reconciliationRequired === "boolean"
        ? { reconciliationRequired: value.reconciliationRequired }
        : {})
    };
  }
  return { message: String(value) };
}

async function drainCapabilities(invocation) {
  while (invocation.pending.size > 0) {
    await Promise.all([...invocation.pending.values()]);
  }
  if (invocation.failures.length > 0) throw invocation.failures[0];
}

function safeRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 240 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value)
  ) {
    return false;
  }
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

async function loadPluginModule(rawFiles, entry) {
  if (!Array.isArray(rawFiles) || rawFiles.length > 256) {
    throw new Error("Invalid invocation bundle payload");
  }
  const sources = new Map();
  let totalBytes = 0;
  for (const file of rawFiles) {
    if (
      !file ||
      !safeRelativePath(file.path) ||
      typeof file.contentBase64 !== "string" ||
      sources.has(file.path)
    ) {
      throw new Error("Invalid invocation bundle file");
    }
    const bytes = Buffer.from(file.contentBase64, "base64");
    totalBytes += bytes.byteLength;
    if (totalBytes > 8 * 1024 * 1024) {
      throw new Error("Invocation bundle exceeds the safety limit");
    }
    sources.set(file.path, bytes.toString("utf8"));
  }
  if (!safeRelativePath(entry) || !sources.has(entry)) {
    throw new Error("Plugin entry is absent from the invocation snapshot");
  }
  const context = vm.createContext(
    {
      console: Object.freeze({
        debug: (...data) => send({ type: "log", level: "debug", event: "console", data }),
        info: (...data) => send({ type: "log", level: "info", event: "console", data }),
        log: (...data) => send({ type: "log", level: "info", event: "console", data }),
        warn: (...data) => send({ type: "log", level: "warn", event: "console", data }),
        error: (...data) => send({ type: "log", level: "error", event: "console", data })
      }),
      setTimeout,
      clearTimeout,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      structuredClone,
      capabilities: capabilityApi
    },
    {
      name: "adpilot-plugin-isolate",
      codeGeneration: { strings: false, wasm: false }
    }
  );
  const cache = new Map();

  async function resolveModule(specifier, referencingIdentifier) {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      throw new Error(`Plugin imports are denied: ${specifier}`);
    }
    const prefix = "adpilot-plugin:/";
    if (!referencingIdentifier.startsWith(prefix)) {
      throw new Error("Invalid referencing module identifier");
    }
    const referencingPath = referencingIdentifier.slice(prefix.length);
    const candidate = path.posix.normalize(
      path.posix.join(path.posix.dirname(referencingPath), specifier)
    );
    if (!safeRelativePath(candidate) || !sources.has(candidate)) {
      throw new Error("Plugin import escaped or is absent from its verified snapshot");
    }
    return load(candidate);
  }

  async function load(relativePath) {
    if (!safeRelativePath(relativePath)) throw new Error("Plugin module escaped its bundle");
    const cached = cache.get(relativePath);
    if (cached) return cached;
    const source = sources.get(relativePath);
    if (source === undefined) throw new Error(`Plugin module is absent: ${relativePath}`);
    const identifier = `adpilot-plugin:/${relativePath}`;
    const module = new vm.SourceTextModule(source, {
      context,
      identifier,
      initializeImportMeta(meta) {
        meta.url = identifier;
      },
      importModuleDynamically: async (specifier, referencingModule) => {
        const imported = await resolveModule(specifier, referencingModule.identifier);
        if (imported.status === "unlinked") await imported.link(resolveModule);
        if (imported.status === "linked") await imported.evaluate();
        return imported;
      }
    });
    cache.set(relativePath, module);
    await module.link(resolveModule);
    return module;
  }

  const module = await load(entry);
  await module.evaluate();
  return module.namespace;
}

process.on("message", async (message) => {
  if (message?.type === "capability_result" || message?.type === "capability_error") {
    const pending = pendingCapabilities.get(message.requestId);
    if (!pending) return;
    pendingCapabilities.delete(message.requestId);
    if (message.type === "capability_result") {
      pending.resolve(message.result);
    } else {
      const error = new Error(message.error?.message ?? "Capability failed");
      if (typeof message.error?.code === "string") error.code = message.error.code;
      if (typeof message.error?.retryable === "boolean") {
        error.retryable = message.error.retryable;
      }
      if (typeof message.error?.reconciliationRequired === "boolean") {
        error.reconciliationRequired = message.error.reconciliationRequired;
      }
      pending.reject(error);
    }
    return;
  }
  if (message?.type !== "execute") return;
  if (activeInvocation) {
    send({
      type: "error",
      requestId: message.requestId,
      error: { message: "Host accepts only one invocation at a time", code: "HOST_BUSY" }
    });
    return;
  }
  const invocation = {
    invocationId: message.invocationId,
    pending: new Map(),
    failures: []
  };
  activeInvocation = invocation;
  let result;
  let operationError;
  try {
    const operation = message.operation;
    const namespace = await loadPluginModule(message.bundleFiles, operation.module);
    if (operation.mode === "tool") {
      const tools = namespace.tools;
      if (!tools || typeof tools !== "object" || typeof tools[operation.name] !== "function") {
        throw new Error(`Tool is not exported: ${operation.name}`);
      }
      result = await tools[operation.name](
        operation.input,
        Object.freeze({ capabilities: capabilityApi })
      );
    } else if (operation.mode === "migration") {
      const migrate = namespace.migrate ?? namespace.default;
      if (typeof migrate !== "function") throw new Error("Migration module must export migrate");
      result = await migrate(
        operation.input,
        Object.freeze({ capabilities: capabilityApi })
      );
    } else {
      throw new Error(`Unknown operation mode: ${operation.mode}`);
    }
  } catch (error) {
    operationError = error;
  }
  try {
    await drainCapabilities(invocation);
  } catch (error) {
    operationError ??= error;
  }
  activeInvocation = undefined;
  if (operationError) {
    send({ type: "error", requestId: message.requestId, error: serialize(operationError) });
  } else {
    send({ type: "result", requestId: message.requestId, result });
  }
});

send({ type: "ready" });
