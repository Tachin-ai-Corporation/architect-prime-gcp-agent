import { NextResponse } from "next/server";

/* ---- Skill Kit type ---- */
interface SkillKit {
  id: string;
  name: string;
  description: string;
  type: "base" | "role" | "job";
  tools: number;
}

/**
 * GET /api/skills — Returns the list of available skill kits.
 * Currently returns a hardcoded registry of known CoreKit packages.
 */
const SKILL_KITS: SkillKit[] = [
  {
    id: "base",
    name: "Core Runtime",
    description:
      "Foundation scripts for brain agent operations — envelope management, memory, tool execution, file I/O, and system utilities.",
    type: "base",
    tools: 59,
  },
  {
    id: "role-fleet",
    name: "Fleet Overlay",
    description:
      "Fleet agent role layer — DWD authentication, Google Chat integration, fleet identity management, and workspace email handling.",
    type: "role",
    tools: 12,
  },
  {
    id: "role-prime",
    name: "Prime Overlay",
    description:
      "Prime agent role layer — fleet management, agent orchestration, command dispatch, and multi-agent coordination.",
    type: "role",
    tools: 15,
  },
  {
    id: "job-devops",
    name: "DevOps",
    description:
      "Infrastructure and operations — Terraform, Cloud Build, GKE management, monitoring, alerting, and reliability engineering.",
    type: "job",
    tools: 18,
  },
  {
    id: "job-engineer",
    name: "Engineering",
    description:
      "Software development — code analysis, debugging, testing, refactoring, architecture review, and CI/CD pipeline management.",
    type: "job",
    tools: 22,
  },
  {
    id: "job-pm",
    name: "Project Management",
    description:
      "Planning and coordination — project tracking, task decomposition, milestone management, stakeholder communication, and reporting.",
    type: "job",
    tools: 14,
  },
  {
    id: "job-qa",
    name: "Quality Assurance",
    description:
      "Test design and verification — test case generation, automated testing, regression analysis, coverage reporting, and bug triage.",
    type: "job",
    tools: 16,
  },
  {
    id: "job-security",
    name: "Security",
    description:
      "Security operations — IAM audit, compliance checks, vulnerability scanning, access review, and infrastructure hardening.",
    type: "job",
    tools: 13,
  },
  {
    id: "job-finance",
    name: "Finance",
    description:
      "Financial operations — cost analysis, budget tracking, billing reports, forecasting, and cloud spend optimization.",
    type: "job",
    tools: 10,
  },
  {
    id: "job-assistant",
    name: "Assistant",
    description:
      "General purpose — research, scheduling, communications, document management, and administrative task automation.",
    type: "job",
    tools: 11,
  },
  {
    id: "job-data",
    name: "Data",
    description:
      "Data operations — ETL pipelines, BigQuery analytics, data visualization, dashboard creation, and data quality monitoring.",
    type: "job",
    tools: 15,
  },
];

export async function GET() {
  return NextResponse.json({ kits: SKILL_KITS });
}
