/**
 * History Manager for Human in the Loop extension
 * Manages request/response history storage in workspace globalState
 * and attachment files on disk in globalStorageUri
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  Attachment,
  AttachmentRef,
  HistoryEntry,
  HistoryStatus,
  ToolRequest,
  ButtonsToolRequest,
} from "./types";
import { getLogger } from "./logger";

const logger = getLogger();

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
   * Get the base directory for attachment storage
   */
  public getAttachmentsDir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "attachments");
  }

  /**
   * Get URI for a specific attachment file
   */
  public getAttachmentUri(relativePath: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getAttachmentsDir(), relativePath);
  }

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

    // Trim to max size and cleanup removed entries
    if (history.length > MAX_HISTORY_ENTRIES) {
      const removed = history.splice(MAX_HISTORY_ENTRIES);
      // Async cleanup of attachment files for removed entries
      for (const removedEntry of removed) {
        if (
          removedEntry.attachmentRefs &&
          removedEntry.attachmentRefs.length > 0
        ) {
          this.deleteAttachmentFiles(removedEntry.id).catch((err) => {
            logger.error(
              `Failed to cleanup attachments for entry ${removedEntry.id}`,
              err,
            );
          });
        }
      }
    }

    this.saveHistory(history);
    return entry;
  }

  /**
   * Update entry status when response is received
   * If attachments are provided, saves them to disk and stores references
   */
  public async updateEntry(
    requestId: string,
    status: HistoryStatus,
    response?: string | boolean,
    error?: string,
    attachments?: Attachment[],
  ): Promise<void> {
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

      // Save attachment files to disk if provided
      if (attachments && attachments.length > 0) {
        try {
          const refs = await this.saveAttachmentFiles(entry.id, attachments);
          entry.attachmentRefs = refs;
        } catch (err) {
          logger.error(`Failed to save attachments for entry ${entry.id}`, err);
        }
      }

      this.saveHistory(history);
    }
  }

  /**
   * Save attachment files to disk
   * Files stored in: {globalStorageUri}/attachments/{entryId}/{filename}
   */
  private async saveAttachmentFiles(
    entryId: string,
    attachments: Attachment[],
  ): Promise<AttachmentRef[]> {
    const entryDir = vscode.Uri.joinPath(this.getAttachmentsDir(), entryId);

    // Ensure directory exists
    await vscode.workspace.fs.createDirectory(entryDir);

    const refs: AttachmentRef[] = [];
    const usedNames = new Set<string>();

    for (const attachment of attachments) {
      // Handle duplicate filenames
      let fileName = attachment.name;
      if (usedNames.has(fileName.toLowerCase())) {
        const dotIdx = fileName.lastIndexOf(".");
        const baseName = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
        const ext = dotIdx > 0 ? fileName.substring(dotIdx) : "";
        let counter = 1;
        do {
          fileName = `${baseName}(${counter})${ext}`;
          counter++;
        } while (usedNames.has(fileName.toLowerCase()));
      }
      usedNames.add(fileName.toLowerCase());

      const fileUri = vscode.Uri.joinPath(entryDir, fileName);
      const relativePath = `${entryId}/${fileName}`;

      try {
        let fileData: Uint8Array;
        if (attachment.isImage) {
          // Image data is base64 encoded
          fileData = Buffer.from(attachment.data, "base64");
        } else {
          // Text data is raw string
          fileData = Buffer.from(attachment.data, "utf-8");
        }

        await vscode.workspace.fs.writeFile(fileUri, fileData);

        refs.push({
          name: fileName,
          mimeType: attachment.mimeType,
          isImage: attachment.isImage,
          size: attachment.size,
          relativePath,
        });

        logger.debug(
          `Saved attachment: ${relativePath} (${attachment.size} bytes)`,
        );
      } catch (err) {
        logger.error(`Failed to save attachment ${fileName}`, err);
      }
    }

    return refs;
  }

  /**
   * Delete all attachment files for a history entry
   */
  private async deleteAttachmentFiles(entryId: string): Promise<void> {
    const entryDir = vscode.Uri.joinPath(this.getAttachmentsDir(), entryId);
    try {
      await vscode.workspace.fs.delete(entryDir, { recursive: true });
      logger.debug(`Deleted attachments for entry ${entryId}`);
    } catch {
      // Directory may not exist, that's fine
    }
  }

  /**
   * Clear all history for current workspace
   */
  public async clearHistory(): Promise<void> {
    // Delete all attachment files
    try {
      const attachmentsDir = this.getAttachmentsDir();
      await vscode.workspace.fs.delete(attachmentsDir, { recursive: true });
      logger.debug("Cleared all attachment files");
    } catch {
      // Directory may not exist, that's fine
    }

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
