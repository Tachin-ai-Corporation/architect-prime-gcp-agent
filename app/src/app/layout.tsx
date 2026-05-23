import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/components/AuthProvider";
import { DialogProvider } from "@/components/DialogProvider";
import { PrimeProvider } from "@/contexts/PrimeContext";
import { Shell } from "@/components/Shell";

const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
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
