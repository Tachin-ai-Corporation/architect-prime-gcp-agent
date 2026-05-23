"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function SignInContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";
  const error = searchParams.get("error");

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
          border: "1px solid rgba(255,255,255,0.08)",
          backdropFilter: "blur(20px)",
          maxWidth: "400px",
          width: "100%",
        }}
      >
        <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>🏗️</div>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            color: "#fff",
            margin: "0 0 0.5rem",
          }}
        >
          Architect Prime
        </h1>
        <p
          style={{
            color: "rgba(255,255,255,0.5)",
            fontSize: "0.9rem",
            margin: "0 0 2rem",
          }}
        >
          AI Agent Fleet Management
        </p>

        {error && (
          <div
            style={{
              padding: "0.75rem 1rem",
              borderRadius: "0.5rem",
              background: "rgba(239,68,68,0.1)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#fca5a5",
              fontSize: "0.85rem",
              marginBottom: "1.5rem",
            }}
          >
            {error === "AccessDenied"
              ? "Access denied. Only authorized domain accounts can sign in."
              : "An error occurred during sign-in. Please try again."}
          </div>
        )}

        <button
          onClick={() => signIn("google", { callbackUrl })}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.75rem",
            width: "100%",
            padding: "0.85rem 1.5rem",
            borderRadius: "0.75rem",
            border: "1px solid rgba(255,255,255,0.15)",
            background: "rgba(255,255,255,0.06)",
            color: "#fff",
            fontSize: "0.95rem",
            fontWeight: 500,
            cursor: "pointer",
            transition: "all 0.2s ease",
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.12)";
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = "rgba(255,255,255,0.06)";
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Sign in with Google
        </button>

        <p
          style={{
            marginTop: "1.5rem",
            fontSize: "0.75rem",
            color: "rgba(255,255,255,0.3)",
          }}
        >
          Sign in with your Google Workspace account
        </p>
      </div>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense>
      <SignInContent />
    </Suspense>
  );
}
