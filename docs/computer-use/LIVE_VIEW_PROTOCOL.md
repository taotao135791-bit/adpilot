# Computer Live View protocol

Live View is a local UI channel, not a model channel and not an audit-retention
default.

## Frame envelope

Each published frame is bound to:

```ts
interface LiveFrameEnvelope {
  protocolVersion: 1;
  computerSessionId: string;
  generation: number;
  frameId: string;
  role: "preview" | "grounding" | "before-action" | "after-action" | "audit";
  capturedAt: string;
  mimeType: "image/jpeg" | "image/webp" | "image/png";
  width: number;
  height: number;
  scaleFactor: number;
  byteLength: number;
  surfaceFingerprint: string;
  app: { pid: number; bundleId: string; name: string };
  window: { id: string; bounds: { x: number; y: number; width: number; height: number } };
}
```

Preview bytes are served only from the loopback desktop origin, are bounded in size,
carry `no-store`, and are rejected when the requested session/generation is stale.
The ordinary product event stream continues to omit screenshot bytes.

## Overlay coordinates

Overlays use source-frame pixels. The renderer fits the frame with a single uniform
scale and offset:

```text
viewX = offsetX + frameX * renderedWidth / frameWidth
viewY = offsetY + frameY * renderedHeight / frameHeight
```

The runtime converts source-frame pixels to native window points only after validating
the same surface lease. Retina, negative display origins and multi-display bounds are
tested at the conversion boundary. A resized renderer image never becomes the native
coordinate source.

## Control events

`Pause`, `Resume`, `Take Over`, `Return Control`, `Step` and `Stop` include the
Computer Session identifier and expected generation. Stale controls fail closed.

Returning control:

1. clears old proposals and coordinate leases;
2. captures a new frame;
3. revalidates app/window/browser/account/page identity;
4. increments the generation;
5. permits planning only from that new observation.

## Retention

- Preview frames are memory-bounded and replaced.
- Evidence frames use the private artifact store and retention policy.
- Password, OTP and declared sensitive regions are not retained.
- Users may disable cloud visual providers; local preview still works.
- Audit export is explicit and deletable.

