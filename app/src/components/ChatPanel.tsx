"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import styles from "./ChatPanel.module.css";
import { MarkdownMessage } from "./MarkdownMessage";
import { AttachmentList } from "./AttachmentList";
import { MissionPresence } from "./MissionPresence";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/lib/types";

interface ChatPanelProps {
  primeId: string;
  /** Display name for the header */
  entityName: string;
  /** Entity status */
  entityStatus?: string;
  /** Agent specialty type (e.g. data, pm, devops) */
  specialty?: string;
  /** When true, renders without fixed positioning — for embedding in a tab */
  inline?: boolean;
}

export function ChatPanel({ primeId, entityName, inline }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  // True from the moment a message is sent until the agent's reply arrives — drives
  // the "thinking" indicator and a faster poll so the reply feels immediate.
  const [awaitingReply, setAwaitingReply] = useState(false);
  // The reply currently being revealed character-by-character (streaming feel over
  // an async transport). Rendered as plain text while streaming, then as markdown.
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [streamChars, setStreamChars] = useState(0);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const messagesRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isInitialLoad = useRef(true);
  // Entity message ids that should render fully (history + finished streams).
  const revealedIds = useRef<Set<string>>(new Set());

  const apiBase = `/api/primes/${primeId}/messages`;

  const formatTime = (ts: string) =>
    new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  /* ---- Load messages ---- */
  const loadMessages = useCallback(async () => {
    const data = await api<{ messages: ChatMessage[] }>(apiBase);
    if (data?.messages) setMessages(data.messages);
  }, [apiBase]);

  /* ---- Reset + initial load when the target changes ---- */
  useEffect(() => {
    void (async () => {
      setMessages([]);
      setStreamingId(null);
      setAwaitingReply(false);
      isInitialLoad.current = true;
      revealedIds.current = new Set();
      await loadMessages();
    })();
  }, [loadMessages]);

  /* ---- Poll: fast while awaiting a reply, relaxed otherwise ---- */
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(loadMessages, awaitingReply ? 1200 : 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [loadMessages, awaitingReply]);

  /* ---- Detect new replies + initial-history handling + autoscroll ---- */
  useEffect(() => {
    const el = messagesRef.current;

    if (isInitialLoad.current) {
      if (messages.length > 0) {
        // History: render everything fully, no typewriter, snap to bottom.
        for (const m of messages) if (m.sender !== "admin") revealedIds.current.add(m.id);
        isInitialLoad.current = false;
        if (el) el.scrollTop = el.scrollHeight;
      }
      return;
    }

    // A genuinely new entity message → stream the latest one in; older new ones pop in.
    const fresh = messages.filter(
      (m) => m.sender !== "admin" && !revealedIds.current.has(m.id) && m.id !== streamingId
    );
    if (fresh.length > 0) {
      for (let i = 0; i < fresh.length - 1; i++) revealedIds.current.add(fresh[i].id);
      const last = fresh[fresh.length - 1];
      setStreamingId(last.id);
      setStreamingText(last.text);
      setStreamChars(0);
      setAwaitingReply(false);
    }

    if (el) {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
  }, [messages, streamingId]);

  /* ---- Typewriter reveal for the streaming reply ---- */
  useEffect(() => {
    if (!streamingId) return;
    const full = streamingText.length;
    const step = Math.max(2, Math.ceil(full / 50)); // ~1.2s regardless of length
    const iv = setInterval(() => {
      setStreamChars((c) => {
        const next = c + step;
        if (next >= full) {
          clearInterval(iv);
          revealedIds.current.add(streamingId);
          // Defer clearing so we don't set state mid-updater.
          setTimeout(() => setStreamingId(null), 0);
          return full;
        }
        return next;
      });
      const el = messagesRef.current;
      if (el) {
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        if (nearBottom) el.scrollTop = el.scrollHeight;
      }
    }, 24);
    return () => clearInterval(iv);
  }, [streamingId, streamingText]);

  /* ---- Track scroll position for the scroll-to-bottom pill ---- */
  const handleScroll = () => {
    const el = messagesRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setShowScrollBtn(!nearBottom);
  };

  const scrollToBottom = () => {
    const el = messagesRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  /* ---- Auto-grow the composer ---- */
  const adjustHeight = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  };

  /* ---- Send ---- */
  const handleSend = async (text?: string) => {
    const msg = (text || input).trim();
    if (!msg || sending) return;
    setInput("");
    setSending(true);
    setAwaitingReply(true);
    // Reset the composer height after clearing.
    requestAnimationFrame(adjustHeight);

    const tempId = `temp-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempId, sender: "admin", text: msg, timestamp: new Date().toISOString() },
    ]);
    // Keep the user's message pinned to view.
    requestAnimationFrame(() => {
      const el = messagesRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });

    const result = await api(apiBase, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg }),
    });
    if (!result) {
      setMessages((prev) => prev.filter((m) => m.id !== tempId));
      setInput(msg);
      setAwaitingReply(false);
    }
    setSending(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const heroBlock = (
    <div className={styles.hero}>
      <div className={styles.heroAvatar}>
        {entityName?.trim()?.[0]?.toUpperCase() || "•"}
      </div>
      <h2 className={styles.heroTitle}>Hi, I&apos;m {entityName}.</h2>
    </div>
  );

  return (
    <div className={`${styles.chatPanel} ${inline ? styles.chatPanelInline : ""}`} id="chat-panel">

      {messages.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.hero}>
            <div className={styles.heroAvatar}>
              {entityName?.trim()?.[0]?.toUpperCase() || "•"}
            </div>
            <h2 className={styles.heroTitle}>Hi, I&apos;m {entityName}.</h2>
            <p className={styles.heroSubtitle}>
              Send a message to start the conversation.
            </p>
          </div>
        </div>
      ) : (
        <div className={styles.chatMessages} ref={messagesRef} onScroll={handleScroll}>
          {heroBlock}

          {messages.map((msg) => {
            const isEntity = msg.sender !== "admin";
            const isStreaming = msg.id === streamingId;
            return (
              <div
                key={msg.id}
                className={`${styles.chatMessage} ${isEntity ? styles.fromEntity : styles.fromAdmin}`}
              >
                <div className={`${styles.msgBubble} ${isEntity ? styles.bubbleEntity : styles.bubbleAdmin}`}>
                  {isEntity ? (
                    isStreaming ? (
                      <span className={styles.streamText}>
                        {streamingText.slice(0, streamChars)}
                        <span className={styles.streamCursor} />
                      </span>
                    ) : (
                      <MarkdownMessage text={msg.text} />
                    )
                  ) : (
                    msg.text.split("\n").map((line, i) => (
                      <span key={i}>
                        {line}
                        {i < msg.text.split("\n").length - 1 && <br />}
                      </span>
                    ))
                  )}
                </div>
                {isEntity && !isStreaming && msg.attachments && msg.attachments.length > 0 && (
                  <AttachmentList primeId={primeId} attachments={msg.attachments} />
                )}
                <div className={styles.msgMeta}>
                  {msg.timestamp ? formatTime(msg.timestamp) : ""}
                </div>
              </div>
            );
          })}

          {/* Agent is composing a reply */}
          {awaitingReply && !streamingId && (
            <div className={styles.thinkingRow}>
              <div className={styles.thinkingBubble}>
                <span className={styles.thinkingDots}>
                  <span /><span /><span />
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Scroll-to-bottom pill */}
      {showScrollBtn && messages.length > 0 && (
        <button className={styles.scrollBtn} onClick={scrollToBottom} aria-label="Scroll to latest">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M19 12l-7 7-7-7" />
          </svg>
        </button>
      )}

      {/* ---- Input Bar ---- */}
      <MissionPresence primeId={primeId} />
      <div className={styles.chatInputBar}>
        <div className={styles.chatInputWrapper}>
          <textarea
            id="chat-panel-input"
            ref={textareaRef}
            className={styles.chatInput}
            placeholder="Ask a question..."
            value={input}
            onChange={(e) => { setInput(e.target.value); adjustHeight(); }}
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
