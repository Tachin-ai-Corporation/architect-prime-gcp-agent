"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownMessageProps {
  text: string;
}

/**
 * Renders agent message text as formatted markdown.
 * Uses react-markdown + remark-gfm for GFM support (tables, strikethrough, etc).
 *
 * Custom renderers scale headings down for chat context and
 * open links in new tabs.
 */
export function MarkdownMessage({ text }: MarkdownMessageProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Scale headings down for chat bubble context
        h1: ({ children }) => <h3 className="md-heading">{children}</h3>,
        h2: ({ children }) => <h4 className="md-heading">{children}</h4>,
        h3: ({ children }) => <h4 className="md-heading">{children}</h4>,
        // Open links in new tab
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">
            {children}
          </a>
        ),
        // Code blocks with language badge
        pre: ({ children }) => <pre className="md-code-block">{children}</pre>,
        code: ({ className, children, ...props }) => {
          // Detect inline vs block: block code is wrapped in <pre>
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return <code className={`md-code ${className || ""}`} {...props}>{children}</code>;
          }
          return <code className="md-inline-code" {...props}>{children}</code>;
        },
        // Lists
        ul: ({ children }) => <ul className="md-list">{children}</ul>,
        ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
        // Blockquotes
        blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
        // Tables
        table: ({ children }) => (
          <div className="md-table-wrap">
            <table className="md-table">{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
