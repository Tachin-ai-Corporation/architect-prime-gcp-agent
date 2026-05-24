"use client";

import { redirect } from "next/navigation";

/**
 * /p/[id]/models — Redirects to /settings (Models tab)
 * Model discovery is now a global dashboard setting, not per-prime.
 */
export default function PrimeModelsRedirect() {
  redirect("/settings?tab=models");
}
