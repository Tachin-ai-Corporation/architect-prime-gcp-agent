"use client";

import styles from "./AttachmentList.module.css";

interface Attachment {
  name: string;
  size: number;
  gcsPath: string;
}

interface AttachmentListProps {
  primeId: string;
  attachments?: Attachment[];
}

export function AttachmentList({ primeId, attachments }: AttachmentListProps) {
  if (!attachments || attachments.length === 0) return null;

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getIcon = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "pdf":
        return (
          <svg className={styles.fileIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        );
      case "zip":
      case "tar":
      case "gz":
        return (
          <svg className={styles.fileIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
        );
      case "png":
      case "jpg":
      case "jpeg":
      case "gif":
      case "webp":
        return (
          <svg className={styles.fileIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        );
      default:
        return (
          <svg className={styles.fileIcon} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        );
    }
  };

  return (
    <div className={styles.container}>
      {attachments.map((att, idx) => {
        const downloadUrl = `/api/primes/${primeId}/artifacts?gcsPath=${encodeURIComponent(att.gcsPath)}`;
        return (
          <a
            key={idx}
            href={downloadUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles.attachmentCard}
            title={`Download ${att.name}`}
          >
            <div className={styles.iconContainer}>{getIcon(att.name)}</div>
            <div className={styles.meta}>
              <span className={styles.filename}>{att.name}</span>
              <span className={styles.size}>{formatSize(att.size)}</span>
            </div>
            <div className={styles.downloadIcon}>
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" width={16} height={16}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
          </a>
        );
      })}
    </div>
  );
}
