import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { DialogProvider } from "@/components/DialogProvider";
import { PrimeProvider } from "@/contexts/PrimeContext";
import { Shell } from "@/components/Shell";

// Self-hosted Inter (variable font) — loaded from a repo-committed woff2 via next/font/local so the
// Docker build never fetches from Google Fonts at build time (that build-time fetch was flaky in Cloud
// Build and failed the dashboard upgrade with a font module-not-found error). No network at build; the
// exact Inter typography is preserved.
const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  weight: "300 700",
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Architect Prime",
  description: "AI Agent Fleet Management — Control Plane",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={inter.className}>
        <AuthProvider>
          <DialogProvider>
            <PrimeProvider>
              <Shell>{children}</Shell>
            </PrimeProvider>
          </DialogProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
