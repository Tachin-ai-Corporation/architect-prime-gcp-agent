"use client";

import { useState, useCallback } from "react";
import { useIntrospect } from "@/hooks/useIntrospect";
import styles from "./SkillInventory.module.css";

/* ================================================================
   Types
   ================================================================ */

export interface SkillTool {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}

export interface Skill {
  name: string;
  description: string;
  version?: string;
  tools: SkillTool[];
  source: string; // 'installed' | 'builtin' | 'mcp'
  // MCP fields — populated when source is 'mcp'
  mcp_server?: string;
  mcp_status?: 'connected' | 'disconnected' | 'error';
  mcp_url?: string;
  connection_type?: 'local' | 'remote' | 'stdio';
}

export interface SkillData {
  skills: Skill[];
}

interface SkillInventoryProps {
  primeId: string;
  agentName: string;
}

/* ================================================================
   Component
   ================================================================ */

export function SkillInventory({ primeId, agentName }: SkillInventoryProps) {
  const { data, loading, error, refresh } = useIntrospect<SkillData>({
    primeId,
    agent: agentName,
    type: "skills",
  });

  /* ---- Loading ---- */
  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span className={styles.pulse}>Loading skills…</span>
      </div>
    );
  }

  /* ---- Error ---- */
  if (error) {
    return (
      <div className={styles.error}>
        <span className={styles.errorMsg}>⚠ {error}</span>
        <button className={styles.retryBtn} onClick={refresh}>
          Retry
        </button>
      </div>
    );
  }

  /* ---- Empty ---- */
  const skills = data?.skills ?? [];
  if (skills.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon}>📦</div>
        No skills installed
      </div>
    );
  }

  /* ---- Separate MCP servers from regular skills ---- */
  const regularSkills = skills.filter((s) => s.source !== 'mcp');
  const mcpSkills = skills.filter((s) => s.source === 'mcp');

  /* ---- Grid ---- */
  return (
    <div>
      {/* Regular skills */}
      <div className={styles.grid}>
        {regularSkills.map((skill) => (
          <SkillCard key={skill.name} skill={skill} />
        ))}
      </div>

      {/* MCP Connections */}
      {mcpSkills.length > 0 && (
        <>
          <div className={styles.mcpHeader}>
            <span className={styles.mcpIcon}>🔌</span>
            <span className={styles.mcpTitle}>MCP Servers</span>
            <span className={styles.mcpCount}>{mcpSkills.length}</span>
          </div>
          <div className={styles.grid}>
            {mcpSkills.map((skill) => (
              <SkillCard key={skill.name} skill={skill} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ================================================================
   SkillCard — individual card with expandable tool list
   ================================================================ */

function SkillCard({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div className={styles.card}>
      {/* Header */}
      <div className={styles.cardHeader}>
        <span className={styles.cardName}>{skill.name}</span>
      </div>

      {/* Description */}
      {skill.description && (
        <div className={styles.cardDesc}>{skill.description}</div>
      )}

      {/* Badges */}
      <div className={styles.badges}>
        {skill.version && (
          <span className={`${styles.badge} ${styles.badgeVersion}`}>
            v{skill.version}
          </span>
        )}
        <span className={`${styles.badge} ${styles.badgeTools}`}>
          {skill.tools.length} tool{skill.tools.length !== 1 ? "s" : ""}
        </span>
        <span
          className={`${styles.badge} ${
            skill.source === "builtin" ? styles.badgeBuiltin
            : skill.source === "mcp" ? styles.badgeMcp
            : styles.badgeInstalled
          }`}
        >
          {skill.source}
        </span>
        {/* MCP server status indicator */}
        {skill.mcp_status && (
          <span
            className={`${styles.badge} ${
              skill.mcp_status === 'connected' ? styles.badgeMcpConnected
              : skill.mcp_status === 'error' ? styles.badgeMcpError
              : styles.badgeMcpDisconnected
            }`}
          >
            {skill.mcp_status === 'connected' ? '●' : skill.mcp_status === 'error' ? '●' : '○'}
            {' '}{skill.mcp_status}
          </span>
        )}
        {skill.connection_type && (
          <span className={styles.badge}>
            {skill.connection_type}
          </span>
        )}
      </div>

      {/* Tool list toggle */}
      {skill.tools.length > 0 && (
        <>
          <button className={styles.toolToggle} onClick={toggle}>
            <span
              className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`}
            >
              ▸
            </span>
            {expanded ? "Hide tools" : "Show tools"}
          </button>

          {expanded && (
            <div className={styles.toolList}>
              {skill.tools.map((tool) => (
                <div key={tool.name} className={styles.toolRow}>
                  <span className={styles.toolName}>{tool.name}</span>
                  {tool.description && (
                    <span className={styles.toolDesc}>{tool.description}</span>
                  )}
                  {/* D6.1: Schema display */}
                  {tool.input_schema && Object.keys(tool.input_schema).length > 0 && (
                    <details className={styles.schemaDetails}>
                      <summary className={styles.schemaSummary}>Schema</summary>
                      <pre className={styles.schemaCode}>
                        {JSON.stringify(tool.input_schema, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* MCP server URL */}
      {skill.mcp_url && (
        <div className={styles.mcpUrl} title={skill.mcp_url}>
          {skill.mcp_server || skill.mcp_url}
        </div>
      )}
    </div>
  );
}
