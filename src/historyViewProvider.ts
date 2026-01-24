/**
 * History View Provider for Human in the Loop extension
 * Displays request/response history in a WebviewPanel
 */

import * as vscode from "vscode";
import { HistoryEntry, HistoryStatus } from "./types";
import { HistoryManager } from "./historyManager";

/**
 * HistoryViewProvider class for displaying history in a WebviewPanel
 */
export class HistoryViewProvider {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly historyManager: HistoryManager,
  ) {
    // Subscribe to history changes for live updates
    this.disposables.push(
      historyManager.onHistoryChanged((history) => {
        this.updatePanel(history);
      }),
    );
  }

  /**
   * Show or focus the history panel
   */
  public show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "humanInTheLoopHistory",
      "Request History",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "resources", "icon.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "resources", "icon.svg"),
    };

    this.panel.onDidDispose(
      () => {
        this.panel = null;
      },
      null,
      this.disposables,
    );

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.type) {
          case "clearHistory":
            this.historyManager.clearHistory();
            vscode.window.showInformationMessage("History cleared");
            break;
          case "refresh":
            this.updatePanel(this.historyManager.getHistory());
            break;
        }
      },
      null,
      this.disposables,
    );

    this.updatePanel(this.historyManager.getHistory());
  }

  /**
   * Update panel content with history data
   */
  private updatePanel(history: HistoryEntry[]): void {
    if (!this.panel) {
      return;
    }
    this.panel.webview.html = this.getHtml(history);
  }

  /**
   * Get status icon for history entry
   */
  private getStatusIcon(status: HistoryStatus): string {
    switch (status) {
      case "pending":
        return "⏳";
      case "answered":
        return "✅";
      case "timeout":
        return "⏱️";
      case "cancelled":
        return "🚫";
      default:
        return "❓";
    }
  }

  /**
   * Get status color class
   */
  private getStatusClass(status: HistoryStatus): string {
    switch (status) {
      case "pending":
        return "status-pending";
      case "answered":
        return "status-answered";
      case "timeout":
        return "status-timeout";
      case "cancelled":
        return "status-cancelled";
      default:
        return "";
    }
  }

  /**
   * Format timestamp to human-readable string
   */
  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  /**
   * Calculate duration between request and response
   */
  private formatDuration(requestTime: number, responseTime?: number): string {
    if (!responseTime) {
      return "-";
    }
    const duration = (responseTime - requestTime) / 1000;
    if (duration < 60) {
      return `${duration.toFixed(1)}s`;
    }
    const mins = Math.floor(duration / 60);
    const secs = Math.floor(duration % 60);
    return `${mins}m ${secs}s`;
  }

  /**
   * Escape HTML special characters
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * Truncate text with ellipsis
   */
  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + "...";
  }

  /**
   * Render options/buttons for an entry (for buttons tool)
   */
  private renderOptions(entry: HistoryEntry): string {
    if (!entry.options || entry.options.length === 0) {
      // For confirm tool, show Yes/No
      if (entry.toolName === "ask_user_confirm") {
        const isYes = entry.response === true || entry.response === "true";
        const isNo = entry.response === false || entry.response === "false";
        return `
          <div class="options-section">
            <div class="options-label">Options:</div>
            <div class="options-list">
              <span class="option-btn ${isYes ? "selected" : ""}">✓ Yes</span>
              <span class="option-btn ${isNo ? "selected" : ""}">✗ No</span>
            </div>
          </div>
        `;
      }
      return "";
    }

    // For buttons tool, show all options
    const optionsHtml = entry.options
      .map((opt) => {
        const isSelected = entry.response === opt.value;
        return `<span class="option-btn ${isSelected ? "selected" : ""}">${this.escapeHtml(opt.label)}</span>`;
      })
      .join("");

    return `
      <div class="options-section">
        <div class="options-label">Options:</div>
        <div class="options-list">${optionsHtml}</div>
      </div>
    `;
  }

  /**
   * Format response for display (show label for button selections)
   */
  private formatResponse(entry: HistoryEntry): string {
    // For confirm tool
    if (entry.toolName === "ask_user_confirm") {
      if (entry.response === true || entry.response === "true") {
        return "✓ Yes";
      }
      if (entry.response === false || entry.response === "false") {
        return "✗ No";
      }
    }

    // For buttons tool - find the label that matches the value
    if (entry.options && entry.response !== undefined) {
      const selectedOption = entry.options.find(
        (opt) => opt.value === entry.response,
      );
      if (selectedOption) {
        return `${selectedOption.label}`;
      }
    }

    // Default: show raw response
    return this.truncate(String(entry.response), 50);
  }

  /**
   * Generate HTML for history panel
   */
  private getHtml(history: HistoryEntry[]): string {
    const nonce = getNonce();

    const entriesHtml =
      history.length === 0
        ? `<div class="empty-state">
           <div class="icon">📋</div>
           <h3>No History Yet</h3>
           <p>Request history will appear here as agents<br>interact with the extension.</p>
         </div>`
        : history
            .map((entry, index) => {
              return `
        <div class="history-entry ${this.getStatusClass(entry.status)}" data-entry-id="${index}">
          <div class="entry-header">
            <span class="status-icon">${this.getStatusIcon(entry.status)}</span>
            <span class="tool-name">${entry.toolName}</span>
            <span class="entry-time">${this.formatTime(entry.requestTime)}</span>
            <button class="expand-btn" data-entry-id="${index}" title="Expand/Collapse"><span class="arrow">▼</span> <span class="expand-text">Expand</span></button>
          </div>
          <div class="entry-title">${this.escapeHtml(entry.title)}</div>
          <div class="entry-message-preview">${this.escapeHtml(this.truncate(entry.message, 150))}</div>
          <div class="entry-message-full">
            <pre>${this.escapeHtml(entry.message)}</pre>
            ${this.renderOptions(entry)}
          </div>
          <div class="entry-footer">
            <span class="status-badge ${this.getStatusClass(entry.status)}">${entry.status.toUpperCase()}</span>
            <span class="duration">Duration: ${this.formatDuration(entry.requestTime, entry.responseTime)}</span>
          </div>
          ${
            entry.response !== undefined
              ? `
          <div class="entry-response">
            <strong>Response:</strong>
            <span class="response-preview">${this.escapeHtml(this.formatResponse(entry))}</span>
            <div class="response-full"><h4>Full Response:</h4><pre>${this.escapeHtml(String(entry.response))}</pre></div>
          </div>
          `
              : ""
          }
          ${entry.error ? `<div class="entry-error"><strong>Error:</strong> ${this.escapeHtml(entry.error)}</div>` : ""}
        </div>
      `;
            })
            .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <title>Request History</title>
    <style>
        body {
            padding: 16px;
            color: var(--vscode-foreground);
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            margin: 0;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-widget-border);
            margin-bottom: 16px;
        }

        .header h1 {
            margin: 0;
            font-size: 18px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .header-actions {
            display: flex;
            gap: 8px;
        }

        button {
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .stats {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
        }

        .history-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .history-entry {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 6px;
            padding: 12px;
            transition: background-color 0.2s;
        }

        .history-entry:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .history-entry.status-pending {
            border-left: 3px solid var(--vscode-charts-yellow);
        }

        .history-entry.status-answered {
            border-left: 3px solid var(--vscode-charts-green);
        }

        .history-entry.status-timeout {
            border-left: 3px solid var(--vscode-charts-orange);
        }

        .history-entry.status-cancelled {
            border-left: 3px solid var(--vscode-errorForeground);
        }

        .entry-header {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }

        .status-icon {
            font-size: 16px;
        }

        .tool-name {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }

        .entry-time {
            margin-left: auto;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        .entry-title {
            font-weight: 500;
            margin-bottom: 4px;
        }

        .entry-message {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .entry-footer {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            font-size: 11px;
            align-items: center;
        }

        .status-badge {
            padding: 2px 6px;
            border-radius: 3px;
            font-weight: 600;
            font-size: 10px;
        }

        .status-badge.status-pending {
            background-color: var(--vscode-charts-yellow);
            color: #000;
        }

        .status-badge.status-answered {
            background-color: var(--vscode-charts-green);
            color: #000;
        }

        .status-badge.status-timeout {
            background-color: var(--vscode-charts-orange);
            color: #000;
        }

        .status-badge.status-cancelled {
            background-color: var(--vscode-errorForeground);
            color: #fff;
        }

        .duration {
            color: var(--vscode-descriptionForeground);
        }

        .response {
            color: var(--vscode-charts-green);
        }

        .options-section {
            margin-top: 12px;
            padding-top: 12px;
            border-top: 1px solid var(--vscode-widget-border);
        }

        .options-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            font-weight: 600;
        }

        .options-list {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .option-btn {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-secondaryBackground);
            border-radius: 4px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-foreground);
            font-size: 12px;
            cursor: default;
            opacity: 0.7;
        }

        .option-btn.selected {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-color: var(--vscode-button-background);
            opacity: 1;
            font-weight: 600;
        }

        .option-btn.selected::before {
            content: "✓ ";
        }

        .error {
            color: var(--vscode-errorForeground);
        }

        .expand-btn {
            background: transparent;
            border: 1px solid var(--vscode-button-secondaryBackground);
            color: var(--vscode-foreground);
            cursor: pointer;
            padding: 2px 8px;
            border-radius: 3px;
            font-size: 11px;
            display: flex;
            align-items: center;
            gap: 4px;
            transition: background-color 0.2s;
        }

        .expand-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .expand-btn .arrow {
            transition: transform 0.2s;
            display: inline-block;
        }

        .expand-btn.expanded .arrow {
            transform: rotate(180deg);
        }

        .entry-message-preview {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 100%;
        }

        .entry-message-full {
            display: none;
            margin-bottom: 8px;
        }

        .entry-message-full.visible {
            display: block;
        }

        .entry-message-full pre,
        .response-full pre {
            background-color: var(--vscode-textBlockQuote-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 4px;
            padding: 8px;
            margin: 4px 0;
            font-size: 12px;
            white-space: pre-wrap;
            word-break: break-word;
            overflow-x: auto;
            max-height: 300px;
            overflow-y: auto;
        }

        .response-preview {
            font-size: 12px;
            color: var(--vscode-charts-green);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 200px;
            display: inline-block;
        }

        .response-full {
            display: none;
            margin-top: 8px;
        }

        .response-full.visible {
            display: block;
        }

        .response-full h4 {
            margin: 0 0 4px 0;
            font-size: 12px;
            color: var(--vscode-charts-green);
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 48px 16px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
        }

        .empty-state .icon {
            font-size: 48px;
            margin-bottom: 16px;
            opacity: 0.5;
        }

        .empty-state h3 {
            margin: 0 0 8px 0;
            color: var(--vscode-foreground);
        }

        .empty-state p {
            margin: 0;
            font-size: 13px;
            line-height: 1.5;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📋 Request History</h1>
        <div class="header-actions">
            <button class="secondary" id="refreshBtn">🔄 Refresh</button>
            <button class="secondary" id="clearBtn">🗑️ Clear All</button>
        </div>
    </div>
    
    <div class="stats">
        Total: ${history.length} entries | 
        ✅ ${history.filter((e) => e.status === "answered").length} answered | 
        ⏱️ ${history.filter((e) => e.status === "timeout").length} timeout | 
        🚫 ${history.filter((e) => e.status === "cancelled").length} cancelled |
        ⏳ ${history.filter((e) => e.status === "pending").length} pending
    </div>

    <div class="history-list">
        ${entriesHtml}
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        document.getElementById('clearBtn').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear all history?')) {
                vscode.postMessage({ type: 'clearHistory' });
            }
        });

        document.getElementById('refreshBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'refresh' });
        });

        // Handle expand/collapse buttons
        document.querySelectorAll('.expand-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const entryId = btn.getAttribute('data-entry-id');
                const entry = document.querySelector('.history-entry[data-entry-id="' + entryId + '"]');
                if (!entry) return;

                const isExpanded = btn.classList.toggle('expanded');
                const arrow = btn.querySelector('.arrow');
                
                // Toggle message preview/full
                const msgPreview = entry.querySelector('.entry-message-preview');
                const msgFull = entry.querySelector('.entry-message-full');
                const respPreview = entry.querySelector('.response-preview');
                const respFull = entry.querySelector('.response-full');

                if (isExpanded) {
                    btn.querySelector('.expand-text').textContent = 'Collapse';
                    if (msgPreview) msgPreview.style.display = 'none';
                    if (msgFull) msgFull.classList.add('visible');
                    if (respPreview) respPreview.style.display = 'none';
                    if (respFull) respFull.classList.add('visible');
                } else {
                    btn.querySelector('.expand-text').textContent = 'Expand';
                    if (msgPreview) msgPreview.style.display = 'block';
                    if (msgFull) msgFull.classList.remove('visible');
                    if (respPreview) respPreview.style.display = 'inline-block';
                    if (respFull) respFull.classList.remove('visible');
                }
            });
        });
    </script>
</body>
</html>`;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/**
 * Generate a nonce for CSP
 */
function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
