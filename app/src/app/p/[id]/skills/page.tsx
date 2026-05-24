"use client";

import { useParams } from "next/navigation";
import styles from "./page.module.css";

/**
 * /p/[id]/skills — Prime Skills page
 * Shows installed skills/tools for the Prime instance.
 * Prime is infrastructure-only: fleet lifecycle tools, no workspace skills.
 */
export default function PrimeSkillsPage() {
  const { id } = useParams<{ id: string }>();

  const primeTools = [
    { name: "fleet-deploy", desc: "Deploy a new fleet agent VM" },
    { name: "fleet-hire", desc: "Hire agent — create VM, bootstrap OpenClaw" },
    { name: "fleet-fire", desc: "Terminate and remove a fleet agent" },
    { name: "fleet-status", desc: "Check fleet agent health and status" },
    { name: "fleet-upgrade", desc: "Upgrade CoreKit on a fleet agent" },
    { name: "fleet-monitor", desc: "Monitor fleet deployment progress" },
    { name: "command-runner", desc: "Execute queued commands from dashboard" },
    { name: "discover-models", desc: "Scan Vertex AI for available models" },
    { name: "upgrade-corekit", desc: "Self-upgrade CoreKit from main branch" },
    { name: "validate-contracts", desc: "Verify contracts.json compliance" },
    { name: "render-config", desc: "Render config templates with contracts" },
  ];

  return (
    <div className={styles.shell} id="prime-skills-page">
      <div className={styles.container}>
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>🔧 Prime Skills</h1>
            <p className={styles.subtitle}>
              {primeTools.length} tools · Infrastructure only · No workspace skills
            </p>
          </div>
        </header>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>Fleet Management Tools</div>
          <div className={styles.toolList}>
            {primeTools.map((tool) => (
              <div key={tool.name} className={styles.toolRow}>
                <code className={styles.toolName}>{tool.name}</code>
                <span className={styles.toolDesc}>{tool.desc}</span>
              </div>
            ))}
          </div>
        </section>

        <div className={styles.note}>
          <span className={styles.noteIcon}>ℹ️</span>
          <span>
            Prime is infrastructure-only — fleet management, visibility, hire/fire.
            Workspace skills (Drive, Gmail, etc.) are only installed on fleet agents.
          </span>
        </div>
      </div>
    </div>
  );
}
