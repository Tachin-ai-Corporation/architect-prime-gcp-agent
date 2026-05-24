"use client";

import { useParams, redirect } from "next/navigation";

/**
 * /p/[id]/brain — Redirects to /p/[id]/models
 * Prime's "Brain" page is the model picker.
 */
export default function PrimeBrainPage() {
  const { id } = useParams<{ id: string }>();
  redirect(`/p/${id}/models`);
}
