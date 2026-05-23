"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function ErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error") || "Unknown error";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 50%, #16213e 100%)",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          textAlign: "center",
          padding: "3rem 2.5rem",
          borderRadius: "1.25rem",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(239,68,68,0.2)",
          maxWidth: "400px",
          width: "100%",
        }}
      >
        <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🚫</div>
        <h1 style={{ fontSize: "1.25rem", color: "#fca5a5", margin: "0 0 1rem" }}>
          Authentication Error
        </h1>
        <p style={{ color: "rgba(255,255,255,0.6)", fontSize: "0.9rem", margin: "0 0 1.5rem" }}>
          {error === "AccessDenied"
            ? "Your account is not authorized to access this dashboard. Only users from the organization's Google Workspace domain can sign in."
            : `An error occurred: ${error}`}
        </p>
        <a
          href="/auth/signin"
          style={{
            display: "inline-block",
            padding: "0.65rem 1.5rem",
            borderRadius: "0.5rem",
            background: "rgba(255,255,255,0.08)",
            color: "#fff",
            textDecoration: "none",
            fontSize: "0.9rem",
          }}
        >
          ← Try again
        </a>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense>
      <ErrorContent />
    </Suspense>
  );
}
