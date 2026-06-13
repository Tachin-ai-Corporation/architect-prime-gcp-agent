"use client";

import { use } from "react";
import { FleetPanel } from "@/components/fleet/FleetPanel";

export default function FleetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <FleetPanel primeId={id} />;
}
