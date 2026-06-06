"use client";
import { use } from "react";

export default function PrimeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <>{children}</>;
}
