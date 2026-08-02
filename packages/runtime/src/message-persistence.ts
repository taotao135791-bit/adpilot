import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

const PERSISTED_IMAGE_PLACEHOLDER = "[captured image omitted from persisted session; capture a fresh observation before acting]";
const MAX_SANITIZE_DEPTH = 64;

type SanitizedValue = {
  value: unknown;
  omittedImages: number;
};

/**
 * Keep tool-provided pixels in the live agent state for the current model
 * turn, but remove them from every durable or extension-facing projection.
 * Text metadata (window identity, bounds, URL, evidence ids) remains useful;
 * only encoded image bytes are discarded.
 */
export function sanitizeMessageForPersistence(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  const sanitizedDetails = sanitizeImagePayloads(message.details);
  const imageBlockCount = message.content.filter((item) => item.type === "image").length;
  const content = message.content.flatMap((item) => {
    if (item.type === "image") return [];
    return [{ ...item, text: sanitizeToolText(item.text, imageBlockCount > 0 || sanitizedDetails.omittedImages > 0) }];
  });
  const omittedImages = imageBlockCount + sanitizedDetails.omittedImages;
  if (omittedImages > 0) content.push({ type: "text", text: PERSISTED_IMAGE_PLACEHOLDER });

  if (omittedImages === 0) return message;
  return {
    ...message,
    content,
    details: sanitizedDetails.value
  };
}

/** A pixel-free copy suitable for traces, extensions, and RuntimeResult. */
export function sanitizeEventForPersistence(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "agent_end":
      return { ...event, messages: event.messages.map(sanitizeMessageForPersistence) };
    case "turn_end":
      return {
        ...event,
        message: sanitizeMessageForPersistence(event.message),
        toolResults: event.toolResults.map((message) => sanitizeMessageForPersistence(message) as typeof message)
      };
    case "message_start":
    case "message_update":
    case "message_end":
      return { ...event, message: sanitizeMessageForPersistence(event.message) };
    case "tool_execution_update":
      return { ...event, partialResult: sanitizeToolExecutionResult(event.partialResult) };
    case "tool_execution_end":
      return { ...event, result: sanitizeToolExecutionResult(event.result) };
    default:
      return event;
  }
}

function sanitizeToolExecutionResult(result: unknown): unknown {
  const sanitized = sanitizeImagePayloads(result);
  if (sanitized.omittedImages === 0 || !sanitized.value || typeof sanitized.value !== "object") {
    return sanitized.value;
  }
  const record = sanitized.value as Record<string, unknown>;
  if (!Array.isArray(record.content)) return record;
  return {
    ...record,
    content: record.content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const block = item as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string"
        ? { ...block, text: sanitizeToolText(block.text, true) }
        : block;
    })
  };
}

function sanitizeToolText(text: string, inspect: boolean): string {
  const mayContainImage = inspect
    || text.startsWith("data:image/")
    || (text.includes("\"image\"") && (text.includes("\"data\"") || text.includes("\"base64\"")));
  if (!mayContainImage) return text;
  if (text.startsWith("data:image/")) return PERSISTED_IMAGE_PLACEHOLDER;
  try {
    const parsed = JSON.parse(text) as unknown;
    const sanitized = sanitizeImagePayloads(parsed);
    return sanitized.omittedImages > 0 ? JSON.stringify(sanitized.value) : text;
  } catch {
    // A non-JSON block accompanying an image may still be a naked base64
    // payload. Preserve short human-readable captions, not opaque blobs.
    return text.length > 4_096 ? PERSISTED_IMAGE_PLACEHOLDER : text;
  }
}

function sanitizeImagePayloads(value: unknown, depth = 0): SanitizedValue {
  if (depth >= MAX_SANITIZE_DEPTH) return { value: "[omitted: depth limit]", omittedImages: 0 };
  if (typeof value === "string" && value.startsWith("data:image/")) {
    return {
      value: { omitted: true, mediaType: value.slice(5, value.indexOf(";", 5) > 0 ? value.indexOf(";", 5) : undefined) },
      omittedImages: 1
    };
  }
  if (Array.isArray(value)) {
    let omittedImages = 0;
    const copy = value.map((item) => {
      const sanitized = sanitizeImagePayloads(item, depth + 1);
      omittedImages += sanitized.omittedImages;
      return sanitized.value;
    });
    return { value: copy, omittedImages };
  }
  if (!value || typeof value !== "object") return { value, omittedImages: 0 };

  const record = value as Record<string, unknown>;
  const mimeType = typeof record.mimeType === "string"
    ? record.mimeType
    : typeof record.mediaType === "string" ? record.mediaType : undefined;
  const format = typeof record.format === "string" ? record.format.toLowerCase() : undefined;
  const encoded = typeof record.data === "string"
    ? { key: "data", value: record.data }
    : typeof record.base64 === "string" ? { key: "base64", value: record.base64 } : undefined;
  const isImagePayload = Boolean(encoded)
    && (mimeType?.startsWith("image/") === true || format === "png" || format === "jpeg" || format === "jpg" || record.type === "image");

  let omittedImages = isImagePayload ? 1 : 0;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (isImagePayload && key === encoded!.key) continue;
    const sanitized = sanitizeImagePayloads(item, depth + 1);
    copy[key] = sanitized.value;
    omittedImages += sanitized.omittedImages;
  }
  if (isImagePayload) {
    copy.omitted = true;
    copy.encodedLength = encoded!.value.length;
  }
  return { value: copy, omittedImages };
}
