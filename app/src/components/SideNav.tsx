"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./SideNav.module.css";

interface NavItem {
  icon: string;
  label: string;
  path: string;
}

const navItems: NavItem[] = [
  { icon: "🏠", label: "Home", path: "/" },
  { icon: "📂", label: "Projects", path: "/projects" },
  { icon: "⚡", label: "Processes", path: "/processes" },
  { icon: "📋", label: "Work", path: "/work" },
  { icon: "🧠", label: "Brain", path: "/brain" },
  { icon: "🛠️", label: "Skills", path: "/skills" },
  { icon: "👥", label: "Agent Types", path: "/agent-types" },
];

interface SideNavProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function SideNav({ collapsed, onToggle }: SideNavProps) {
  const pathname = usePathname();

  const isActive = (path: string) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ""}`}>
      <nav className={styles.nav}>
        {navItems.map((item) => (
          <Link
            key={item.path}
            href={item.path}
            className={`${styles.navItem} ${isActive(item.path) ? styles.active : ""}`}
            title={collapsed ? item.label : undefined}
          >
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.label}>{item.label}</span>
          </Link>
        ))}
      </nav>

      <div className={styles.footer}>
        <Link
          href="/settings"
          className={`${styles.navItem} ${isActive("/settings") ? styles.active : ""}`}
          title={collapsed ? "Settings" : undefined}
        >
          <span className={styles.icon}>⚙️</span>
          <span className={styles.label}>Settings</span>
        </Link>

        <button
          className={styles.toggle}
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>
    </aside>
  );
}
