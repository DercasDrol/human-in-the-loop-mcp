/**
 * History Manager for Human in the Loop extension
 * Manages request/response history storage in workspace globalState
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  HistoryEntry,
  HistoryStatus,
  ToolRequest,
  ButtonsToolRequest,
} from "./types";

const MAX_HISTORY_ENTRIES = 100;
const HISTORY_KEY_PREFIX = "hitl-history:";

/**
 * Generate unique ID for history entry
 */
function generateHistoryId(): string {
  return crypto.randomUUID();
}

/**
 * Get storage key for current workspace
 */
function getStorageKey(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    // Use workspace folder path as key
    return `${HISTORY_KEY_PREFIX}${workspaceFolders[0].uri.fsPath}`;
  }
  // Fallback for no workspace
  return `${HISTORY_KEY_PREFIX}global`;
}

/**
 * HistoryManager class for managing request/response history
 */
export class HistoryManager {
  private onHistoryChangedEmitter = new vscode.EventEmitter<HistoryEntry[]>();
  public readonly onHistoryChanged = this.onHistoryChangedEmitter.event;

  constructor(private context: vscode.ExtensionContext) {}

  /**
   * Get all history entries for current workspace
   */
  public getHistory(): HistoryEntry[] {
    const key = getStorageKey();
    return this.context.globalState.get<HistoryEntry[]>(key, []);
  }

  /**
   * Add a new entry when request is received
   */
  public addEntry(request: ToolRequest): HistoryEntry {
    const entry: HistoryEntry = {
      id: generateHistoryId(),
      requestId: request.id,
      toolName: request.type,
      title: request.title,
      message: request.message,
      options:
        request.type === "ask_user_buttons"
          ? (request as ButtonsToolRequest).options
          : undefined,
      requestTime: Date.now(),
      status: "pending",
    };

    const history = this.getHistory();
    history.unshift(entry); // Add to beginning

    // Trim to max size
    if (history.length > MAX_HISTORY_ENTRIES) {
      history.splice(MAX_HISTORY_ENTRIES);
    }

    this.saveHistory(history);
    return entry;
  }

  /**
   * Update entry status when response is received
   */
  public updateEntry(
    requestId: string,
    status: HistoryStatus,
    response?: string | boolean,
    error?: string,
  ): void {
    const history = this.getHistory();
    const entry = history.find((e) => e.requestId === requestId);

    if (entry) {
      entry.status = status;
      entry.responseTime = Date.now();
      if (response !== undefined) {
        entry.response = response;
      }
      if (error) {
        entry.error = error;
      }
      this.saveHistory(history);
    }
  }

  /**
   * Clear all history for current workspace
   */
  public clearHistory(): void {
    const key = getStorageKey();
    this.context.globalState.update(key, []);
    this.onHistoryChangedEmitter.fire([]);
  }

  /**
   * Save history and notify listeners
   */
  private saveHistory(history: HistoryEntry[]): void {
    const key = getStorageKey();
    this.context.globalState.update(key, history);
    this.onHistoryChangedEmitter.fire(history);
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.onHistoryChangedEmitter.dispose();
  }
}
