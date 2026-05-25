"use client";

import styles from "../../app/page.module.css";
import type { SetupState } from "@/lib/types";

/* ---- DWD Guide (used by homepage onboarding) ---- */
export function DWDGuide({ setup, copied, onCopy }: {
  setup: SetupState;
  copied: string;
  onCopy: (text: string, label: string) => void;
}) {
  const clientId = setup.dwdClientId || "Loading...";
  const scopes = "https://www.googleapis.com/auth/chat.messages, https://www.googleapis.com/auth/chat.spaces";

  return (
    <div className={styles["dwd-guide"]}>
      <div className={styles["dwd-guide-title"]}>Configuration Values</div>

      <div className={styles["dwd-copy-row"]}>
        <span className={styles["dwd-copy-label"]}>Client ID</span>
        <span className={styles["dwd-copy-value"]}>{clientId}</span>
        <button className={`${styles["dwd-copy-btn"]} ${copied === "clientId" ? styles.copied : ""}`}
          onClick={() => onCopy(clientId, "clientId")}>
          {copied === "clientId" ? "✓" : "Copy"}
        </button>
      </div>

      <div className={styles["dwd-copy-row"]}>
        <span className={styles["dwd-copy-label"]}>OAuth Scopes</span>
        <span className={styles["dwd-copy-value"]}>{scopes}</span>
        <button className={`${styles["dwd-copy-btn"]} ${copied === "scopes" ? styles.copied : ""}`}
          onClick={() => onCopy(scopes, "scopes")}>
          {copied === "scopes" ? "✓" : "Copy"}
        </button>
      </div>

      <ol className={styles["dwd-steps"]}>
        <li>Open <a href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener noreferrer">Workspace Admin → Security → API Controls → DWD</a></li>
        <li>Click <strong>&quot;Add new&quot;</strong></li>
        <li>Paste the <strong>Client ID</strong> above</li>
        <li>Paste the <strong>OAuth Scopes</strong> above</li>
        <li>Click <strong>&quot;Authorize&quot;</strong></li>
      </ol>
    </div>
  );
}
