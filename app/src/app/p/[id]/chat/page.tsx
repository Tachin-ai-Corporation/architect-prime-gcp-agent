"use client";
import { use } from "react";
import { ChatPanel } from "@/components/ChatPanel";
import { usePrime } from "@/contexts/PrimeContext";

export default function PrimeChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { primes } = usePrime();
  const prime = primes.find(p => p.id === id);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ChatPanel
        primeId={id}
        entityName={prime?.name || id}
        entityStatus={prime?.status}
        inline
      />
    </div>
  );
}
