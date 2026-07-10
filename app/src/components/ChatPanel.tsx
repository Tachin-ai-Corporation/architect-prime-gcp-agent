"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./ChatPanel.module.css";
import { MarkdownMessage } from "./MarkdownMessage";
import { AttachmentList } from "./AttachmentList";
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
  /** Agent specialty type (e.g. data, pm, devops) */
  specialty?: string;
  /** When true, renders without fixed positioning — for embedding in a tab */
  inline?: boolean;
}

export function ChatPanel({ primeId, agentName, entityName, entityStatus, specialty, inline }: ChatPanelProps) {
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

    const result = await api(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    });
    if (!result) {
      // Remove optimistic message on failure
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(msg); // Restore the message so user can retry
    }
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className={`${styles.chatPanel} ${inline ? styles.chatPanelInline : ""}`} id="chat-panel">
      
      {/* ---- Messages Area ---- */
      messages.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.hero}>
            <div className={styles.heroAvatar}>
              {agentName ? agentName.charAt(0).toUpperCase() : "P"}
            </div>
            <h2 className={styles.heroTitle}>Hi, I'm {entityName}.</h2>
            <p className={styles.heroSubtitle}>
              I'm ready to assist you. How can I help you today?
            </p>
          </div>
        </div>
      ) : (
        <div className={styles.chatMessages} ref={messagesRef}>
          <div className={styles.hero}>
            <div className={styles.heroAvatar}>
              {agentName ? agentName.charAt(0).toUpperCase() : "P"}
            </div>
            <h2 className={styles.heroTitle}>Hi, I'm {entityName}.</h2>
            <p className={styles.heroSubtitle}>
              I've been trained on our latest manuals and technical specs to give you fast, accurate answers.
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
                {msg.attachments && msg.attachments.length > 0 && (
                  <AttachmentList primeId={primeId} attachments={msg.attachments} />
                )}
                <div className={styles.msgMeta}>
                  {msg.timestamp ? formatTime(msg.timestamp) : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Input Bar ---- */}
      <div className={styles.chatInputBar}>
        <div className={styles.chatInputWrapper}>
          <textarea
            id="chat-panel-input"
            className={styles.chatInput}
            placeholder="Ask a question..."
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
            aria-label="Send message"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path>
              <path d="m21.854 2.147-10.94 10.939"></path>
            </svg>
          </button>
        </div>
        <p className={styles.inputHint}>
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
