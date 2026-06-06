"use client";

import Link from "next/link";
import styles from "../stub.module.css";

export default function AgentTypesPage() {
  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Agent Types</h1>
        <p className={styles.subtitle}>
          Agent type explorer will be migrated here from /agent-types in Phase 3.
        </p>
        <Link href="/library" className={styles.backLink}>
          ← Back to Library
        </Link>
      </div>
    </div>
  );
}
