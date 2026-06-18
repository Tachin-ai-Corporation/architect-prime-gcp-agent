"use client";

import { useState, useEffect, useCallback } from "react";
import { usePrime } from "@/contexts/PrimeContext";
import styles from "@/app/settings/page.module.css";

export function GeneralTab() {
  const { setup, primes, sidebarFleet } = usePrime();

  // Agent email domain editing state
  const [emailDomain, setEmailDomain] = useState(setup.agentEmailDomain || "");
  const [domainSaving, setDomainSaving] = useState(false);
  const [domainSaved, setDomainSaved] = useState(false);

  // Artifacts root folder editing state
  const [artifactsFolder, setArtifactsFolder] = useState(setup.artifactsRootFolderId || "");
  const [artifactsSaving, setArtifactsSaving] = useState(false);
  const [artifactsSaved, setArtifactsSaved] = useState(false);

  // Sync local state when setup loads from context
  useEffect(() => {
    if (setup.agentEmailDomain) setEmailDomain(setup.agentEmailDomain);
  }, [setup.agentEmailDomain]);

  useEffect(() => {
    if (setup.artifactsRootFolderId) setArtifactsFolder(setup.artifactsRootFolderId);
  }, [setup.artifactsRootFolderId]);

  const handleSaveDomain = useCallback(async () => {
    setDomainSaving(true);
    setDomainSaved(false);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentEmailDomain: emailDomain.trim() }),
      });
      if (res.ok) {
        setDomainSaved(true);
        setTimeout(() => setDomainSaved(false), 2500);
      }
    } catch { /* ignore */ }
    setDomainSaving(false);
  }, [emailDomain]);

  const handleSaveArtifactsFolder = useCallback(async () => {
    setArtifactsSaving(true);
    setArtifactsSaved(false);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ artifactsRootFolderId: artifactsFolder.trim() }),
      });
      if (res.ok) {
        setArtifactsSaved(true);
        setTimeout(() => setArtifactsSaved(false), 2500);
      }
    } catch { /* ignore */ }
    setArtifactsSaving(false);
  }, [artifactsFolder]);

  const fleetCount = Object.values(sidebarFleet || {}).flat().filter((a: any) => a.status !== "removed").length;

  return (
    <>
      {/* Project Info */}
      <section className={styles.section} id="settings-project-info">
        <div className={styles.sectionTitle}>Project Info</div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>GCP Project</span>
          <span className={styles.fieldValue}>{setup.projectId || "—"}</span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>DWD Signer SA</span>
          <span className={styles.fieldValue}>{setup.dwdSignerSA || "—"}</span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Prime Instances</span>
          <span className={styles.fieldValue}>{primes?.length || 0}</span>
        </div>
        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Fleet Agents</span>
          <span className={styles.fieldValue}>{fleetCount}</span>
        </div>
      </section>

      {/* Agent Defaults */}
      <section className={styles.section} id="settings-agent-defaults">
        <div className={styles.sectionTitle}>Agent Defaults</div>
        <div className={styles.sectionDesc}>
          Configure defaults that apply to all new fleet agents.
        </div>
        <div className={styles.fieldRow} style={{ alignItems: "center" }}>
          <span className={styles.fieldLabel}>Agent Email Domain</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="settings-email-domain-input"
              className="input"
              style={{ width: 220, fontSize: 13 }}
              placeholder="e.g. yourcompany.com"
              value={emailDomain}
              onChange={(e) => setEmailDomain(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter") handleSaveDomain();
              }}
            />
            <button
              id="settings-email-domain-save"
              className="btn btn-sm btn-primary"
              onClick={handleSaveDomain}
              disabled={domainSaving}
            >
              {domainSaving ? "Saving..." : "Save"}
            </button>
            {domainSaved && (
              <span style={{ color: "#3BAA78", fontSize: 12, fontWeight: 500 }}>✓ Saved</span>
            )}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#566373", marginTop: 4 }}>
          When set, agent emails auto-fill as{" "}
          <code style={{ fontSize: 10, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
            specialty-agent-name@domain
          </code>{" "}
          during hire.
        </div>
      </section>

      {/* Artifacts */}
      <section className={styles.section} id="settings-artifacts">
        <div className={styles.sectionTitle}>
          Artifacts
          <span
            className={`${styles.badge} ${artifactsFolder ? styles.badgeSuccess : styles.badgeWarning}`}
          >
            {artifactsFolder ? "Configured" : "Not configured"}
          </span>
        </div>
        <div className={styles.sectionDesc}>
          Configure the Google Drive folder where project artifacts are stored.
          Each project gets its own subfolder. Agents auto-publish work products here on mission completion.
        </div>
        <div className={styles.fieldRow} style={{ alignItems: "center" }}>
          <span className={styles.fieldLabel}>Root Drive Folder ID</span>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id="settings-artifacts-folder-input"
              className="input"
              style={{ width: 320, fontSize: 13, fontFamily: "monospace" }}
              placeholder="e.g. 1AbC2dEf3GhI4jKlMnOp..."
              value={artifactsFolder}
              onChange={(e) => setArtifactsFolder(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter") handleSaveArtifactsFolder();
              }}
            />
            <button
              id="settings-artifacts-folder-save"
              className="btn btn-sm btn-primary"
              onClick={handleSaveArtifactsFolder}
              disabled={artifactsSaving}
            >
              {artifactsSaving ? "Saving..." : "Save"}
            </button>
            {artifactsSaved && (
              <span style={{ color: "#3BAA78", fontSize: 12, fontWeight: 500 }}>✓ Saved</span>
            )}
          </span>
        </div>
        <div style={{ fontSize: 11, color: "#566373", marginTop: 4 }}>
          Create a folder in{" "}
          <a
            href="https://drive.google.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#6B9FE8" }}
          >
            Google Drive
          </a>
          , then paste its folder ID here. The ID is the last part of the folder URL:{" "}
          <code style={{ fontSize: 10, background: "rgba(32,40,51,0.5)", padding: "1px 4px", borderRadius: 3 }}>
            drive.google.com/drive/folders/<strong>folder-id-here</strong>
          </code>
        </div>
        {artifactsFolder && (
          <div style={{ marginTop: 8 }}>
            <a
              href={`https://drive.google.com/drive/folders/${artifactsFolder}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: "#6B9FE8" }}
            >
              📁 Open folder in Drive →
            </a>
          </div>
        )}
      </section>
    </>
  );
}
