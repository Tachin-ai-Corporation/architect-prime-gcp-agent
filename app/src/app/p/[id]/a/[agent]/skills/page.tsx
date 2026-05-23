"use client";

import { useParams } from "next/navigation";
import styles from "./page.module.css";
import { NavCard } from "@/components/NavCard";

const KITS = [
  {
    name: "base",
    title: "Core Runtime",
    description: "Base agent runtime, envelope processing, heartbeat, and daemon loop",
    scripts: 12,
  },
  {
    name: "role-fleet",
    title: "Fleet Overlay",
    description: "Fleet coordination, delegation, hiring, and inter-agent messaging",
    scripts: 8,
  },
  {
    name: "job-specialist",
    title: "Specialty Kit",
    description: "Role-specific tools and workspace files for the agent's assigned specialty",
    scripts: 6,
  },
];

export default function AgentSkills() {
  const { id, agent } = useParams<{ id: string; agent: string }>();

  return (
    <div className={styles.shell} id="agent-skills">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>🔧 Skills — {agent}</h1>
          <span className={styles.badge}>Installed Kits</span>
        </header>

        <p className={styles.intro}>
          Skill kits extend this agent&apos;s capabilities with specialized tools and scripts.
        </p>

        <div className={styles.grid} id="agent-skills-grid">
          {KITS.map((kit) => (
            <NavCard
              key={kit.name}
              id={`skill-${kit.name}`}
              icon={kit.name === "base" ? "📦" : kit.name === "role-fleet" ? "🤝" : "🎯"}
              title={kit.title}
              description={kit.description}
              variant="default"
              badge={`${kit.scripts} scripts`}
            />
          ))}

          <NavCard
            id="skill-browse"
            icon="📚"
            title="Browse Library"
            description="Explore and install additional skill kits"
            variant="accent"
            href={`/p/${id}/skills`}
          />
        </div>

        <div className={styles.note} id="agent-skills-note">
          <span className={styles.noteIcon}>ℹ️</span>
          <span>
            Skill kits are managed at the fleet level. Individual agents inherit kits based on their
            specialty assignment.
          </span>
        </div>
      </div>
    </div>
  );
}
