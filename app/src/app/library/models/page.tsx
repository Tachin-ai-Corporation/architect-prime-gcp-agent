"use client";

import Link from "next/link";
import styles from "../stub.module.css";

export default function ModelCatalogPage() {
  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Model Catalog</h1>
        <p className={styles.subtitle}>
          Model scanning and catalog will be migrated here from Settings in Phase 3.
        </p>
        <Link href="/library" className={styles.backLink}>
          ← Back to Library
        </Link>
      </div>
    </div>
  );
}
