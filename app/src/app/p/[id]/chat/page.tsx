"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import styles from "./page.module.css";
import { usePrime } from "@/contexts/PrimeContext";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

const SUGGESTIONS = [
  "What can you do?",
  "Show fleet status",
  "Hire a devops agent named stan",
  "What missions are active?",
];

export default function PrimeChat() {
  const { id } = useParams<{ id: string }>();
  const { primes } = usePrime();
  const prime = primes.find((p) => p.id === id);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /* ---- Load messages ---- */
  const loadMessages = useCallback(async () => {
    if (!id) return;
    const data = await api<{ messages: ChatMessage[] }>(`/api/primes/${id}/messages`);
    if (data?.messages) setMessages(data.messages);
  }, [id]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  /* ---- Poll every 3s ---- */
  useEffect(() => {
    if (!id) return;
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [id, loadMessages]);

  /* ---- Auto-scroll ---- */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* ---- Send message ---- */
  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || !id) return;
    setInput("");

    // Optimistic update
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, sender: "admin", text: msg, timestamp: new Date().toISOString() },
    ]);

    await api(`/api/primes/${id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={styles.chatShell} id="prime-chat">
      {/* ---- Header ---- */}
      <header className={styles.chatHeader}>
        <div className={styles.chatHeaderLogo}>P</div>
        <h1 className={styles.chatHeaderTitle}>
          {prime?.name || "Prime"}
        </h1>
        {prime && (
          <span
            className={`${styles.chatHeaderStatus} badge-${prime.status}`}
            id="chat-status-badge"
          >
            {prime.status}
          </span>
        )}
        <Link href={`/p/${id}`} className={styles.chatHeaderBack} id="chat-back-btn">
          ← Hub
        </Link>
      </header>

      {/* ---- Messages ---- */}
      {messages.length === 0 ? (
        <div className={styles.emptyState} id="chat-empty-state">
          <div className={styles.emptyStateIcon}>💬</div>
          <div className={styles.emptyStateTitle}>Start a conversation</div>
          <div className={styles.emptyStateDesc}>
            Send a message to Prime. Try one of these to get started:
          </div>
          <div className={styles.suggestions}>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                className={styles.suggestionChip}
                onClick={() => handleSend(s)}
                id={`suggestion-${s.replace(/\s+/g, "-").toLowerCase()}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className={styles.chatArea} id="chat-messages">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`${styles.chatMessage} ${
                msg.sender === "prime" ? styles.fromPrime : styles.fromAdmin
              }`}
            >
              <div
                className={`${styles.chatAvatar} ${
                  msg.sender === "prime" ? styles.avatarPrime : styles.avatarYou
                }`}
              >
                {msg.sender === "prime" ? "P" : "Y"}
              </div>
              <div>
                <div
                  className={`${styles.chatBubble} ${
                    msg.sender === "prime" ? styles.bubblePrime : styles.bubbleAdmin
                  }`}
                >
                  {msg.sender === "prime" ? (
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
                <div className={styles.chatMeta}>
                  {msg.timestamp ? formatTime(msg.timestamp) : ""}
                </div>
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>
      )}

      {/* ---- Input Bar ---- */}
      <div className={styles.chatInputBar}>
        <div className={styles.chatInputRow}>
          <textarea
            id="chat-input"
            className={styles.chatInput}
            placeholder={`Message ${prime?.name || "Prime"}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            id="chat-send-btn"
            className={styles.chatSendBtn}
            onClick={() => handleSend()}
            disabled={!input.trim()}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
