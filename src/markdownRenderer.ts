/**
 * Markdown renderer using markdown-it
 * Renders markdown on the extension side (Node.js) for reliability
 *
 * Security model (markdown-it is safe by default):
 * 1. html:false prevents HTML injection at source
 * 2. Built-in protection blocks dangerous URLs:
 *    - javascript:, vbscript: (XSS vectors)
 *    - file: (local file access)
 *    - data: (except safe images: gif/png/jpeg/webp)
 *
 * Using markdown-it because:
 * - Supports CommonJS (unlike marked v17+ which is ESM-only)
 * - Safe by default with html:false + URL filtering
 * - Built-in GFM tables and strikethrough support
 * - High performance (743+ ops/sec)
 * - Well-maintained with 13M+ weekly downloads
 * - Small footprint (~300KB bundled)
 */

import MarkdownIt from "markdown-it";

// Configure markdown-it with safe defaults
const md = new MarkdownIt({
  html: false, // CRITICAL: Disable HTML tags in source (security)
  xhtmlOut: false, // Use '>' to close single tags (<br>)
  breaks: true, // Convert '\n' in paragraphs into <br>
  langPrefix: "language-", // CSS language prefix for fenced blocks
  linkify: true, // Autoconvert URL-like text to links
  typographer: false, // Disable smartquotes and other replacements
});

/**
 * Renders markdown text to HTML
 * Output is safe due to markdown-it's built-in protections
 * @param text - Markdown text to render
 * @returns Safe HTML string ready for display
 */
export function renderMarkdown(text: string): string {
  if (!text) {
    return "";
  }

  try {
    // Parse markdown to HTML using markdown-it
    // Security: html:false + built-in URL filtering prevents XSS
    const html = md.render(text);

    // Add security attributes to links (target="_blank" rel="noopener noreferrer")
    return html.replace(
      /<a\s+href=/g,
      '<a target="_blank" rel="noopener noreferrer" href=',
    );
  } catch (error) {
    console.error("Error rendering markdown:", error);
    // Fallback: escape HTML and return as preformatted text
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");
    return `<pre>${escaped}</pre>`;
  }
}

/**
 * Renders markdown for display in webview
 * Same as renderMarkdown but with container div for styling
 * @param text - Markdown text to render
 * @returns Safe HTML with webview-friendly styling
 */
export function renderMarkdownForWebview(text: string): string {
  const html = renderMarkdown(text);
  // Wrap in a container for styling
  return `<div class="markdown-content">${html}</div>`;
}
