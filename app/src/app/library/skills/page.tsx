"use client";

import Link from "next/link";
import styles from "../stub.module.css";

export default function SkillCatalogPage() {
  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Skill Catalog</h1>
        <p className={styles.subtitle}>
          Skill catalog will be migrated here from the current /skills page in Phase 3.
        </p>
        <Link href="/library" className={styles.backLink}>
          ← Back to Library
        </Link>
      </div>
    </div>
  );
}
