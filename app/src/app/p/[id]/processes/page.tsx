"use client";

import { use } from "react";
import Link from "next/link";
import styles from "../placeholder.module.css";

export default function ProcessesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <span className={styles.icon}>⚙️</span>
        <h1 className={styles.title}>Processes</h1>
        <p className={styles.description}>
          Manage agent responsibilities and scheduled processes.
          Configure cron expressions, review execution history, and tune automation.
        </p>
        <p className={styles.description}>Coming in Phase 3</p>
        <Link href={`/p/${id}`} className={styles.backLink}>
          ← Back to Hub
        </Link>
      </div>
    </div>
  );
}
