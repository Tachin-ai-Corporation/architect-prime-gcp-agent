"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { api } from "@/lib/api";
import { ContextEditor } from "@/components/projects/ContextEditor";
import type { ContextEntry } from "@/components/projects/ContextEditor";

/* ---- Types ---- */
interface StepDef {
  title: string;
  description: string;
  agent: string;
  type: "standard" | "delegation" | "spawn_responsibility" | "approval_gate";
  optional?: boolean;
  checkpointBoundary?: boolean;
}

interface ParamDef {
  key: string;
  type: string;
  default: string;
  description: string;
}

interface ChangelogEntry {
  version: number;
  timestamp: string;
  author: string;
  summary: string;
}

interface ProcessSummary {
  id: string;
  name: string;
  description: string;
  status: "active" | "deprecated";
  version: number;
  execution_count: number;
  created_by: string;
  created_at: string;
  steps: StepDef[];
}

interface ProcessDetail extends ProcessSummary {
  parameters: Record<string, ParamDef>;
  contextTemplate: Record<string, ContextEntry>;
  changelog: ChangelogEntry[];
  visibility: string;
  updated_at?: string;
}

/* ---- Constants ---- */
const STEP_TYPES: StepDef["type"][] = ["standard", "delegation", "spawn_responsibility", "approval_gate"];

const TYPE_ICONS: Record<StepDef["type"], string> = {
  standard: "⚡",
  delegation: "🔀",
  spawn_responsibility: "🔄",
  approval_gate: "✅",
};

const TYPE_CLASSES: Record<StepDef["type"], string> = {
  standard: styles.typeStandard,
  delegation: styles.typeDelegation,
  spawn_responsibility: styles.typeSpawn,
  approval_gate: styles.typeApproval,
};

/* ---- Wrapper with Suspense ---- */
export default function ProcessesPageWrapper() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: "center", color: "#AEB8C4" }}>Loading…</div>}>
      <ProcessesPage />
    </Suspense>
  );
}

/* ---- Main page ---- */
function ProcessesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { primes } = usePrime();

  /* ---- URL params ---- */
  const paramPrime = searchParams.get("prime");
  const paramProcess = searchParams.get("process");

  const selectedPrimeId = paramPrime && primes.find((p) => p.id === paramPrime)
    ? paramPrime
    : primes[0]?.id || null;

  /* ---- Render either list or detail ---- */
  return (
    <div className={styles.shell}>
      {paramProcess && selectedPrimeId ? (
        <ProcessDetailView
          primeId={selectedPrimeId}
          processId={paramProcess}
          router={router}
        />
      ) : selectedPrimeId ? (
        <ProcessListView primeId={selectedPrimeId} router={router} />
      ) : (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>◎</div>
          <div className={styles.emptyTitle}>No primes configured</div>
          <div className={styles.emptySub}>Set up a prime instance to get started</div>
        </div>
      )}
    </div>
  );
}

/* ================================================================
   List View
   ================================================================ */
function ProcessListView({ primeId, router }: { primeId: string; router: ReturnType<typeof useRouter> }) {
  const [processes, setProcesses] = useState<ProcessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  /* ---- Fetch processes ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ processes: ProcessSummary[] }>(`/api/primes/${primeId}/processes`);
      if (!cancelled) {
        setProcesses(data?.processes ?? []);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId]);

  const handleSelectProcess = useCallback(
    (processId: string) => {
      const params = new URLSearchParams();
      params.set("prime", primeId);
      params.set("process", processId);
      router.push(`/processes?${params.toString()}`);
    },
    [primeId, router]
  );

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading processes…</span>
      </div>
    );
  }

  return (
    <>
      <div className={styles.pgHeader}>
        <h1 className={styles.pgTitle}>Processes</h1>
        <span className={styles.countPill}>{processes.length} total</span>
      </div>
      <div className={styles.pgSub}>
        Define repeatable workflows with ordered steps, parameters, and context templates
      </div>

      {/* ---- Grid ---- */}
      <div className={styles.grid}>
        {processes.map((proc) => (
          <button
            key={proc.id}
            className={styles.card}
            onClick={() => handleSelectProcess(proc.id)}
          >
            <div className={styles.cardHeader}>
              <span className={styles.cardName}>{proc.name}</span>
              <span className={`${styles.statusBadge} ${proc.status === "active" ? styles.badgeActive : styles.badgeDeprecated}`}>
                {proc.status}
              </span>
            </div>
            <div className={styles.cardDesc}>{truncate(proc.description, 100)}</div>

            <div className={styles.cardMeta}>
              <span className={styles.versionBadge}>v{proc.version}</span>
              <span className={styles.cardMetaItem}>{proc.steps?.length ?? 0} steps</span>
              <span className={styles.cardMetaItem}>⚡ {proc.execution_count} runs</span>
              <span className={styles.cardMetaItem}>by {proc.created_by}</span>
            </div>
          </button>
        ))}

        {/* ---- Create card ---- */}
        <button className={styles.createCard} onClick={() => setShowCreate(true)}>
          <span className={styles.createIcon}>+</span>
          <span className={styles.createLabel}>Create Process</span>
        </button>
      </div>

      {/* ---- Create modal ---- */}
      {showCreate && (
        <CreateProcessModal
          primeId={primeId}
          onClose={() => setShowCreate(false)}
          onCreated={(proc) => {
            setProcesses((prev) => [proc, ...prev]);
            setShowCreate(false);
          }}
        />
      )}
    </>
  );
}

/* ================================================================
   Detail View
   ================================================================ */
function ProcessDetailView({
  primeId,
  processId,
  router,
}: {
  primeId: string;
  processId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const [process, setProcess] = useState<ProcessDetail | null>(null);
  const [loading, setLoading] = useState(true);

  /* ---- Fetch process ---- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const data = await api<{ process: ProcessDetail }>(`/api/primes/${primeId}/processes/${processId}`);
      if (!cancelled && data?.process) {
        setProcess(data.process);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [primeId, processId]);

  /* ---- Back nav ---- */
  const handleBack = useCallback(() => {
    const params = new URLSearchParams();
    params.set("prime", primeId);
    router.push(`/processes?${params.toString()}`);
  }, [primeId, router]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <span className={styles.loadingDots}>Loading process…</span>
      </div>
    );
  }

  if (!process) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>⚠</div>
        <div className={styles.emptyTitle}>Process not found</div>
        <button className={styles.backBtn} onClick={handleBack}>← Back to processes</button>
      </div>
    );
  }

  const paramEntries = Object.entries(process.parameters || {});
  const contextEntries = Object.entries(process.contextTemplate || {});
  const changelog = process.changelog || [];

  return (
    <>
      {/* ---- Header ---- */}
      <button className={styles.backBtn} onClick={handleBack}>← Back to processes</button>

      <div className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <h1 className={styles.pgTitle}>{process.name}</h1>
          <span className={styles.versionBadge}>v{process.version}</span>
          <span className={`${styles.statusBadge} ${process.status === "active" ? styles.badgeActive : styles.badgeDeprecated}`}>
            {process.status}
          </span>
        </div>
        <div className={styles.detailDesc}>{process.description}</div>
        <div className={styles.detailMetaRow}>
          <span className={styles.detailMetaItem}>⚡ {process.execution_count} executions</span>
          <span className={styles.detailMetaItem}>👤 {process.created_by}</span>
          <span className={styles.detailMetaItem}>📅 {new Date(process.created_at).toLocaleDateString()}</span>
          {process.visibility && (
            <span className={styles.detailMetaItem}>👁 {process.visibility}</span>
          )}
        </div>
      </div>

      {/* ---- Steps ---- */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <h2 className={styles.sectionTitle}>Steps</h2>
          <span className={styles.countPill}>{process.steps.length} steps</span>
        </div>
        <div className={styles.stepList}>
          {process.steps.map((step, i) => (
            <div key={i} className={styles.stepItem}>
              <div className={`${styles.stepDot} ${step.checkpointBoundary ? styles.stepDotCheckpoint : ""}`} />
              <div className={styles.stepNumber}>Step {i + 1}</div>
              <div className={styles.stepTitle}>
                <span>{TYPE_ICONS[step.type]}</span>
                {step.title}
              </div>
              {step.description && <div className={styles.stepDesc}>{step.description}</div>}
              <div className={styles.stepMeta}>
                <span className={`${styles.typeBadge} ${TYPE_CLASSES[step.type]}`}>
                  {step.type.replace("_", " ")}
                </span>
                {step.agent && <span className={styles.stepAgent}>{step.agent}</span>}
                {step.optional && <span className={styles.optionalFlag}>Optional</span>}
                {step.checkpointBoundary && <span className={styles.checkpointIndicator}>🔒 Checkpoint</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ---- Parameters ---- */}
      {paramEntries.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Parameters</h2>
          </div>
          <table className={styles.paramTable}>
            <thead>
              <tr>
                <th>Key</th>
                <th>Type</th>
                <th>Default</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {paramEntries.map(([key, param]) => (
                <tr key={key}>
                  <td><span className={styles.paramKey}>{key}</span></td>
                  <td><span className={styles.paramType}>{(param as ParamDef).type}</span></td>
                  <td>{(param as ParamDef).default || "—"}</td>
                  <td>{(param as ParamDef).description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Context Template ---- */}
      {contextEntries.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Context Template</h2>
          </div>
          <ContextEditor
            context={process.contextTemplate}
            onChange={() => {}}
            readOnly
          />
        </div>
      )}

      {/* ---- Changelog ---- */}
      {changelog.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Changelog</h2>
          </div>
          <div className={styles.changelog}>
            {[...changelog].reverse().map((entry, i) => (
              <div key={i} className={styles.changelogItem}>
                <div>
                  <span className={styles.changelogVersion}>v{entry.version}</span>
                  <span className={styles.changelogTime}>
                    {new Date(entry.timestamp).toLocaleDateString()} {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div className={styles.changelogSummary}>{entry.summary}</div>
                <div className={styles.changelogAuthor}>by {entry.author}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ================================================================
   Create Process Modal
   ================================================================ */
const BLANK_STEP: StepDef = {
  title: "",
  description: "",
  agent: "",
  type: "standard",
  optional: false,
  checkpointBoundary: false,
};

const BLANK_PARAM = { key: "", type: "string", default: "", description: "" };

function CreateProcessModal({
  primeId,
  onClose,
  onCreated,
}: {
  primeId: string;
  onClose: () => void;
  onCreated: (proc: ProcessSummary) => void;
}) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<StepDef[]>([{ ...BLANK_STEP }]);
  const [params, setParams] = useState<typeof BLANK_PARAM[]>([]);
  const [creating, setCreating] = useState(false);

  const updateStep = useCallback((index: number, field: keyof StepDef, value: any) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  }, []);

  const removeStep = useCallback((index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addStep = useCallback(() => {
    setSteps((prev) => [...prev, { ...BLANK_STEP }]);
  }, []);

  const updateParam = useCallback((index: number, field: string, value: string) => {
    setParams((prev) => prev.map((p, i) => (i === index ? { ...p, [field]: value } : p)));
  }, []);

  const removeParam = useCallback((index: number) => {
    setParams((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addParam = useCallback(() => {
    setParams((prev) => [...prev, { ...BLANK_PARAM }]);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!id.trim() || !name.trim() || steps.length === 0) return;
    setCreating(true);

    // Build parameters object
    const parametersObj: Record<string, any> = {};
    params.forEach((p) => {
      if (p.key.trim()) {
        parametersObj[p.key.trim()] = {
          type: p.type,
          default: p.default,
          description: p.description,
        };
      }
    });

    const result = await api<{ process: ProcessSummary }>(`/api/primes/${primeId}/processes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: id.trim(),
        name: name.trim(),
        description,
        steps,
        parameters: Object.keys(parametersObj).length > 0 ? parametersObj : undefined,
      }),
    });
    if (result?.process) {
      onCreated(result.process);
    }
    setCreating(false);
  }, [id, name, description, steps, params, primeId, onCreated]);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>Create Process</h2>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <label className={styles.fieldLabel}>Process ID</label>
          <input
            className={styles.fieldInput}
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="e.g. deploy-agent-v2"
          />

          <label className={styles.fieldLabel}>Name</label>
          <input
            className={styles.fieldInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Process name"
          />

          <label className={styles.fieldLabel}>Description</label>
          <textarea
            className={styles.fieldTextarea}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="What does this process do?"
          />

          {/* ---- Step Builder ---- */}
          <label className={styles.fieldLabel}>Steps</label>
          <div className={styles.stepBuilder}>
            {steps.map((step, i) => (
              <div key={i} className={styles.stepBuilderItem}>
                <div className={styles.stepBuilderHeader}>
                  <span className={styles.stepBuilderNum}>Step {i + 1}</span>
                  {steps.length > 1 && (
                    <button className={styles.removeStepBtn} onClick={() => removeStep(i)} type="button">
                      Remove
                    </button>
                  )}
                </div>
                <div className={styles.stepBuilderRow}>
                  <input
                    className={styles.fieldInput}
                    value={step.title}
                    onChange={(e) => updateStep(i, "title", e.target.value)}
                    placeholder="Step title"
                  />
                  <input
                    className={styles.fieldInput}
                    value={step.agent}
                    onChange={(e) => updateStep(i, "agent", e.target.value)}
                    placeholder="Agent name"
                  />
                </div>
                <input
                  className={styles.fieldInput}
                  value={step.description}
                  onChange={(e) => updateStep(i, "description", e.target.value)}
                  placeholder="Step description"
                />
                <div className={styles.stepBuilderRow}>
                  <select
                    className={styles.fieldSelect}
                    value={step.type}
                    onChange={(e) => updateStep(i, "type", e.target.value)}
                  >
                    {STEP_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {TYPE_ICONS[t]} {t.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.stepBuilderOptions}>
                  <label className={styles.fieldCheckbox}>
                    <input
                      type="checkbox"
                      checked={step.optional ?? false}
                      onChange={(e) => updateStep(i, "optional", e.target.checked)}
                    />
                    Optional
                  </label>
                  <label className={styles.fieldCheckbox}>
                    <input
                      type="checkbox"
                      checked={step.checkpointBoundary ?? false}
                      onChange={(e) => updateStep(i, "checkpointBoundary", e.target.checked)}
                    />
                    Checkpoint boundary
                  </label>
                </div>
              </div>
            ))}
            <button className={styles.addStepBtn} onClick={addStep} type="button">
              + Add Step
            </button>
          </div>

          {/* ---- Parameter Builder ---- */}
          <label className={styles.fieldLabel}>Parameters (Optional)</label>
          <div className={styles.paramBuilder}>
            {params.map((p, i) => (
              <div key={i} className={styles.paramBuilderRow}>
                <input
                  className={styles.fieldInput}
                  value={p.key}
                  onChange={(e) => updateParam(i, "key", e.target.value)}
                  placeholder="Key"
                />
                <select
                  className={styles.fieldSelect}
                  value={p.type}
                  onChange={(e) => updateParam(i, "type", e.target.value)}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                  <option value="array">array</option>
                  <option value="object">object</option>
                </select>
                <input
                  className={styles.fieldInput}
                  value={p.default}
                  onChange={(e) => updateParam(i, "default", e.target.value)}
                  placeholder="Default"
                />
                <input
                  className={styles.fieldInput}
                  value={p.description}
                  onChange={(e) => updateParam(i, "description", e.target.value)}
                  placeholder="Description"
                />
                <button className={styles.removeParamBtn} onClick={() => removeParam(i)} type="button">
                  ✕
                </button>
              </div>
            ))}
            <button className={styles.addStepBtn} onClick={addParam} type="button">
              + Add Parameter
            </button>
          </div>
        </div>

        <div className={styles.modalFooter}>
          <button className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            className={styles.createBtn}
            onClick={handleCreate}
            disabled={!id.trim() || !name.trim() || steps.length === 0 || !steps[0].title.trim() || creating}
          >
            {creating ? "Creating…" : "Create Process"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================
   Shared sub-components
   ================================================================ */

/* ---- Helpers ---- */
function truncate(text: string, max: number): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}
