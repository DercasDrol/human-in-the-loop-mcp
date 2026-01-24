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
  private formatDuration(
    requestTime: number,
    responseTime?: number,
  ): string {
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
   * Generate HTML for history panel
   */
  private getHtml(history: HistoryEntry[]): string {
    const nonce = getNonce();

    const entriesHtml = history.length === 0
      ? `<div class="empty-state">
           <div class="icon">📋</div>
           <h3>No History Yet</h3>
           <p>Request history will appear here as agents<br>interact with the extension.</p>
         </div>`
      : history
          .map(
            (entry) => `
        <div class="history-entry ${this.getStatusClass(entry.status)}">
          <div class="entry-header">
            <span class="status-icon">${this.getStatusIcon(entry.status)}</span>
            <span class="tool-name">${entry.toolName}</span>
            <span class="entry-time">${this.formatTime(entry.requestTime)}</span>
          </div>
          <div class="entry-title">${this.escapeHtml(entry.title)}</div>
          <div class="entry-message">${this.escapeHtml(this.truncate(entry.message, 150))}</div>
          <div class="entry-footer">
            <span class="status-badge ${this.getStatusClass(entry.status)}">${entry.status.toUpperCase()}</span>
            <span class="duration">Duration: ${this.formatDuration(entry.requestTime, entry.responseTime)}</span>
            ${entry.response !== undefined ? `<span class="response">Response: ${this.escapeHtml(this.truncate(String(entry.response), 50))}</span>` : ""}
            ${entry.error ? `<span class="error">Error: ${this.escapeHtml(entry.error)}</span>` : ""}
          </div>
        </div>
      `,
          )
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

        .error {
            color: var(--vscode-errorForeground);
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
