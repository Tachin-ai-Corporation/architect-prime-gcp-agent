"use client";

import { NavCard } from "@/components/NavCard";
import styles from "./page.module.css";

export default function LibraryPage() {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <h1 className={styles.title}>Library</h1>
        <p className={styles.subtitle}>
          Global resources available across all primes and agents
        </p>
      </header>

      <div className={styles.grid}>
        <NavCard
          icon="🧩"
          title="Skills"
          description="Browse the skill catalog — tools, manifests, and capabilities each role receives at hire"
          href="/library/skills"
        />
        <NavCard
          icon="🎭"
          title="Roles"
          description="Fleet class roster — brain layers, skills, and duties each role receives at hire"
          href="/library/agent-types"
        />
        <NavCard
          icon="🧠"
          title="Models"
          description="Scan Vertex AI availability — Gemini, Claude, and partner models"
          href="/library/models"
        />
      </div>
    </div>
  );
}
