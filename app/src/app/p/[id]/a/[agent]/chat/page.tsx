"use client";

import { useParams } from "next/navigation";
import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./page.module.css";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { api } from "@/lib/api";
import type { AgentDetail } from "@/lib/types";

export default function AgentChat() {
  const { id, agent } = useParams<{ id: string; agent: string }>();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchDetail = useCallback(async () => {
    const data = await api<AgentDetail>(`/api/primes/${id}/fleet/${agent}/logs`);
    if (data) setDetail(data);
    setLoading(false);
  }, [id, agent]);

  useEffect(() => {
    fetchDetail();
    const iv = setInterval(fetchDetail, 8000);
    return () => clearInterval(iv);
  }, [fetchDetail]);

  /* Auto-scroll on new activity */
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [detail?.activity]);

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setSending(true);
    await api<{ ok: boolean }>("/api/primes/" + id + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `@${agent} ${trimmed}` }),
    });
    setText("");
    setSending(false);
    fetchDetail();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const activity = detail?.activity
    ? [...detail.activity].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    : [];

  return (
    <div className={styles.shell} id="agent-chat">
      <div className={styles.container}>
        <header className={styles.header}>
          <h1 className={styles.title}>💬 Chat — {agent}</h1>
          <span className={styles.badge}>Direct Message</span>
        </header>

        <div className={styles.timeline} ref={scrollRef} id="agent-chat-timeline">
          {loading && <div className={styles.loading}>Loading…</div>}

          {!loading && activity.length === 0 && (
            <div className={styles.empty} id="agent-chat-empty">
              <div className={styles.emptyIcon}>💬</div>
              <div className={styles.emptyTitle}>Direct conversation with {agent}</div>
              <div className={styles.emptyDesc}>
                Send a message below to start a conversation.
              </div>
            </div>
          )}

          {activity.map((item) => (
            <div
              key={item.id}
              className={`${styles.message} ${item.sender === "admin" ? styles.msgAdmin : styles.msgAgent}`}
              id={`chat-msg-${item.id}`}
            >
              <div className={styles.msgMeta}>
                <span className={styles.msgSender}>{item.sender || agent}</span>
                <span className={styles.msgTime}>
                  {new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <div className={styles.msgBody}>
                <MarkdownMessage text={item.summary} />
              </div>
            </div>
          ))}
        </div>

        <div className={styles.inputBar} id="agent-chat-input">
          <textarea
            className={styles.inputField}
            placeholder={`Message @${agent}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            id="agent-chat-textarea"
          />
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!text.trim() || sending}
            id="agent-chat-send"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
