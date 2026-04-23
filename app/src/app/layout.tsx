import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
