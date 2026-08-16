"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./FleetCommsReadOnly.module.css";
import { MarkdownMessage } from "./MarkdownMessage";
import { AttachmentList } from "./AttachmentList";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

interface FleetCommsReadOnlyProps {
  primeId: string;
  agentName: string;
}

export function FleetCommsReadOnly({ primeId, agentName }: FleetCommsReadOnlyProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const apiBase = `/api/primes/${primeId}/fleet/${agentName}/messages`;

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const loadMessages = useCallback(async () => {
    const data = await api<{ messages: ChatMessage[] }>(apiBase);
    if (data?.messages) {
      setMessages(data.messages);
    }
  }, [apiBase]);

  useEffect(() => {
    setMessages([]);
    loadMessages();
  }, [loadMessages]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div className={styles.commsPanel} id="fleet-comms-read-only">
      {/* Informational Banner */}
      <div className={styles.retirementBanner}>
        <div className={styles.bannerIcon}>💬</div>
        <div className={styles.bannerText}>
          <strong>Dashboard Chat Retired:</strong> Live interactive chat for fleet agents has migrated to direct Google Chat threads. This view is a read-only historic archive.
        </div>
      </div>

      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.hero}>
            <div className={styles.heroAvatar}>
              {agentName.charAt(0).toUpperCase()}
            </div>
            <h2 className={styles.heroTitle}>{agentName} Comms</h2>
            <p className={styles.heroSubtitle}>No historic communications found for this agent.</p>
          </div>
        </div>
      ) : (
        <div className={styles.chatMessages} ref={messagesRef}>
          <div className={styles.hero}>
            <div className={styles.heroAvatar}>
              {agentName.charAt(0).toUpperCase()}
            </div>
            <h2 className={styles.heroTitle}>{agentName} Comms Archive</h2>
            <p className={styles.heroSubtitle}>
              Historic records of this agent&apos;s interactions.
            </p>
          </div>

          {messages.map((msg) => {
            const isEntity = msg.sender !== "admin";
            return (
              <div
                key={msg.id}
                className={`${styles.chatMessage} ${isEntity ? styles.fromEntity : styles.fromAdmin}`}
              >
                <div className={`${styles.msgBubble} ${isEntity ? styles.bubbleEntity : styles.bubbleAdmin}`}>
                  {isEntity ? (
                    <MarkdownMessage text={msg.text} />
                  ) : (
                    msg.text.split("\n").map((line, i) => (
                      <span key={i}>
                        {line}
                        {i < msg.text.split("\n").length - 1 && <br />}
                      </span>
                    ))
                  )}
                </div>
                {isEntity && msg.attachments && msg.attachments.length > 0 && (
                  <AttachmentList primeId={primeId} attachments={msg.attachments} />
                )}
                <div className={styles.msgMeta}>
                  {msg.sender === "admin" ? "Operator" : agentName} • {msg.timestamp ? formatTime(msg.timestamp) : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
