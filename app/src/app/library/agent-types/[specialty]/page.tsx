"use client";

import { use } from "react";
import Link from "next/link";
import styles from "../../stub.module.css";

export default function AgentTypeDetailPage({
  params,
}: {
  params: Promise<{ specialty: string }>;
}) {
  const { specialty } = use(params);
  const displayName = specialty.charAt(0).toUpperCase() + specialty.slice(1);

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>{displayName}</h1>
        <p className={styles.subtitle}>
          Agent type detail will be migrated here in Phase 3.
        </p>
        <Link href="/library/agent-types" className={styles.backLink}>
          ← Back to Agent Types
        </Link>
      </div>
    </div>
  );
}
