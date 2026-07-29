import { join } from "node:path";
import { z } from "zod";
import {
  DocumentRenderer,
  DocumentSpec,
  SlidesRenderer,
  SlidesSpec,
  SpreadsheetRenderer,
  WorkbookSpec,
  type ArtifactRenderer,
  type ArtifactService,
  type ArtifactType
} from "@adpilot/artifacts";
import type { AgentToolDefinition } from "../registry.js";
import { kernelStores, updateKernelTask } from "../kernel-internal.js";
import { succeed } from "../result.js";
import { toolError } from "../errors.js";

const IdParams = z.object({ id: z.string().min(1) });

type RenderableType = "slides" | "document" | "spreadsheet";

const RENDERABLE: Record<RenderableType, { parse(spec: unknown): unknown; renderer(): ArtifactRenderer<never> }> = {
  slides: {
    parse: (spec) => SlidesSpec.parse(spec),
    renderer: () => new SlidesRenderer() as ArtifactRenderer<never>
  },
  document: {
    parse: (spec) => DocumentSpec.parse(spec),
    renderer: () => new DocumentRenderer() as ArtifactRenderer<never>
  },
  spreadsheet: {
    parse: (spec) => WorkbookSpec.parse(spec),
    renderer: () => new SpreadsheetRenderer() as ArtifactRenderer<never>
  }
};

function renderableType(value: string): RenderableType {
  if (value === "slides" || value === "document" || value === "spreadsheet") return value;
  throw toolError("INVALID", `artifact type must be one of slides, document, spreadsheet; got: ${value}`);
}

function requireProjectId(ctx: { projectId?: string | undefined }): string {
  if (!ctx.projectId) {
    throw toolError("PROJECT_NOT_SELECTED", "artifact operations require a current project in the execution context (ctx.projectId)");
  }
  return ctx.projectId;
}

function parseSpec(type: RenderableType, spec: unknown): unknown {
  try {
    return RENDERABLE[type].parse(spec);
  } catch (error) {
    throw toolError("INVALID", `invalid ${type} spec: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Absolute store root of the injected artifact service's file store. */
function artifactStoreRoot(artifacts: ArtifactService): string {
  const store = (artifacts as unknown as { store?: { root?: string } }).store;
  if (!store?.root) throw toolError("STORE_NOT_CONFIGURED", "artifact service was not constructed with a file artifact store");
  return store.root;
}

/** Artifact tools: create, revise, preview, and export rendered documents through the real renderers. */
export function createArtifactTools(): AgentToolDefinition[] {
  return [
    {
      name: "artifact.create",
      description: "Render a slides deck (pptx + SVG thumbnails), a document (docx + text preview), or a spreadsheet (xlsx + csv + json preview) from a spec, and register it on the current project. Use for any deliverable the user should open or download.",
      capabilityPack: "artifact",
      permission: "write",
      parameters: z.object({
        type: z.enum(["slides", "document", "spreadsheet"]),
        title: z.string().min(1),
        spec: z.record(z.string(), z.unknown())
      }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({
          type: z.enum(["slides", "document", "spreadsheet"]),
          title: z.string().min(1),
          spec: z.record(z.string(), z.unknown())
        }).parse(raw);
        const projectId = requireProjectId(ctx);
        const type = renderableType(params.type);
        const spec = parseSpec(type, params.spec);
        const sessionId = z.string().uuid().safeParse(ctx.sessionId).success ? ctx.sessionId : undefined;
        const record = await deps.artifacts.createFromRenderer(
          projectId,
          type,
          params.title,
          spec as never,
          RENDERABLE[type].renderer(),
          sessionId !== undefined ? { sessionId } : {}
        );
        await deps.kernel.registerArtifact({
          id: record.id,
          projectId,
          type,
          title: params.title,
          ...(sessionId !== undefined ? { sessionId } : {})
        });
        return succeed("artifact.create", ctx, { artifact: record }, {
          evidenceIds: [`artifact:${record.id}`],
          artifactIds: [record.id]
        });
      }
    },
    {
      name: "artifact.get",
      description: "Read one artifact record (status, version, previewUrl, export formats).",
      capabilityPack: "artifact",
      permission: "read",
      parameters: IdParams,
      execute: async (raw, ctx, deps) => {
        const params = IdParams.parse(raw);
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) throw toolError("ARTIFACT_NOT_FOUND", `artifact not found: ${params.id}`);
        return succeed("artifact.get", ctx, { artifact });
      }
    },
    {
      name: "artifact.list",
      description: "List artifacts of a project (defaults to the current project).",
      capabilityPack: "artifact",
      permission: "read",
      parameters: z.object({ projectId: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = z.object({ projectId: z.string().min(1).optional() }).parse(raw);
        const projectId = params.projectId ?? ctx.projectId;
        const artifacts = await deps.artifacts.list(projectId);
        return succeed("artifact.list", ctx, { artifacts, count: artifacts.length });
      }
    },
    {
      name: "artifact.preview",
      description: "Read an artifact's preview: the store-relative previewUrl plus the current version's thumbnail/preview files. Use to show the user what a render produced.",
      capabilityPack: "artifact",
      permission: "read",
      parameters: IdParams,
      execute: async (raw, ctx, deps) => {
        const params = IdParams.parse(raw);
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) throw toolError("ARTIFACT_NOT_FOUND", `artifact not found: ${params.id}`);
        const versions = await deps.artifacts.listVersions(params.id);
        const latest = versions.at(-1);
        const previews = (latest?.files ?? []).filter((file) => /thumb|preview/i.test(file) || file.endsWith(".svg"));
        return succeed("artifact.preview", ctx, {
          id: artifact.id,
          previewUrl: artifact.previewUrl ?? null,
          version: artifact.version,
          thumbnails: previews
        });
      }
    },
    {
      name: "artifact.revise",
      description: "Revise an artifact into a new version: slides take slideIndex + a slide patch (heading/bullets/table/chart/notes/kpi); documents and spreadsheets take a spec object that is merged over the stored spec and re-rendered.",
      capabilityPack: "artifact",
      permission: "write",
      parameters: IdParams.extend({
        slideIndex: z.number().int().nonnegative().optional(),
        patch: z.record(z.string(), z.unknown()).optional(),
        spec: z.record(z.string(), z.unknown()).optional()
      }),
      execute: async (raw, ctx, deps) => {
        const params = IdParams.extend({
          slideIndex: z.number().int().nonnegative().optional(),
          patch: z.record(z.string(), z.unknown()).optional(),
          spec: z.record(z.string(), z.unknown()).optional()
        }).parse(raw);
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) throw toolError("ARTIFACT_NOT_FOUND", `artifact not found: ${params.id}`);
        if (artifact.type === "slides") {
          if (params.slideIndex === undefined || params.patch === undefined) {
            throw toolError("INVALID", "slides revision requires slideIndex and patch");
          }
          const record = await deps.artifacts.updateSlide(params.id, params.slideIndex, params.patch as never);
          return succeed("artifact.revise", ctx, { artifact: record }, { artifactIds: [record.id] });
        }
        const type = renderableType(artifact.type);
        if (params.spec === undefined) {
          throw toolError("INVALID", `${artifact.type} revision requires a spec object merged over the stored spec`);
        }
        const storedBuffer = await deps.artifacts.readOutput(params.id, "spec.json");
        if (!storedBuffer) throw toolError("ARTIFACT_NOT_FOUND", `artifact ${params.id} has no stored spec to revise`);
        const stored = JSON.parse(storedBuffer.toString("utf8")) as Record<string, unknown>;
        const merged = parseSpec(type, { ...stored, ...params.spec });
        const record = await deps.artifacts.createFromRenderer(
          artifact.projectId,
          artifact.type as ArtifactType,
          artifact.title,
          merged as never,
          RENDERABLE[type].renderer(),
          artifact.sessionId ? { sessionId: artifact.sessionId } : {}
        );
        return succeed("artifact.revise", ctx, { artifact: record }, { artifactIds: [record.id] });
      }
    },
    {
      name: "artifact.export",
      description: "Return the on-disk download paths of an artifact's current version, optionally filtered to one export format (pptx, docx, xlsx, csv, svg, json, txt).",
      capabilityPack: "artifact",
      permission: "read",
      parameters: IdParams.extend({ format: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = IdParams.extend({ format: z.string().min(1).optional() }).parse(raw);
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) throw toolError("ARTIFACT_NOT_FOUND", `artifact not found: ${params.id}`);
        const versions = await deps.artifacts.listVersions(params.id);
        const latest = versions.at(-1);
        if (!latest) throw toolError("ARTIFACT_NOT_FOUND", `artifact ${params.id} has no rendered versions`);
        const files = params.format !== undefined
          ? latest.files.filter((file) => file.endsWith(`.${params.format!}`))
          : latest.files;
        const root = artifactStoreRoot(deps.artifacts);
        return succeed("artifact.export", ctx, {
          id: artifact.id,
          version: latest.version,
          exportFormats: artifact.exportFormats,
          downloads: files.map((file) => join(root, artifact.id, `v${latest.version}`, file))
        });
      }
    },
    {
      name: "artifact.attach_to_task",
      description: "Attach an artifact to a task as evidence (artifact:<id> lands in the task's evidenceIds and the artifact links to its project). Use to connect a deliverable to the task that produced it.",
      capabilityPack: "artifact",
      permission: "write",
      parameters: IdParams.extend({ taskId: z.string().min(1).optional() }),
      execute: async (raw, ctx, deps) => {
        const params = IdParams.extend({ taskId: z.string().min(1).optional() }).parse(raw);
        const artifact = await deps.artifacts.get(params.id);
        if (!artifact) throw toolError("ARTIFACT_NOT_FOUND", `artifact not found: ${params.id}`);
        const taskId = params.taskId ?? ctx.taskId;
        if (!taskId) {
          throw toolError("TASK_NOT_SELECTED", "no taskId was passed and the execution context has no current task");
        }
        const evidenceId = `artifact:${artifact.id}`;
        const task = await updateKernelTask(deps.kernel, taskId, deps.now(), (current) => ({
          evidenceIds: [...new Set([...current.evidenceIds, evidenceId])]
        }));
        // Keep the kernel project artifact list in step when the artifact is registered there.
        const kernelArtifact = await kernelStores(deps.kernel).artifacts.get(artifact.id);
        if (kernelArtifact) {
          await deps.kernel.linkArtifact(kernelArtifact.projectId, artifact.id);
        }
        return succeed("artifact.attach_to_task", ctx, { task, artifactId: artifact.id }, {
          evidenceIds: [evidenceId],
          artifactIds: [artifact.id]
        });
      }
    }
  ];
}
