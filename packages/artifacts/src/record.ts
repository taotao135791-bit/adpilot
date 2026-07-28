import { z } from "zod";

/**
 * Artifact domain model for the unified artifact store.
 *
 * Mirrors the shape planned for `packages/kernel` (see
 * docs/universal-workspace/PLAN.md) but is intentionally re-declared here so
 * this package never imports the kernel and the dependency graph stays acyclic.
 */
export const ArtifactType = z.enum([
  "code",
  "document",
  "slides",
  "spreadsheet",
  "pdf",
  "website",
  "image",
  "video",
  "interactive",
  "report"
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

export const ArtifactStatus = z.enum(["rendering", "ready", "failed"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatus>;

export const ArtifactRecord = z.object({
  id: z.string().uuid(),
  projectId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  type: ArtifactType,
  title: z.string().min(1),
  /** Renderer source files stored next to the record (e.g. `spec.json`). */
  sourceFiles: z.array(z.string()),
  /** Store-relative path of the primary preview file, when one exists. */
  previewUrl: z.string().optional(),
  exportFormats: z.array(z.string()),
  /** Bumped on every re-render of the same projectId+title; old version files are kept. */
  version: z.number().int().positive(),
  status: ArtifactStatus,
  /** Populated when status is "failed". */
  error: z.string().optional(),
  /** ISO-8601 timestamps. */
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  /** Bumped on every record mutation (status transitions included). */
  revision: z.number().int().nonnegative()
});
export type ArtifactRecord = z.infer<typeof ArtifactRecord>;

/** A renderer turns a validated spec into real files inside `outputDir`. */
export interface RenderedOutput {
  /** File names relative to `outputDir`. */
  files: string[];
}

export interface ArtifactRenderer<S> {
  /** Export formats produced by `render` (e.g. ["pptx", "svg"]). */
  readonly exportFormats: string[];
  render(spec: S, outputDir: string): Promise<RenderedOutput>;
  /** Pick the store-relative preview file from `files`, if any. */
  previewFile?(files: string[]): string | undefined;
}
