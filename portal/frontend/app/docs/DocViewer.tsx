"use client";

import React from "react";
import Link from "next/link";
import { useTheme } from "../../contexts/ThemeContext";

// ─── Inline markdown renderer ────────────────────────────────────────────────

// Resolve a markdown link href to a portal URL.
// - External links (http/https) pass through unchanged.
// - Anchor-only links (#) pass through unchanged.
// - Internal .md links: strip extension, resolve relative to basePath (e.g. /docs/architecture).
function resolveHref(href: string, basePath: string): string {
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) {
    return href;
  }
  // Separate anchor from path
  const anchorIdx = href.indexOf("#");
  const anchor = anchorIdx >= 0 ? href.slice(anchorIdx) : "";
  let path = anchorIdx >= 0 ? href.slice(0, anchorIdx) : href;

  // Strip .md extension
  path = path.replace(/\.md$/, "");

  if (path.startsWith("/")) {
    return path + anchor;
  }

  // Resolve relative path against basePath
  const baseParts = basePath.replace(/^\//, "").split("/").filter(Boolean);
  const pathParts = path.split("/");
  const resolved = [...baseParts];

  for (const part of pathParts) {
    if (part === "..") resolved.pop();
    else if (part !== "." && part !== "") resolved.push(part);
  }

  return "/" + resolved.join("/") + anchor;
}

function renderInline(text: string, basePath = ""): { __html: string } {
  const html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
      const resolved = resolveHref(href, basePath);
      return `<a href="${resolved}" style="color:inherit;text-decoration:underline">${label}</a>`;
    });
  return { __html: html };
}

// ─── Block types ─────────────────────────────────────────────────────────────

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "blockquote"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "hr" }
  | { type: "paragraph"; text: string }
  | { type: "blank" };

// ─── Block parser ─────────────────────────────────────────────────────────────

function parseBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      blocks.push({
        type: "heading",
        level: Math.min(hMatch[1].length, 6) as 1 | 2 | 3 | 4 | 5 | 6,
        text: hMatch[2].trim(),
      });
      i++;
      continue;
    }

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Horizontal rule
    if (line.match(/^[-*_]{3,}$/) && line.trim().length >= 3) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", lines: quoteLines });
      continue;
    }

    // Unordered list
    if (line.match(/^[-*+]\s/)) {
      const items: string[] = [];
      while (i < lines.length && (lines[i].match(/^[-*+]\s/) || lines[i].match(/^\s{2,}/))) {
        if (lines[i].match(/^[-*+]\s/)) {
          items.push(lines[i].slice(2));
        } else {
          // continuation — append to last item
          if (items.length > 0) {
            items[items.length - 1] += " " + lines[i].trim();
          }
        }
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    // Table
    if (line.startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const parseRow = (row: string) =>
          row.split("|").slice(1, -1).map((c) => c.trim());
        const headers = parseRow(tableLines[0]);
        // Skip separator row (index 1 — the --- row)
        const rows = tableLines.slice(2).map(parseRow);
        blocks.push({ type: "table", headers, rows });
      }
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // Paragraph — collect until blank / next block-level element
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("|") &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].match(/^[-*_]{3,}$/) &&
      !lines[i].startsWith(">")
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", text: paraLines.join(" ") });
    }
  }

  return blocks;
}

// ─── Block renderer ───────────────────────────────────────────────────────────

function renderBlock(block: Block, idx: number, primaryColor: string, basePath = ""): React.ReactNode {
  switch (block.type) {
    case "heading": {
      const sizes: Record<number, string> = {
        1: "1.9rem",
        2: "1.45rem",
        3: "1.2rem",
        4: "1.05rem",
        5: "0.95rem",
        6: "0.9rem",
      };
      const weights: Record<number, number> = { 1: 800, 2: 800, 3: 700, 4: 700, 5: 600, 6: 600 };
      const id = block.text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      const margins: Record<number, string> = {
        1: "2rem 0 1rem",
        2: "2rem 0 0.75rem",
        3: "1.5rem 0 0.5rem",
        4: "1.25rem 0 0.4rem",
        5: "1rem 0 0.35rem",
        6: "1rem 0 0.3rem",
      };
      return (
        <div key={idx}>
          {block.level === 2 && (
            <div
              style={{
                height: 2,
                background: `${primaryColor}18`,
                borderRadius: 1,
                marginTop: "2.5rem",
                marginBottom: "0.25rem",
              }}
            />
          )}
          <div
            id={id}
            style={{
              scrollMarginTop: "80px",
              fontSize: sizes[block.level],
              fontWeight: weights[block.level],
              color: block.level === 1 ? primaryColor : "#0f172a",
              margin: margins[block.level],
              lineHeight: 1.3,
              letterSpacing: block.level <= 2 ? "-0.02em" : undefined,
            }}
            dangerouslySetInnerHTML={renderInline(block.text, basePath)}
          />
        </div>
      );
    }

    case "code":
      return (
        <pre
          key={idx}
          style={{
            background: "#0f172a",
            borderRadius: 8,
            padding: "1rem 1.25rem",
            overflowX: "auto",
            margin: "1rem 0",
            fontSize: 13,
            lineHeight: 1.65,
            position: "relative",
          }}
        >
          {block.lang && (
            <span
              style={{
                position: "absolute",
                top: 8,
                right: 12,
                fontSize: 11,
                color: "#64748b",
                fontFamily: "system-ui, sans-serif",
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
              }}
            >
              {block.lang}
            </span>
          )}
          <code
            style={{
              color: "#86efac",
              fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
              whiteSpace: "pre",
            }}
          >
            {block.code}
          </code>
        </pre>
      );

    case "blockquote":
      return (
        <div
          key={idx}
          style={{
            borderLeft: `3px solid ${primaryColor}`,
            paddingLeft: "1rem",
            margin: "1rem 0",
            background: `${primaryColor}08`,
            borderRadius: "0 6px 6px 0",
            padding: "0.75rem 1rem",
          }}
        >
          {block.lines.map((line, j) => (
            <div
              key={j}
              style={{ color: "#475569", fontStyle: "italic", lineHeight: 1.7, fontSize: 14.5 }}
              dangerouslySetInnerHTML={renderInline(line, basePath)}
            />
          ))}
        </div>
      );

    case "ul":
      return (
        <ul
          key={idx}
          style={{
            margin: "0.75rem 0",
            paddingLeft: "1.5rem",
            lineHeight: 1.85,
            color: "#334155",
            fontSize: 14.5,
          }}
        >
          {block.items.map((item, j) => (
            <li key={j} dangerouslySetInnerHTML={renderInline(item, basePath)} />
          ))}
        </ul>
      );

    case "ol":
      return (
        <ol
          key={idx}
          style={{
            margin: "0.75rem 0",
            paddingLeft: "1.5rem",
            lineHeight: 1.85,
            color: "#334155",
            fontSize: 14.5,
          }}
        >
          {block.items.map((item, j) => (
            <li key={j} dangerouslySetInnerHTML={renderInline(item, basePath)} />
          ))}
        </ol>
      );

    case "table":
      return (
        <div key={idx} style={{ overflowX: "auto", margin: "1rem 0" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 13.5,
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            <thead>
              <tr style={{ background: `${primaryColor}12`, borderBottom: `2px solid ${primaryColor}30` }}>
                {block.headers.map((h, j) => (
                  <th
                    key={j}
                    style={{
                      padding: "10px 14px",
                      textAlign: "left",
                      fontWeight: 700,
                      color: "#0f172a",
                      whiteSpace: "nowrap",
                    }}
                    dangerouslySetInnerHTML={renderInline(h, basePath)}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr
                  key={j}
                  style={{
                    borderBottom: "1px solid #f1f5f9",
                    background: j % 2 === 0 ? "#fff" : "#f8fafc",
                  }}
                >
                  {row.map((cell, k) => (
                    <td
                      key={k}
                      style={{ padding: "9px 14px", color: "#334155", lineHeight: 1.6 }}
                      dangerouslySetInnerHTML={renderInline(cell, basePath)}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "hr":
      return (
        <hr
          key={idx}
          style={{ border: "none", borderTop: "1px solid #e2e8f0", margin: "2rem 0" }}
        />
      );

    case "paragraph":
      return (
        <p
          key={idx}
          style={{ margin: "0.6rem 0", lineHeight: 1.85, color: "#334155", fontSize: 14.5 }}
          dangerouslySetInnerHTML={renderInline(block.text, basePath)}
        />
      );

    case "blank":
    default:
      return null;
  }
}

// ─── Extract TOC headings ─────────────────────────────────────────────────────

function extractToc(blocks: Block[]): { level: number; text: string; id: string }[] {
  return blocks
    .filter((b): b is Extract<Block, { type: "heading" }> => b.type === "heading" && b.level <= 3)
    .map((b) => ({
      level: b.level,
      text: b.text,
      id: b.text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
    }));
}

// ─── Main component ───────────────────────────────────────────────────────────

interface DocViewerProps {
  content: string;
  slug: string[];
}

export default function DocViewer({ content, slug }: DocViewerProps) {
  const { primaryColor } = useTheme();
  const blocks = React.useMemo(() => parseBlocks(content), [content]);
  const toc = React.useMemo(() => extractToc(blocks), [blocks]);

  // Base path for resolving relative .md links within this doc
  // e.g. slug=["architecture","01-overview"] → "/docs/architecture"
  const basePath = "/docs/" + slug.slice(0, -1).join("/");

  // Breadcrumb
  const crumbs = slug.map((part, i) => ({
    label: part
      .replace(/^\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    href: i < slug.length - 1 ? `/docs/${slug.slice(0, i + 1).join("/")}` : null,
  }));

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc" }}>
      {/* Top bar */}
      <div
        style={{
          background: "#fff",
          borderBottom: "1px solid #e2e8f0",
          padding: "14px 0",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            padding: "0 1.5rem",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <Link
            href="/docs"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: primaryColor,
              textDecoration: "none",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            <i className="fas fa-book" style={{ fontSize: 11 }} aria-hidden="true" />
            Docs
          </Link>
          {crumbs.map((crumb, i) => (
            <React.Fragment key={i}>
              <i
                className="fas fa-chevron-right"
                style={{ fontSize: 10, color: "#94a3b8" }}
                aria-hidden="true"
              />
              {crumb.href ? (
                <Link
                  href={crumb.href}
                  style={{ color: primaryColor, textDecoration: "none", fontSize: 13, fontWeight: 600 }}
                >
                  {crumb.label}
                </Link>
              ) : (
                <span style={{ color: "#64748b", fontSize: 13 }}>{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: "40px 1.5rem 80px",
          display: "flex",
          gap: 40,
          alignItems: "flex-start",
        }}
      >
        {/* Main content */}
        <main
          style={{
            flex: 1,
            minWidth: 0,
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: "2rem 2.5rem",
          }}
        >
          <style>{`
            main code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: 'Cascadia Code','Fira Code',Consolas,monospace; font-size: 0.85em; color: #0f172a; }
            main pre code { background: transparent; padding: 0; color: #86efac; }
            main strong { color: #0f172a; }
            main a { color: ${primaryColor}; }
          `}</style>
          {blocks.map((block, idx) => renderBlock(block, idx, primaryColor, basePath))}
        </main>

        {/* TOC sidebar */}
        {toc.length > 2 && (
          <aside
            style={{
              width: 220,
              flexShrink: 0,
              position: "sticky",
              top: 70,
              maxHeight: "calc(100vh - 100px)",
              overflowY: "auto",
            }}
          >
            <div
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: "1rem",
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "#94a3b8",
                  marginBottom: 12,
                }}
              >
                On this page
              </div>
              {toc.map((item, i) => (
                <a
                  key={i}
                  href={`#${item.id}`}
                  style={{
                    display: "block",
                    padding: "4px 0 4px",
                    paddingLeft: item.level === 1 ? 0 : item.level === 2 ? 0 : 12,
                    fontSize: item.level === 1 ? 13 : 12.5,
                    fontWeight: item.level <= 2 ? 600 : 400,
                    color: "#64748b",
                    textDecoration: "none",
                    lineHeight: 1.5,
                    borderLeft: item.level === 3 ? `2px solid #e2e8f0` : "none",
                    transition: "color 0.1s",
                  }}
                  onMouseEnter={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = primaryColor)
                  }
                  onMouseLeave={(e) =>
                    ((e.currentTarget as HTMLAnchorElement).style.color = "#64748b")
                  }
                >
                  {item.text}
                </a>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
