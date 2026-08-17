#!/usr/bin/env bun
// Static site generator for the agent-yes lab (lab.agent-yes.com).
//
// Sources live next to this file:
//   index.md            — the manifesto; `<!--posts-->` is replaced by the post list
//   posts/YYYY-MM-DD-<slug>.md    — a post authored in the markdown subset below
//   posts/YYYY-MM-DD-<slug>.html  — a post authored as a raw HTML body fragment
//                                   (used when a post embeds a live demo widget
//                                   that a markdown round-trip would destroy)
//
// Output is FLAT — `<date>-<slug>.html`, never `<date>-<slug>/index.html` — so the
// canonical URL is `lab.agent-yes.com/2026-01-31-some-post` with no trailing
// slash. worker.ts maps the lab host onto this directory (see its LAB_HOST branch).
//
// Every page is self-contained: the stylesheet is inlined rather than linked, so a
// page renders identically at `lab.agent-yes.com/<slug>` (prod, via the Worker)
// and at `beta.agent-yes.pages.dev/lab/<slug>` (beta Pages, which has no Worker to
// rewrite paths). For the same reason links BETWEEN lab pages are relative
// (`./<slug>`) and links to the main site are absolute (`https://agent-yes.com/…`).
//
// Usage: bun lab/ui/lab/build.ts <outDir>          (called from lab/ui/cf/build-assets.sh)

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = "https://lab.agent-yes.com";
const MAIN = "https://agent-yes.com";

type Post = {
  date: string;
  slug: string;
  /** Canonical path segment: `<date>-<slug>` — also the output filename stem. */
  name: string;
  title: string;
  tag: string;
  summary: string;
  /** Rendered HTML body (without the <article> wrapper). */
  body: string;
};

// ---------------------------------------------------------------- front matter

/** Split a `---`-fenced key/value header off the top of a source file. */
function frontMatter(src: string): { meta: Record<string, string>; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, rest: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  return { meta, rest: src.slice(m[0].length) };
}

// ------------------------------------------------------------------- markdown
// A deliberately small subset — headings, paragraphs, lists, fenced code,
// blockquotes, tables, rules, and raw-HTML blocks. Enough for long-form writing,
// small enough to read in one sitting. Anything richer belongs in a .html source.

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Inline spans, applied to ALREADY-ESCAPED text. Code spans are lifted out
 * first and re-inserted last so `**` / `[]()` inside them stay literal.
 */
function inline(escaped: string): string {
  const code: string[] = [];
  // NUL-delimited placeholders: NUL can never appear in the source text, so a
  // code span containing digits is never confused with surrounding prose.
  let s = escaped.replace(/`([^`]+)`/g, (_, c: string) => `\u0000${code.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // NUL is the point: the one delimiter that cannot collide with post text.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${code[Number(i)]}</code>`);
}

function markdown(src: string): string {
  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  const cells = (row: string) =>
    row
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code — content is never inline-parsed.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) buf.push(lines[i++]!);
      i++; // closing fence
      const cls = fence[1] ? ` class="lang-${fence[1]}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Raw HTML block: a line starting at column 0 with a tag, up to a blank line.
    if (/^<[a-zA-Z/!]/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.trim()) buf.push(lines[i++]!);
      out.push(buf.join("\n"));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      i++;
      continue;
    }

    if (/^(---|\*\*\*)\s*$/.test(line)) {
      out.push("<hr />");
      i++;
      continue;
    }

    // Table: a pipe row followed by a |---|---| separator.
    if (line.startsWith("|") && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith("|")) body.push(cells(lines[i++]!));
      const th = head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join("");
      const tr = body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("")}</tr>`)
        .join("");
      out.push(
        `<div class="tw"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`,
      );
      continue;
    }

    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) buf.push(lines[i++]!.slice(2));
      out.push(`<blockquote>${inline(escapeHtml(buf.join(" ")))}</blockquote>`);
      continue;
    }

    // Lists. A continuation line (indented, no marker) joins the previous item.
    const bullet = /^\s*([-*]|\d+\.)\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d+\.\s/.test(line);
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim()) {
        const cur = lines[i]!;
        if (bullet.test(cur)) items.push(cur.replace(bullet, ""));
        // A non-bullet line is a lazy continuation of the previous item — UNLESS
        // it opens another block. Without this stop-set a fenced code block or
        // heading written straight after a list (no blank line) is swallowed into
        // the last <li> and then mangled by the inline pass. Same set as the
        // paragraph loop below.
        else if (/^(```|#{1,4}\s|\||>\s|<[a-zA-Z/!])/.test(cur)) break;
        else if (items.length) items[items.length - 1] += ` ${cur.trim()}`;
        else break;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      const li = items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join("");
      out.push(`<${tag}>${li}</${tag}>`);
      continue;
    }

    // Paragraph: consume until a blank line or a block that starts something else.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|```|>\s|<[a-zA-Z/!]|\|)/.test(lines[i]!) &&
      !bullet.test(lines[i]!)
    ) {
      buf.push(lines[i++]!);
    }
    out.push(`<p>${inline(escapeHtml(buf.join(" ")))}</p>`);
  }

  return out.join("\n");
}

// ------------------------------------------------------------------- template

const CSS = `
:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--accent:#58a6ff;--green:#3fb950;
--card:#161b22;--border:#30363d;--code:#1f2530;--mark:#d29922;--red:#f85149}
@media (prefers-color-scheme:light){:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;
--accent:#0969da;--green:#1a7f37;--card:#f6f8fa;--border:#d0d7de;--code:#eff2f5;--mark:#9a6700;
--red:#cf222e}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);padding:0 20px;-webkit-font-smoothing:antialiased;
font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:760px;margin:0 auto;padding:0 0 96px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
header.site{display:flex;align-items:center;justify-content:space-between;gap:12px;
flex-wrap:wrap;padding:22px 0 28px}
.brand{font-weight:700;font-size:18px;letter-spacing:-.01em;color:var(--fg)}
.brand:hover{text-decoration:none}
.brand .tick{color:var(--green)}
.brand .sfx{color:var(--muted);font-weight:400}
nav a{color:var(--muted);margin-left:18px;font-size:14px}
h1{font-size:clamp(28px,5vw,40px);line-height:1.15;letter-spacing:-.02em;margin:12px 0 10px}
h2{font-size:1.35em;line-height:1.25;margin:2.2em 0 .5em;letter-spacing:-.01em}
h3{font-size:1.08em;margin:1.8em 0 .4em}
h4{font-size:1em;margin:1.5em 0 .3em;color:var(--muted)}
.lede{font-size:clamp(16px,2.2vw,19px);color:var(--muted);max-width:62ch;margin:0 0 8px}
.meta{color:var(--muted);font-size:.85em;margin:0 0 28px}
.tag{display:inline-block;font-size:.72em;font-weight:600;letter-spacing:.04em;
text-transform:uppercase;color:var(--accent);
background:color-mix(in srgb,var(--accent) 14%,transparent);border-radius:999px;padding:2px 9px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;
background:var(--code);border-radius:5px;padding:.12em .35em}
pre{background:var(--code);border:1px solid var(--border);border-radius:8px;padding:14px 16px;
overflow-x:auto;font-size:13.5px;line-height:1.55;margin:14px 0}
pre code{background:none;padding:0;font-size:inherit}
blockquote{margin:16px 0;padding:2px 0 2px 16px;border-left:3px solid var(--border);color:var(--muted)}
hr{border:0;border-top:1px solid var(--border);margin:36px 0}
ul,ol{padding-left:22px}
li{margin:.35em 0}
.tw{overflow-x:auto;margin:16px 0}
table{border-collapse:collapse;width:100%;font-size:.92em}
th,td{border:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}
th{background:var(--card);font-weight:600}
.post{display:block;background:var(--card);border:1px solid var(--border);border-radius:12px;
padding:16px 18px;margin:12px 0;color:inherit}
.post:hover{text-decoration:none;border-color:var(--accent)}
.post h3{margin:9px 0 6px;font-size:1.1em;color:var(--fg)}
.post p{margin:0;color:var(--muted);font-size:.94em}
.post .when{color:var(--muted);font-size:.8em;margin-left:8px;font-variant-numeric:tabular-nums}
footer{color:var(--muted);font-size:.9em;margin-top:52px;border-top:1px solid var(--border);
padding-top:20px}
.up{display:inline-block;margin:36px 0 0}
.note{border-left:3px solid var(--accent);background:var(--card);padding:10px 16px;
border-radius:0 8px 8px 0;margin:18px 0}
.ok{color:var(--green)}
.no{color:var(--red)}
h2 a.anchor{color:var(--muted);text-decoration:none;margin-left:6px;opacity:0}
h2:hover a.anchor{opacity:1}
`.trim();

const NAV = `
<nav>
  <a href="./">Lab</a>
  <a href="${MAIN}/w/">Console</a>
  <a href="${MAIN}/architecture.html">Architecture</a>
  <a href="https://github.com/snomiao/agent-yes">GitHub</a>
</nav>`.trim();

const FOOTER = `
<footer>
  <a href="./">agent-yes lab</a> · <a href="${MAIN}/">agent-yes.com</a> ·
  <a href="${MAIN}/w/">Console</a> ·
  <a href="https://github.com/snomiao/agent-yes">GitHub</a> ·
  <a href="https://www.npmjs.com/package/agent-yes">npm</a>
  <div style="margin-top:8px">MIT · made by <a href="https://github.com/snomiao">snomiao</a></div>
</footer>`.trim();

function page(o: { title: string; description: string; canonical: string; body: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(o.title)}</title>
    <meta name="description" content="${escapeHtml(o.description)}" />
    <link rel="canonical" href="${o.canonical}" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${escapeHtml(o.title)}" />
    <meta property="og:description" content="${escapeHtml(o.description)}" />
    <meta property="og:url" content="${o.canonical}" />
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%E2%9C%93%3C/text%3E%3C/svg%3E"
    />
    <style>
${CSS}
    </style>
  </head>
  <body>
    <main>
      <header class="site">
        <a class="brand" href="./"><span class="tick">✓</span> agent-yes <span class="sfx">lab</span></a>
        ${NAV}
      </header>
${o.body}
      ${FOOTER}
    </main>
  </body>
</html>
`;
}

// ----------------------------------------------------------------------- build

function loadPosts(): Post[] {
  const dir = join(HERE, "posts");
  if (!existsSync(dir)) return [];
  const posts: Post[] = [];
  for (const file of readdirSync(dir).sort()) {
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.(md|html)$/.exec(file);
    if (!m) continue;
    const [, date, slug, ext] = m as unknown as [string, string, string, string];
    const { meta, rest } = frontMatter(readFileSync(join(dir, file), "utf8"));
    if (!meta.title) throw new Error(`lab: ${file} is missing a "title:" front-matter key`);
    posts.push({
      date,
      slug,
      name: `${date}-${slug}`,
      title: meta.title,
      tag: meta.tag ?? "Notes",
      summary: meta.summary ?? "",
      body: ext === "md" ? markdown(rest) : rest.trim(),
    });
  }
  // Newest first; the filename date is the sort key, so it is also the URL.
  return posts.sort((a, b) => (a.name < b.name ? 1 : -1));
}

const nice = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

function postList(posts: Post[]): string {
  return posts
    .map(
      (p) => `      <a class="post" href="./${p.name}">
        <span class="tag">${escapeHtml(p.tag)}</span><span class="when">${nice(p.date)}</span>
        <h3>${escapeHtml(p.title)}</h3>
        <p>${escapeHtml(p.summary)}</p>
      </a>`,
    )
    .join("\n");
}

function build(outDir: string): void {
  const posts = loadPosts();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const p of posts) {
    writeFileSync(
      join(outDir, `${p.name}.html`),
      page({
        // Post titles already carry an em-dash, so join with a middot instead.
        title: `${p.title} · agent-yes lab`,
        description: p.summary,
        canonical: `${SITE}/${p.name}`,
        body: `      <article>
        <p class="meta"><span class="tag">${escapeHtml(p.tag)}</span> · ${nice(p.date)}</p>
        <h1>${escapeHtml(p.title)}</h1>
${p.body}
      </article>
      <a class="up" href="./">← all notes</a>`,
      }),
    );
  }

  const { meta, rest } = frontMatter(readFileSync(join(HERE, "index.md"), "utf8"));
  const body = markdown(rest).replace(/<p>&lt;!--posts--&gt;<\/p>|<!--posts-->/, () =>
    postList(posts),
  );
  writeFileSync(
    join(outDir, "index.html"),
    page({
      title: meta.title ?? "agent-yes lab",
      description: meta.summary ?? "",
      canonical: `${SITE}/`,
      body: `      <article>\n${body}\n      </article>`,
    }),
  );

  console.log(`lab: built ${posts.length + 1} pages → ${outDir}`);
}

build(process.argv[2] ?? join(HERE, "../cf/public/lab"));
