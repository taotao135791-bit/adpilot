import { useCallback, useEffect, useState } from "react";
import { workspaceCopy, type AppLocale } from "../labels.js";
import { interpolate, type SkillSummary, type SkillWarning } from "../workspace.js";
import { Badge, Button } from "../ui.js";
import { IconAlert, IconBook, IconRefresh } from "../icons.js";

/**
 * Skills view: the merged built-in and user skill catalog served by
 * GET /api/skills. User-global ~/.adpilot/skills and per-workspace
 * .adpilot/skills retain their override semantics. Validation warnings surface
 * as a banner; every item is read-only reference knowledge — it grants no
 * tools or permissions.
 */
export function SkillsView({ locale }: { locale: AppLocale }) {
  const copy = workspaceCopy(locale);
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [warnings, setWarnings] = useState<SkillWarning[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error(String(response.status));
      const body = await response.json() as { skills?: SkillSummary[]; warnings?: SkillWarning[] };
      setSkills(body.skills ?? []);
      setWarnings(body.warnings ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="workbench skills-view">
      <header className="workbench-head">
        <div>
          <h1>{copy.skillsTitle}</h1>
          <p>{copy.skillsBody}</p>
        </div>
        <Button size="sm" variant="subtle" className="icon-button" icon={<IconRefresh size={14} />} aria-label={copy.refresh} onClick={() => void load()} />
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button size="sm" variant="subtle" onClick={() => void load()}>{copy.retry}</Button>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="panel-banner" data-tone="warning" role="status">
          <IconAlert size={14} />
          <div>
            <strong>{copy.skillsWarnings}</strong>
            <p>{warnings.map((warning) => `${warning.path}: ${warning.reason}`).join(" · ")}</p>
          </div>
        </div>
      )}

      {skills === null ? (
        <p className="workbench-quiet">{copy.loading}…</p>
      ) : skills.length === 0 ? (
        <div className="empty-block">
          <IconBook size={22} />
          <strong>{copy.skillsEmpty}</strong>
          <p>{copy.skillsEmptyBody}</p>
        </div>
      ) : (
        <div className="card-grid">
          {skills.map((skill) => (
            <div key={skill.name} className="skill-card">
              <div className="project-card-head">
                <strong className="mono">{skill.name}</strong>
                <div className="project-card-meta">
                  <Badge tone="neutral" variant="outline">
                    {interpolate(copy.skillSource, {
                      source: skill.source === "built-in"
                        ? copy.skillSourceBuiltIn
                        : skill.source === "workspace"
                          ? copy.skillSourceWorkspace
                          : copy.skillSourceUser
                    })}
                  </Badge>
                  {skill.publisher && <Badge tone="neutral" variant="soft">{skill.publisher}</Badge>}
                  {skill.license && <Badge tone="neutral" variant="outline">{interpolate(copy.skillLicense, { license: skill.license })}</Badge>}
                </div>
              </div>
              <p>{skill.description}</p>
              {skill.triggers.length > 0 && (
                <div className="project-card-meta">
                  <span className="home-list-meta">{copy.skillTriggers}</span>
                  {skill.triggers.slice(0, 6).map((trigger) => (
                    <Badge key={trigger} tone="accent" variant="soft">{trigger}</Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
