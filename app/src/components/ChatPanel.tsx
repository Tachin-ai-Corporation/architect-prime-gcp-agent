"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./ChatPanel.module.css";
import { MarkdownMessage } from "./MarkdownMessage";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

interface ChatPanelProps {
  primeId: string;
  /** If set, chat with this fleet agent. If null, chat with the Prime. */
  agentName?: string | null;
  /** Display name for the header */
  entityName: string;
  /** Entity status */
  entityStatus?: string;
}

export function ChatPanel({ primeId, agentName, entityName, entityStatus }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isInitialLoad = useRef(true);

  const apiBase = agentName
    ? `/api/primes/${primeId}/fleet/${agentName}/messages`
    : `/api/primes/${primeId}/messages`;

  const senderLabel = agentName || "Prime";

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /* ---- Load messages ---- */
  const loadMessages = useCallback(async () => {
    const data = await api<{ messages: ChatMessage[] }>(apiBase);
    if (data?.messages) setMessages(data.messages);
  }, [apiBase]);

  useEffect(() => {
    setMessages([]);
    isInitialLoad.current = true;
    loadMessages();
  }, [loadMessages]);

  /* ---- Poll every 3s ---- */
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages]);

  /* ---- Auto-scroll: snap to bottom instantly on load, smooth only for new messages ---- */
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    if (isInitialLoad.current) {
      // First load: snap to bottom instantly (no animation)
      el.scrollTop = el.scrollHeight;
      if (messages.length > 0) isInitialLoad.current = false;
    } else {
      // Subsequent messages: only auto-scroll if already near bottom
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  /* ---- Send ---- */
  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);

    // Optimistic update
    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, sender: "admin", text: msg, timestamp: new Date().toISOString() },
    ]);

    await api(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    });
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const statusClass = entityStatus === "online" ? styles.statusOnline
    : entityStatus === "deploying" ? styles.statusDeploying
    : entityStatus === "error" ? styles.statusError
    : styles.statusOffline;

  return (
    <div className={styles.chatPanel} id="chat-panel">
      {/* ---- Header ---- */}
      <div className={styles.chatHeader}>
        <div className={styles.chatHeaderAvatar}>
          {agentName ? agentName.charAt(0).toUpperCase() : "P"}
        </div>
        <div className={styles.chatHeaderInfo}>
          <span className={styles.chatHeaderName}>{entityName}</span>
          {entityStatus && (
            <span className={styles.chatHeaderStatus}>
              <span className={`${styles.statusDot} ${statusClass}`} />
              {entityStatus}
            </span>
          )}
        </div>
        {agentName && (
          <span className={styles.chatHeaderBadge}>Fleet Agent</span>
        )}
      </div>

      {/* ---- Messages ---- */}
      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>💬</div>
          <div className={styles.emptyTitle}>Start a conversation</div>
          <div className={styles.emptySub}>
            Send a message to {entityName}
          </div>
        </div>
      ) : (
        <div className={styles.chatMessages} ref={messagesRef}>
          {messages.map((msg) => {
            const isEntity = msg.sender !== "admin";
            return (
              <div
                key={msg.id}
                className={`${styles.chatMessage} ${isEntity ? styles.fromEntity : styles.fromAdmin}`}
              >
                <div className={`${styles.msgAvatar} ${isEntity ? styles.avatarEntity : styles.avatarYou}`}>
                  {isEntity ? senderLabel.charAt(0).toUpperCase() : "Y"}
                </div>
                <div>
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
                  <div className={styles.msgMeta}>
                    {msg.timestamp ? formatTime(msg.timestamp) : ""}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Input ---- */}
      <div className={styles.chatInputBar}>
        <div className={styles.chatInputRow}>
          <textarea
            id="chat-panel-input"
            className={styles.chatInput}
            placeholder={`Message ${entityName}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <button
            id="chat-panel-send"
            className={styles.chatSendBtn}
            onClick={() => handleSend()}
            disabled={!input.trim() || sending}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}
