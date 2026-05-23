"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const errorMessages: Record<string, string> = {
  Configuration: "There is a problem with the server configuration.",
  AccessDenied: "Access denied. Only authorized domain accounts can sign in.",
  Verification: "The sign-in link is no longer valid.",
  OAuthSignin: "Error connecting to Google. Please try again.",
  OAuthCallback: "Error during sign-in callback. Please try again.",
  OAuthCreateAccount: "Could not create account. Please try again.",
  EmailCreateAccount: "Could not create account. Please try again.",
  Callback: "Error during sign-in. Please try again.",
  OAuthAccountNotLinked: "This email is already linked to another account.",
  SessionRequired: "Please sign in to continue.",
  Default: "An unexpected error occurred. Please try again.",
};

function ErrorContent() {
  const searchParams = useSearchParams();
  const error = searchParams.get("error") || "";
  const message = errorMessages[error] || errorMessages.Default;

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
          {message}
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
