import { randomUUID } from "node:crypto";
import {
  type ArtifactRecord,
  type ArtifactRenderer,
  type ArtifactStatus,
  type ArtifactType
} from "./record.js";
import { applySlidePatch, SlidesRenderer, SlidesSpec, type SlidePatch } from "./slides.js";
import { FileArtifactStore, type ArtifactVersionFiles } from "./store.js";

const SPEC_FILE = "spec.json";

/**
 * Facade over the artifact store and the renderers: creates records, runs
 * renderers into versioned output directories, keeps old versions, and tracks
 * the rendering → ready/failed lifecycle on the record.
 */
export class ArtifactService {
  constructor(private readonly store: FileArtifactStore) {}

  /**
   * Render `spec` with `renderer` and store the result as an artifact.
   * Re-rendering the same projectId+title reuses the artifact, bumps
   * `version`, and keeps the previous version's files on disk.
   */
  async createFromRenderer<S>(
    projectId: string,
    type: ArtifactType,
    title: string,
    spec: S,
    renderer: ArtifactRenderer<S>,
    options: { sessionId?: string } = {}
  ): Promise<ArtifactRecord> {
    const existing = (await this.store.list(projectId)).find(
      (record) => record.title === title
    );
    const now = new Date().toISOString();
    const base: ArtifactRecord = existing
      ? {
          ...existing,
          status: "rendering",
          version: existing.version + 1,
          updatedAt: now,
          revision: existing.revision + 1
        }
      : {
          id: randomUUID(),
          projectId,
          type,
          title,
          sourceFiles: [SPEC_FILE],
          exportFormats: renderer.exportFormats,
          version: 1,
          status: "rendering",
          createdAt: now,
          updatedAt: now,
          revision: 0,
          ...(options.sessionId ? { sessionId: options.sessionId } : {})
        };
    delete base.error;
    delete base.previewUrl;
    await this.store.save(base);

    try {
      await this.store.writeOutput(
        base.id,
        SPEC_FILE,
        Buffer.from(`${JSON.stringify(spec, null, 2)}\n`, "utf8")
      );
      const outputDirectory = await this.store.outputDirFor(base.id, base.version);
      const { files } = await renderer.render(spec, outputDirectory);
      const previewFile = renderer.previewFile?.(files);
      const ready: ArtifactRecord = {
        ...base,
        status: "ready",
        exportFormats: renderer.exportFormats,
        sourceFiles: [SPEC_FILE],
        ...(previewFile ? { previewUrl: `v${base.version}/${previewFile}` } : {}),
        updatedAt: new Date().toISOString(),
        revision: base.revision + 1
      };
      await this.store.save(ready);
      return ready;
    } catch (error) {
      const failed: ArtifactRecord = {
        ...base,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
        revision: base.revision + 1
      };
      await this.store.save(failed);
      throw error;
    }
  }

  /**
   * Spec-level slide update: loads the stored spec, applies the patch to one
   * slide, and re-renders the whole deck as a new version (pptxgenjs cannot
   * patch an existing .pptx in place).
   */
  async updateSlide(id: string, slideIndex: number, patch: SlidePatch): Promise<ArtifactRecord> {
    const record = await this.store.get(id);
    if (!record) throw new Error(`artifact ${id} not found`);
    if (record.type !== "slides") {
      throw new Error(`artifact ${id} is a ${record.type}, not slides`);
    }
    const specBuffer = await this.store.readOutput(id, SPEC_FILE);
    if (!specBuffer) throw new Error(`artifact ${id} has no stored spec`);
    const spec = SlidesSpec.parse(JSON.parse(specBuffer.toString("utf8")));
    const next = applySlidePatch(spec, slideIndex, patch);
    return this.createFromRenderer(
      record.projectId,
      "slides",
      record.title,
      next,
      new SlidesRenderer(),
      record.sessionId ? { sessionId: record.sessionId } : {}
    );
  }

  /** Explicit lifecycle marker for renderers that run outside createFromRenderer. */
  async markStatus(id: string, status: ArtifactStatus, error?: string): Promise<ArtifactRecord> {
    const record = await this.store.get(id);
    if (!record) throw new Error(`artifact ${id} not found`);
    const next: ArtifactRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
      revision: record.revision + 1
    };
    delete next.error;
    if (status === "failed" && error) next.error = error;
    await this.store.save(next);
    return next;
  }

  async listVersions(id: string): Promise<ArtifactVersionFiles[]> {
    return this.store.listVersions(id);
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    return this.store.get(id);
  }

  /** Read one rendered output file; undefined when it does not exist. */
  async readOutput(id: string, filename: string): Promise<Buffer | undefined> {
    return this.store.readOutput(id, filename);
  }

  async list(projectId?: string): Promise<ArtifactRecord[]> {
    return this.store.list(projectId);
  }

  async delete(id: string): Promise<void> {
    return this.store.delete(id);
  }
}
