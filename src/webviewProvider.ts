/**
 * WebView Provider for Human in the Loop extension
 * Displays agent messages and handles user responses
 */

import * as vscode from "vscode";
import * as path from "path";
import {
  ToolRequest,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  Attachment,
} from "./types";
import { MCPServer } from "./mcpServer";
import { renderMarkdown } from "./markdownRenderer";
import { getLogger } from "./logger";

// Get logger instance
const logger = getLogger();

/** Image file extensions */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "ico",
  "tiff",
  "tif",
]);

/** Text file extensions (source code, logs, configs, etc.) */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "md",
  "json",
  "xml",
  "yaml",
  "yml",
  "csv",
  "html",
  "htm",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "rs",
  "go",
  "rb",
  "php",
  "sh",
  "bat",
  "ps1",
  "sql",
  "ini",
  "cfg",
  "conf",
  "env",
  "toml",
  "dockerfile",
  "makefile",
  "gitignore",
  "editorconfig",
  "properties",
  "gradle",
  "swift",
  "kt",
  "kts",
  "scala",
  "r",
  "lua",
  "pl",
  "pm",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "clj",
  "cljs",
  "vim",
  "el",
  "lisp",
  "scm",
  "asm",
  "s",
  "diff",
  "patch",
]);

/** Max file size for images (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Max file size for text files (1MB) */
const MAX_TEXT_SIZE = 1 * 1024 * 1024;

/** Max number of attachments */
const MAX_ATTACHMENTS = 10;

export class HumanInTheLoopViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "humanInTheLoop.mainView";

  private _view?: vscode.WebviewView;
  // Multi-request state: supports concurrent agent requests as tabs
  private activeRequests: Map<
    string,
    { request: ToolRequest; messageHtml: string }
  > = new Map();
  private activeRequestId: string | null = null;
  private requestAttachments: Map<string, Attachment[]> = new Map();
  private tabCounter: number = 0; // Sequential tab numbering
  private tabNumbers: Map<string, number> = new Map(); // requestId → tab number
  private cancellationRetryTimers: Map<string, NodeJS.Timeout[]> = new Map();
  private formValues: Map<string, string> = new Map();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly mcpServer: MCPServer,
  ) {
    // Set up request handler
    this.mcpServer.onRequest((request) => {
      this.showRequest(request);
    });

    // Set up request cancelled handler
    this.mcpServer.onRequestCancelled((requestId, reason) => {
      this.handleRequestCancelled(requestId, reason);
    });

    // Set up auto-submit handler: called right before a request times out.
    // If auto-submit is enabled, returns a value + attachments to submit instead of timing out.
    this.mcpServer.onPreTimeout((requestId, request) => {
      const value = this.getAutoSubmitValue(requestId, request);
      if (value === null) {
        return null;
      }
      // Include any attachments the user added before timeout
      const atts = this.requestAttachments.get(requestId);
      const attachList = atts && atts.length > 0 ? [...atts] : undefined;
      // Schedule UI cleanup on next tick (after handleUserResponse resolves the promise)
      setTimeout(() => this.removeRequest(requestId), 0);
      return { value, attachments: attachList };
    });
  }

  /**
   * Handle request cancellation (agent disconnected, timeout, etc.)
   */
  private handleRequestCancelled(requestId: string, reason: string): void {
    logger.request(requestId, "UI handling cancellation", { reason });

    // Clear any existing retry timers for this request
    this.clearCancellationRetryTimers(requestId);

    // If request hasn't been set yet (race condition), wait a bit
    const attemptCancel = (retryCount: number = 0) => {
      if (this.activeRequests.has(requestId)) {
        logger.request(requestId, "Cancellation applied to UI", { retryCount });
        this.clearCancellationRetryTimers(requestId);

        if (this._view) {
          const message: ExtensionToWebviewMessage = {
            type: "requestCancelled",
            requestId,
            reason,
          };
          this._view.webview.postMessage(message);
        }

        // Remove from active requests after a delay to let user see the message
        setTimeout(() => {
          this.removeRequest(requestId);
        }, 5000);
      } else if (retryCount < 5) {
        logger.debug(
          `Cancellation retry ${retryCount + 1}/5 for request ${requestId}`,
        );
        const timer = setTimeout(() => attemptCancel(retryCount + 1), 100);
        this.trackCancellationRetryTimer(requestId, timer);
      } else {
        logger.warn(
          `Cancellation failed after 5 retries for request ${requestId}`,
        );
        this.clearCancellationRetryTimers(requestId);
      }
    };

    attemptCancel();
  }

  /**
   * Track a cancellation retry timer for cleanup
   */
  private trackCancellationRetryTimer(
    requestId: string,
    timer: NodeJS.Timeout,
  ): void {
    if (!this.cancellationRetryTimers.has(requestId)) {
      this.cancellationRetryTimers.set(requestId, []);
    }
    this.cancellationRetryTimers.get(requestId)!.push(timer);
  }

  /**
   * Clear all cancellation retry timers for a request
   */
  private clearCancellationRetryTimers(requestId: string): void {
    const timers = this.cancellationRetryTimers.get(requestId);
    if (timers) {
      timers.forEach((timer) => clearTimeout(timer));
      this.cancellationRetryTimers.delete(requestId);
    }
  }

  /**
   * Clear all cancellation retry timers (for dispose)
   */
  private clearAllCancellationRetryTimers(): void {
    this.cancellationRetryTimers.forEach((timers, requestId) => {
      timers.forEach((timer) => clearTimeout(timer));
    });
    this.cancellationRetryTimers.clear();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        this.handleWebviewMessage(message);
      },
    );

    // Send server info when webview becomes visible
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.sendServerInfo();
        this.sendSettings();
        // Re-send all active requests as tabs
        for (const [id, { request, messageHtml }] of this.activeRequests) {
          this.sendRequest(request, messageHtml, id === this.activeRequestId);
        }
        // Re-send attachments for ALL requests (not just active)
        for (const [id] of this.activeRequests) {
          const atts = this.requestAttachments.get(id);
          if (atts && atts.length > 0) {
            this.sendAttachmentsUpdate(undefined, id);
          }
        }
      }
    });
  }

  /**
   * Handle messages from the webview
   */
  private handleWebviewMessage(message: WebviewToExtensionMessage): void {
    logger.ui("Webview message received", { type: message.type });

    switch (message.type) {
      case "ready":
        logger.ui("Webview ready");
        this.sendServerInfo();
        this.sendSettings();
        // Re-send all active requests to webview
        for (const [reqId, data] of this.activeRequests) {
          const isActive = reqId === this.activeRequestId;
          this.sendRequest(data.request, data.messageHtml, isActive);
        }
        // Re-send attachments for ALL requests (not just active)
        for (const [reqId] of this.activeRequests) {
          const atts = this.requestAttachments.get(reqId);
          if (atts && atts.length > 0) {
            this.sendAttachmentsUpdate(undefined, reqId);
          }
        }
        break;

      case "response":
        if (message.requestId && message.value !== undefined) {
          logger.request(message.requestId, "User response", {
            value: message.value,
            attachmentCount: (
              this.requestAttachments.get(message.requestId) || []
            ).length,
          });
          // Use stored attachments for this specific request
          const attachments = this.requestAttachments.get(message.requestId);
          const attachList =
            attachments && attachments.length > 0
              ? [...attachments]
              : undefined;
          this.mcpServer.handleUserResponse(
            message.requestId,
            message.value,
            attachList,
          );
          this.removeRequest(message.requestId);
        }
        break;

      case "togglePause":
        if (message.requestId) {
          logger.ui("Toggle pause requested", { requestId: message.requestId });
          this.togglePause(message.requestId);
        }
        break;

      case "switchTab":
        if (message.requestId && this.activeRequests.has(message.requestId)) {
          logger.ui("Tab switch requested", { requestId: message.requestId });
          this.activeRequestId = message.requestId;
        }
        break;

      case "formValueUpdate":
        if (
          message.requestId &&
          message.value !== undefined &&
          this.activeRequests.has(message.requestId)
        ) {
          this.formValues.set(message.requestId, String(message.value));
        }
        break;

      case "showInstructions":
        vscode.commands.executeCommand("humanInTheLoop.showInstructions");
        break;

      case "showHistory":
        vscode.commands.executeCommand("humanInTheLoop.showHistory");
        break;

      case "attachFiles":
        this.handleAttachFiles();
        break;

      case "removeAttachment":
        if (message.attachmentIndex !== undefined && this.activeRequestId) {
          const atts = this.requestAttachments.get(this.activeRequestId);
          if (atts) {
            atts.splice(message.attachmentIndex, 1);
            this.sendAttachmentsUpdate();
          }
        }
        break;

      case "addDroppedFiles":
        if (message.droppedFiles && message.droppedFiles.length > 0) {
          this.handleDroppedFiles(message.droppedFiles);
        }
        break;
    }
  }

  /**
   * Toggle pause state of countdown timer
   */
  private togglePause(requestId: string): void {
    if (!this.activeRequests.has(requestId)) {
      return;
    }

    // Toggle pause on the MCP server (affects real timeout)
    const newPauseState = this.mcpServer.togglePauseRequest(requestId);
    if (newPauseState === undefined) {
      return;
    }

    // Notify webview of pause state for this specific request
    const pauseMessage: ExtensionToWebviewMessage = {
      type: "pauseState",
      requestId,
      isPaused: newPauseState,
      // On resume, send updated serverEndTime so webview can sync its countdown
      serverEndTime: !newPauseState
        ? this.mcpServer.getRequestEndTime(requestId)
        : undefined,
    };
    this._view?.webview.postMessage(pauseMessage);
  }

  /**
   * Handle file attachment request from webview
   * Opens VS Code native file picker, reads files, sends data back to webview
   */
  private async handleAttachFiles(): Promise<void> {
    // Capture requestId at start to prevent race condition if user switches tabs during file picker
    const targetRequestId = this.activeRequestId;
    if (!targetRequestId) return;
    const currentAttachments =
      this.requestAttachments.get(targetRequestId) || [];
    const remainingSlots = MAX_ATTACHMENTS - currentAttachments.length;
    if (remainingSlots <= 0) {
      this._view?.webview.postMessage({
        type: "filesAttached",
        attachError: `Maximum ${MAX_ATTACHMENTS} attachments allowed`,
      } as ExtensionToWebviewMessage);
      return;
    }

    const fileUris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFolders: false,
      openLabel: "Attach Files",
      filters: {
        Images: [
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "bmp",
          "svg",
          "ico",
          "tiff",
          "tif",
        ],
        "Text / Source": [
          "txt",
          "log",
          "md",
          "json",
          "xml",
          "yaml",
          "yml",
          "csv",
          "html",
          "htm",
          "css",
          "js",
          "jsx",
          "ts",
          "tsx",
          "py",
          "java",
          "c",
          "cpp",
          "h",
          "hpp",
          "cs",
          "rs",
          "go",
          "rb",
          "php",
          "sh",
          "bat",
          "ps1",
          "sql",
          "ini",
          "cfg",
          "conf",
          "env",
          "toml",
        ],
        "All Files": ["*"],
      },
    });

    if (!fileUris || fileUris.length === 0) {
      return;
    }

    // Check if the target request is still valid (may have been answered/cancelled during file picker)
    if (!this.activeRequests.has(targetRequestId)) {
      logger.warn(
        `Target request ${targetRequestId} no longer exists after file picker`,
      );
      return;
    }

    const errors: string[] = [];
    const newAttachments: Attachment[] = [];

    for (const uri of fileUris) {
      const existingAtts = this.requestAttachments.get(targetRequestId) || [];
      if (newAttachments.length + existingAtts.length >= MAX_ATTACHMENTS) {
        errors.push(`Reached maximum of ${MAX_ATTACHMENTS} attachments`);
        break;
      }

      try {
        const fileStat = await vscode.workspace.fs.stat(uri);
        const ext = path.extname(uri.fsPath).toLowerCase().replace(".", "");
        const fileName = path.basename(uri.fsPath);
        const isImage = IMAGE_EXTENSIONS.has(ext);
        const isText = TEXT_EXTENSIONS.has(ext);

        // Size limits
        if (isImage && fileStat.size > MAX_IMAGE_SIZE) {
          errors.push(
            `${fileName}: too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB for images)`,
          );
          continue;
        }
        if (!isImage && fileStat.size > MAX_TEXT_SIZE) {
          errors.push(
            `${fileName}: too large (max ${MAX_TEXT_SIZE / 1024 / 1024}MB for text files)`,
          );
          continue;
        }

        const fileData = await vscode.workspace.fs.readFile(uri);

        if (isImage) {
          const base64 = Buffer.from(fileData).toString("base64");
          const mimeType = this.getMimeType(ext);
          newAttachments.push({
            name: fileName,
            mimeType,
            data: base64,
            isImage: true,
            size: fileStat.size,
          });
        } else if (isText || fileStat.size < MAX_TEXT_SIZE) {
          const textContent = Buffer.from(fileData).toString("utf-8");
          const mimeType = this.getTextMimeType(ext);
          newAttachments.push({
            name: fileName,
            mimeType,
            data: textContent,
            isImage: false,
            size: fileStat.size,
          });
        } else {
          const base64 = Buffer.from(fileData).toString("base64");
          newAttachments.push({
            name: fileName,
            mimeType: "application/octet-stream",
            data: base64,
            isImage: false,
            size: fileStat.size,
          });
        }

        logger.ui(
          `Attached file: ${fileName} (${isImage ? "image" : "text"}, ${fileStat.size} bytes)`,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        errors.push(`${path.basename(uri.fsPath)}: ${msg}`);
        logger.error(`Failed to read file ${uri.fsPath}`, error);
      }
    }

    // Store on the original target request, not whatever is active now
    const atts = this.requestAttachments.get(targetRequestId) || [];
    atts.push(...newAttachments);
    this.requestAttachments.set(targetRequestId, atts);

    // Only update UI if the target request is still the active tab
    if (this.activeRequestId === targetRequestId) {
      this.sendAttachmentsUpdate(
        errors.length > 0 ? errors.join("; ") : undefined,
      );
    }
  }

  /**
   * Handle files dropped or pasted in the webview
   * Receives file data already read by the webview (FileReader API)
   */
  private handleDroppedFiles(
    droppedFiles: Array<{
      name: string;
      mimeType: string;
      data: string;
      isImage: boolean;
      size: number;
    }>,
  ): void {
    const errors: string[] = [];
    const newAttachments: Attachment[] = [];

    for (const file of droppedFiles) {
      const curAtts = this.activeRequestId
        ? this.requestAttachments.get(this.activeRequestId) || []
        : [];
      if (newAttachments.length + curAtts.length >= MAX_ATTACHMENTS) {
        errors.push(`Reached maximum of ${MAX_ATTACHMENTS} attachments`);
        break;
      }

      // Size limits
      if (file.isImage && file.size > MAX_IMAGE_SIZE) {
        errors.push(
          `${file.name}: too large (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB for images)`,
        );
        continue;
      }
      if (!file.isImage && file.size > MAX_TEXT_SIZE) {
        errors.push(
          `${file.name}: too large (max ${MAX_TEXT_SIZE / 1024 / 1024}MB for text files)`,
        );
        continue;
      }

      newAttachments.push({
        name: file.name,
        mimeType: file.mimeType,
        data: file.data,
        isImage: file.isImage,
        size: file.size,
      });

      logger.ui(
        `Dropped/pasted file: ${file.name} (${file.isImage ? "image" : "text"}, ${file.size} bytes)`,
      );
    }

    if (this.activeRequestId) {
      const atts = this.requestAttachments.get(this.activeRequestId) || [];
      atts.push(...newAttachments);
      this.requestAttachments.set(this.activeRequestId, atts);
    }
    this.sendAttachmentsUpdate(
      errors.length > 0 ? errors.join("; ") : undefined,
    );
  }

  /**
   * Send current attachments state to webview for a specific request
   * Only sends data needed for display (image base64 for thumbnails, no text file content)
   * @param requestId - The request to send attachments for (defaults to activeRequestId)
   * @param error - Optional error message to display
   */
  private sendAttachmentsUpdate(error?: string, requestId?: string): void {
    if (this._view) {
      const targetId = requestId || this.activeRequestId;
      if (!targetId) return;
      const currentAtts = this.requestAttachments.get(targetId) || [];
      // Send lightweight version for webview display
      const displayAttachments = currentAtts.map((att) => ({
        name: att.name,
        mimeType: att.mimeType,
        data: att.isImage ? att.data : "", // Only send data for images (thumbnails)
        isImage: att.isImage,
        size: att.size,
      }));

      this._view.webview.postMessage({
        type: "filesAttached",
        requestId: targetId,
        attachments: displayAttachments,
        attachError: error,
      } as ExtensionToWebviewMessage);
    }
  }

  /**
   * Get MIME type for image files
   */
  private getMimeType(ext: string): string {
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
      ico: "image/x-icon",
      tiff: "image/tiff",
      tif: "image/tiff",
    };
    return mimeMap[ext] || "image/png";
  }

  /**
   * Get MIME type for text files
   */
  private getTextMimeType(ext: string): string {
    const mimeMap: Record<string, string> = {
      txt: "text/plain",
      log: "text/plain",
      md: "text/markdown",
      json: "application/json",
      xml: "text/xml",
      yaml: "text/yaml",
      yml: "text/yaml",
      csv: "text/csv",
      html: "text/html",
      htm: "text/html",
      css: "text/css",
      js: "text/javascript",
      jsx: "text/javascript",
      ts: "text/typescript",
      tsx: "text/typescript",
      py: "text/x-python",
      java: "text/x-java",
      c: "text/x-c",
      cpp: "text/x-c++",
      h: "text/x-c",
      hpp: "text/x-c++",
      cs: "text/x-csharp",
      rs: "text/x-rust",
      go: "text/x-go",
      rb: "text/x-ruby",
      php: "text/x-php",
      sh: "text/x-shellscript",
      bat: "text/plain",
      ps1: "text/plain",
      sql: "text/x-sql",
      ini: "text/plain",
      cfg: "text/plain",
      conf: "text/plain",
      env: "text/plain",
      toml: "text/x-toml",
    };
    return mimeMap[ext] || "text/plain";
  }

  /**
   * Show a new request in the webview (adds as a tab)
   */
  public showRequest(request: ToolRequest): void {
    logger.request(request.id, "Showing in UI", {
      type: request.type,
      title: request.title,
    });

    // Pre-render markdown
    const messageHtml = renderMarkdown(request.message);

    // Add to active requests
    this.activeRequests.set(request.id, { request, messageHtml });
    this.requestAttachments.set(request.id, []);
    this.tabCounter++;
    this.tabNumbers.set(request.id, this.tabCounter);

    // Auto-switch to new request if no active request currently
    const shouldActivate = this.activeRequestId === null;
    if (shouldActivate) {
      this.activeRequestId = request.id;
    }

    // Show the view and send request data
    if (this._view) {
      this._view.show?.(true);
      this.sendRequest(request, messageHtml, shouldActivate);
      this.playNotificationSound();
    }
  }

  /**
   * Remove a specific request and its tab
   */
  private removeRequest(requestId: string): void {
    this.activeRequests.delete(requestId);
    this.requestAttachments.delete(requestId);
    this.tabNumbers.delete(requestId);
    this.formValues.delete(requestId);

    // If this was the active request, switch to the next one
    if (this.activeRequestId === requestId) {
      const remaining = Array.from(this.activeRequests.keys());
      this.activeRequestId = remaining.length > 0 ? remaining[0] : null;
    }

    // Tell webview
    if (this._view) {
      this._view.webview.postMessage({
        type: "clearRequest",
        requestId,
      } as ExtensionToWebviewMessage);
    }
  }

  /**
   * Get auto-submit value for a request that is about to time out.
   * Returns null if auto-submit is disabled or no suitable value can be determined.
   *
   * Priority:
   * 1. Custom text typed by user → use it
   * 2. Attachments present (no custom text) → return "" (attachments-only response)
   * 3. No custom text, no attachments → use default ("Yes" for confirm, first button for buttons)
   * 4. For text input with no typed text and no attachments → null (skip auto-submit)
   */
  private getAutoSubmitValue(
    requestId: string,
    request: ToolRequest,
  ): string | null {
    const config = vscode.workspace.getConfiguration("humanInTheLoop");
    const autoSubmit = config.get<boolean>("autoSubmitOnTimeout", false);
    if (!autoSubmit) {
      return null;
    }

    // Check if webview has reported a form value for this request
    const storedValue = this.formValues.get(requestId);
    if (storedValue && storedValue.trim()) {
      logger.request(requestId, "Auto-submit using stored form value", {
        valueLength: storedValue.trim().length,
      });
      return storedValue.trim();
    }

    // If user attached files, send empty value — attachments speak for themselves
    const hasAttachments =
      (this.requestAttachments.get(requestId) || []).length > 0;
    if (hasAttachments) {
      logger.request(
        requestId,
        "Auto-submit with attachments only (no custom text)",
      );
      return "";
    }

    // Use default values based on request type (no custom text, no attachments)
    switch (request.type) {
      case "ask_user_text":
        // No default for text input — user must type something
        return null;

      case "ask_user_confirm":
        // Default confirmation is "Yes"
        logger.request(requestId, "Auto-submit default: Yes (confirm)");
        return "Yes";

      case "ask_user_buttons":
        // Default to first button option
        if ("options" in request && request.options.length > 0) {
          const defaultValue = request.options[0].value;
          logger.request(requestId, "Auto-submit default: first button", {
            value: defaultValue,
          });
          return defaultValue;
        }
        return null;

      default:
        return null;
    }
  }

  /**
   * Play notification sound
   */
  private playNotificationSound(): void {
    if (this._view) {
      const config = vscode.workspace.getConfiguration("humanInTheLoop");
      const soundEnabled = config.get<boolean>("soundEnabled", true);

      if (soundEnabled) {
        const message: ExtensionToWebviewMessage = {
          type: "playSound",
          settings: {
            soundEnabled: true,
            soundVolume: config.get<number>("soundVolume", 0.5),
            soundType: config.get<string>("soundType", "default"),
          },
        };
        this._view.webview.postMessage(message);
      }
    }
  }

  /**
   * Send settings to webview
   */
  private sendSettings(): void {
    if (this._view) {
      const config = vscode.workspace.getConfiguration("humanInTheLoop");
      const message: ExtensionToWebviewMessage = {
        type: "settings",
        settings: {
          autoSubmitOnTimeout: config.get<boolean>(
            "autoSubmitOnTimeout",
            false,
          ),
          soundEnabled: config.get<boolean>("soundEnabled", true),
          soundVolume: config.get<number>("soundVolume", 0.5),
          soundType: config.get<string>("soundType", "default"),
        },
      };
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Send request to webview (adds tab + optionally activates it)
   */
  private sendRequest(
    request: ToolRequest,
    messageHtml: string,
    isActive: boolean,
  ): void {
    if (this._view) {
      // Use live endTime from server (accounts for pause/resume)
      const serverEndTime = this.mcpServer.getRequestEndTime(request.id);
      const isPaused = this.mcpServer.isRequestPaused(request.id);
      const initialCountdown =
        serverEndTime > 0
          ? Math.max(0, Math.ceil((serverEndTime - Date.now()) / 1000))
          : 0;

      // Get original total timeout from pending request (for progress bar)
      const pendingReq = this.mcpServer.getPendingRequest(request.id);
      const totalTimeoutSec = pendingReq
        ? Math.ceil(pendingReq.totalTimeout / 1000)
        : initialCountdown;

      const tabNumber = this.tabNumbers.get(request.id) || 0;

      const message: ExtensionToWebviewMessage = {
        type: "newRequest",
        request,
        messageHtml,
        countdown: initialCountdown,
        serverEndTime: serverEndTime > 0 ? serverEndTime : 0,
        totalTimeout: totalTimeoutSec,
        isActive,
        tabNumber,
        isPaused,
      };
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Send server info to webview
   */
  private sendServerInfo(): void {
    if (this._view) {
      const configStatus = this.mcpServer.getConfigStatus();
      const message: ExtensionToWebviewMessage = {
        type: "serverInfo",
        serverUrl: configStatus === "running" ? this.mcpServer.getUrl() : "",
        serverPort: this.mcpServer.getPort(),
        configStatus: configStatus,
      };
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Public method to update server info in webview
   * Call this after server starts/stops
   */
  public updateServerInfo(): void {
    this.sendServerInfo();
  }

  /**
   * Dispose resources when extension is deactivated
   */
  public dispose(): void {
    this.clearAllCancellationRetryTimers();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  /**
   * Generate HTML for the webview
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src https: http: data:;">
    <title>Human in the Loop</title>
    <style>
        :root {
            --container-padding: 16px;
            --input-padding: 6px 10px;
            --button-padding: 8px 16px;
        }

        body {
            padding: var(--container-padding);
            color: var(--vscode-foreground);
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            background-color: transparent;
            margin: 0;
        }

        .container {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-widget-border);
            flex-wrap: wrap;
            gap: 8px;
        }

        .header-actions {
            display: flex;
            gap: 6px;
        }

        .header-btn {
            padding: 4px 8px;
            font-size: 11px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.2s;
        }

        .header-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .sticky-timer {
            position: sticky;
            top: 0;
            z-index: 1000;
            background-color: var(--vscode-editor-background);
            padding: 6px 0 0 0;
            margin: 0 calc(-1 * var(--container-padding));
            padding-left: var(--container-padding);
            padding-right: var(--container-padding);
        }

        .server-info {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .countdown {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .countdown-timer {
            color: var(--vscode-descriptionForeground);
            font-variant-numeric: tabular-nums;
        }

        .countdown-percent {
            font-size: 11px;
            font-weight: normal;
            color: var(--vscode-descriptionForeground);
            opacity: 0.6;
            font-variant-numeric: tabular-nums;
        }

        .countdown-timer.warning {
            color: var(--vscode-charts-orange);
        }

        .countdown-timer.critical {
            color: var(--vscode-errorForeground);
            animation: pulse 1s infinite;
        }

        .countdown-timer.paused {
            color: var(--vscode-descriptionForeground);
            opacity: 0.5;
            animation: none;
        }

        .pause-btn {
            font-size: 12px;
            padding: 2px 4px;
        }

        .pause-btn.paused {
            color: var(--vscode-charts-green);
        }

        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }

        .progress-bar {
            width: 100%;
            height: 3px;
            background-color: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            border-radius: 2px;
            background-color: var(--vscode-descriptionForeground);
            transition: width 0.5s linear;
            opacity: 0.5;
        }

        .progress-fill.warning {
            background-color: var(--vscode-charts-orange);
            opacity: 0.7;
        }

        .progress-fill.critical {
            background-color: var(--vscode-errorForeground);
            opacity: 0.85;
        }

        .progress-fill.paused {
            background-color: var(--vscode-descriptionForeground);
            opacity: 0.25;
        }

        .request-container {
            display: none;
            flex-direction: column;
            gap: 12px;
        }

        .request-container.visible {
            display: flex;
        }

        .title-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 8px;
        }

        .title {
            font-size: 16px;
            font-weight: bold;
            color: var(--vscode-foreground);
            margin: 0;
            flex: 1;
        }

        .icon-btn {
            background: transparent;
            border: none;
            padding: 4px 6px;
            cursor: pointer;
            font-size: 14px;
            border-radius: 4px;
            opacity: 0.7;
            transition: opacity 0.2s, background-color 0.2s;
        }

        .icon-btn:hover {
            opacity: 1;
            background-color: var(--vscode-button-secondaryBackground);
        }

        .icon-btn.copied {
            color: var(--vscode-charts-green);
        }

        .message {
            color: var(--vscode-foreground);
            line-height: 1.5;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .message code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }

        .message strong, .message b {
            font-weight: bold;
        }

        .message em, .message i {
            font-style: italic;
        }

        .input-container {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .submit-row {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
        }

        .submit-hint {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.8;
        }

        input[type="text"], textarea {
            width: 100%;
            padding: var(--input-padding);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            box-sizing: border-box;
        }

        input[type="text"]:focus, textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        textarea {
            min-height: 80px;
            resize: vertical;
        }

        .button-container {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        button {
            padding: var(--button-padding);
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            transition: background-color 0.2s;
        }

        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }

        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        button.primary {
            background-color: var(--vscode-button-background);
        }

        .confirm-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .confirm-buttons > button:not(.toggle-btn) {
            flex: 1;
            min-width: 80px;
        }

        .custom-input-toggle {
            width: 100%;
            margin-top: 8px;
        }

        .toggle-btn {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            padding: 4px 12px;
            font-size: 12px;
        }

        .custom-input-row {
            display: flex;
            gap: 8px;
            width: 100%;
            margin-top: 8px;
        }

        .custom-input-row input {
            flex: 1;
            padding: var(--input-padding);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: var(--vscode-font-size);
        }

        .custom-input-row input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .custom-input-row button {
            flex-shrink: 0;
        }

        /* Full-size custom input container (same as ask_user_text) */
        .custom-input-container {
            display: flex;
            flex-direction: column;
            gap: 8px;
            width: 100%;
            margin-top: 8px;
        }

        .custom-input-container textarea {
            width: 100%;
            min-height: 80px;
            resize: vertical;
            padding: var(--input-padding);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            font-size: var(--vscode-font-size);
            font-family: var(--vscode-font-family);
            box-sizing: border-box;
        }

        .custom-input-container textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }

        .empty-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 32px 16px;
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

        .instructions {
            margin-top: 16px;
            padding: 12px;
            background-color: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
            font-size: 12px;
        }

        .instructions code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }

        /* Markdown styles */
        .message h1, .message h2, .message h3, .message h4, .message h5, .message h6 {
            margin: 12px 0 8px 0;
            font-weight: 600;
            line-height: 1.3;
        }
        .message h1 { font-size: 1.5em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 4px; }
        .message h2 { font-size: 1.3em; }
        .message h3 { font-size: 1.15em; }
        .message h4 { font-size: 1.05em; }
        .message h5, .message h6 { font-size: 1em; }

        .message p {
            margin: 8px 0;
        }

        .message pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
            margin: 8px 0;
        }

        .message pre code {
            background: none;
            padding: 0;
            font-family: var(--vscode-editor-font-family);
            font-size: 12px;
            white-space: pre;
        }

        .message code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 5px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
            font-size: 0.9em;
        }

        .message blockquote {
            border-left: 3px solid var(--vscode-textLink-foreground);
            margin: 8px 0;
            padding: 4px 12px;
            background-color: var(--vscode-textBlockQuote-background);
            font-style: italic;
        }

        .message ul, .message ol {
            margin: 8px 0;
            padding-left: 24px;
        }

        .message li {
            margin: 4px 0;
        }

        .message hr {
            border: none;
            border-top: 1px solid var(--vscode-widget-border);
            margin: 12px 0;
        }

        .message a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }

        .message a:hover {
            text-decoration: underline;
        }

        .message strong {
            font-weight: 600;
        }

        .message em {
            font-style: italic;
        }

        .message del {
            text-decoration: line-through;
            opacity: 0.7;
        }

        .message img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            margin: 8px 0;
        }

        /* GFM Tables */
        .message table {
            border-collapse: collapse;
            width: 100%;
            margin: 12px 0;
        }

        .message th, .message td {
            border: 1px solid var(--vscode-widget-border);
            padding: 8px 12px;
            text-align: left;
        }

        .message th {
            background-color: var(--vscode-editor-selectionBackground);
            font-weight: 600;
        }

        .message tr:nth-child(even) {
            background-color: var(--vscode-list-hoverBackground);
        }

        /* Markdown content wrapper */
        .markdown-content {
            line-height: 1.5;
        }

        .markdown-content > :first-child {
            margin-top: 0;
        }

        .markdown-content > :last-child {
            margin-bottom: 0;
        }

        /* Cancelled request banner */
        .cancelled-banner {
            background-color: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 4px;
            padding: 12px;
            margin-bottom: 12px;
            color: var(--vscode-foreground);
            line-height: 1.5;
        }

        /* Attachment styles */
        .attach-section {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .attach-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 4px 10px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: background-color 0.2s;
            align-self: flex-start;
        }

        .attach-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }

        .attachments-preview {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .attachment-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 4px;
            font-size: 11px;
            max-width: 200px;
        }

        .attachment-item img {
            width: 32px;
            height: 32px;
            object-fit: cover;
            border-radius: 3px;
        }

        .attachment-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            flex: 1;
        }

        .attachment-size {
            color: var(--vscode-descriptionForeground);
            font-size: 10px;
            white-space: nowrap;
        }

        .attachment-remove {
            background: transparent;
            border: none;
            color: var(--vscode-errorForeground);
            cursor: pointer;
            padding: 0 2px;
            font-size: 14px;
            line-height: 1;
            opacity: 0.7;
        }

        .attachment-remove:hover {
            opacity: 1;
        }

        .attach-error {
            color: var(--vscode-errorForeground);
            font-size: 11px;
            padding: 4px 0;
        }

        /* Drag and drop visual feedback */
        .request-container.drag-over {
            outline: 2px dashed var(--vscode-focusBorder);
            outline-offset: -2px;
            background-color: var(--vscode-editor-selectionBackground);
        }

        .drop-hint {
            display: none;
            text-align: center;
            padding: 12px;
            color: var(--vscode-focusBorder);
            font-size: 13px;
            font-weight: 500;
        }

        .request-container.drag-over .drop-hint {
            display: block;
        }

        /* === Tab bar for multiple concurrent requests === */
        .tab-bar {
            display: none; /* hidden when 0-1 requests */
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
            border-bottom: 1px solid var(--vscode-widget-border);
            padding: 0;
            gap: 0;
            scrollbar-width: thin;
            -webkit-overflow-scrolling: touch;
        }

        .tab-bar.visible {
            display: flex;
        }

        .tab-item {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            border: none;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: var(--vscode-descriptionForeground);
            transition: background-color 0.15s, color 0.15s, border-color 0.15s;
            flex-shrink: 0;
            position: relative;
        }

        .tab-item:hover {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-foreground);
        }

        .tab-item.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-focusBorder);
            font-weight: 600;
        }

        .tab-item.has-new {
            animation: tab-pulse 2s ease-in-out 3;
        }

        @keyframes tab-pulse {
            0%, 100% { background-color: transparent; }
            50% { background-color: var(--vscode-editor-selectionBackground); }
        }

        .tab-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            max-width: 120px;
        }

        .tab-timer {
            font-size: 10px;
            font-variant-numeric: tabular-nums;
            opacity: 0.8;
        }

        .tab-timer.warning {
            color: var(--vscode-charts-orange);
        }

        .tab-timer.critical {
            color: var(--vscode-errorForeground);
        }

        .tab-timer.paused {
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }

        .tab-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-notificationsInfoIcon-foreground);
            position: absolute;
            top: 4px;
            right: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <span class="server-info" id="serverInfo">Server: Not started</span>
            <div class="header-actions">
                <button id="instructionsBtn" class="header-btn" title="Show Connection Instructions">📋 Instructions</button>
                <button id="historyBtn" class="header-btn" title="Show Request History">📜 History</button>
            </div>
        </div>
        
        <div class="tab-bar" id="tabBar" role="tablist" aria-label="Pending requests"></div>

        <div class="sticky-timer" id="stickyTimer" style="display: none;">
            <div class="countdown" id="countdownContainer">
                <span>⏱️</span>
                <span class="countdown-timer" id="countdownTimer" role="timer" aria-label="Time remaining" aria-live="polite">120s</span>
                <span class="countdown-percent" id="countdownPercent"></span>
                <button id="pauseBtn" class="icon-btn pause-btn" title="Pause timer" aria-label="Pause timer">⏸️</button>
            </div>
            <div class="progress-bar" id="progressBar">
                <div class="progress-fill" id="progressFill"></div>
            </div>
        </div>

        <div class="request-container" id="requestContainer">
            <div class="title-row">
                <h2 class="title" id="requestTitle"></h2>
                <button id="copyMessageBtn" class="icon-btn" title="Copy message" aria-label="Copy message to clipboard">📋</button>
            </div>
            <div class="message" id="requestMessage"></div>
            
            <div class="input-container" id="textInputContainer" style="display: none;">
                <textarea id="textInput" placeholder="Enter your response..." aria-label="Your response"></textarea>
                <div class="submit-row">
                    <span class="submit-hint">Enter to send • Shift+Enter for new line</span>
                    <button id="submitTextBtn" class="primary" aria-label="Submit response">Submit</button>
                </div>
            </div>

            <div class="confirm-buttons" id="confirmContainer" style="display: none;">
                <button id="yesBtn" class="primary" aria-label="Confirm yes">Yes</button>
                <button id="noBtn" class="secondary" aria-label="Confirm no">No</button>
                <div class="custom-input-toggle">
                    <button id="confirmCustomToggle" class="toggle-btn" title="Send custom response" aria-label="Toggle custom response input">✏️ Custom response</button>
                </div>
                <div class="custom-input-container" id="confirmCustomInput" style="display: none;">
                    <textarea id="confirmCustomText" placeholder="Type custom response..." aria-label="Custom response text"></textarea>
                    <div class="submit-row">
                        <span class="submit-hint">Enter to send • Shift+Enter for new line</span>
                        <button id="confirmCustomSend" class="primary" aria-label="Send custom response">Send</button>
                    </div>
                </div>
            </div>

            <div class="button-container" id="buttonsContainer" style="display: none;" role="group" aria-label="Response options">
            </div>
            
            <div class="custom-input-toggle" id="buttonsCustomToggle" style="display: none;">
                <button id="buttonsToggleBtn" class="toggle-btn" title="Send custom response" aria-label="Toggle custom response input">✏️ Custom response</button>
            </div>
            <div class="custom-input-container" id="buttonsCustomInput" style="display: none;">
                <textarea id="buttonsCustomText" placeholder="Type custom response..." aria-label="Custom response text"></textarea>
                <div class="submit-row">
                    <span class="submit-hint">Enter to send • Shift+Enter for new line</span>
                    <button id="buttonsCustomSend" class="primary" aria-label="Send custom response">Send</button>
                </div>
            </div>

            <div class="attach-section" id="attachSection">
                <button id="attachBtn" class="attach-btn" title="Attach files or images" aria-label="Attach files or images">📎 Attach files</button>
                <span class="attach-hint" style="font-size: 10px; color: var(--vscode-descriptionForeground);">or drag & drop / paste from clipboard</span>
                <div class="attachments-preview" id="attachmentsPreview"></div>
                <div class="attach-error" id="attachError" style="display: none;"></div>
            </div>
            <div class="drop-hint">📎 Drop files here to attach</div>
        </div>

        <div class="empty-state" id="emptyState" role="status" aria-live="polite">
            <div class="icon">💬</div>
            <h3>Waiting for Agent</h3>
            <p>When an agent sends a message,<br>it will appear here.</p>
            <div class="instructions" id="instructions">
                <strong>Connection Instructions:</strong><br><br>
                Add to your MCP configuration:<br>
                <code id="mcpConfig">"url": "http://localhost:PORT/mcp"</code>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        (function() {
            const vscode = acquireVsCodeApi();
            
            // Elements
            const serverInfo = document.getElementById('serverInfo');
            const tabBar = document.getElementById('tabBar');
            const stickyTimer = document.getElementById('stickyTimer');
            const countdownContainer = document.getElementById('countdownContainer');
            const countdownTimer = document.getElementById('countdownTimer');
            const countdownPercent = document.getElementById('countdownPercent');
            const pauseBtn = document.getElementById('pauseBtn');
            const progressBar = document.getElementById('progressBar');
            const progressFill = document.getElementById('progressFill');
            const requestContainer = document.getElementById('requestContainer');
            const requestTitle = document.getElementById('requestTitle');
            const requestMessage = document.getElementById('requestMessage');
            const copyMessageBtn = document.getElementById('copyMessageBtn');
            const textInputContainer = document.getElementById('textInputContainer');
            const textInput = document.getElementById('textInput');
            const submitTextBtn = document.getElementById('submitTextBtn');
            const confirmContainer = document.getElementById('confirmContainer');
            const yesBtn = document.getElementById('yesBtn');
            const noBtn = document.getElementById('noBtn');
            const confirmCustomToggle = document.getElementById('confirmCustomToggle');
            const confirmCustomInput = document.getElementById('confirmCustomInput');
            const confirmCustomText = document.getElementById('confirmCustomText');
            const confirmCustomSend = document.getElementById('confirmCustomSend');
            const buttonsContainer = document.getElementById('buttonsContainer');
            const buttonsCustomInput = document.getElementById('buttonsCustomInput');
            const buttonsCustomText = document.getElementById('buttonsCustomText');
            const buttonsCustomSend = document.getElementById('buttonsCustomSend');
            const buttonsCustomToggle = document.getElementById('buttonsCustomToggle');
            const buttonsToggleBtn = document.getElementById('buttonsToggleBtn');
            const emptyState = document.getElementById('emptyState');
            const mcpConfig = document.getElementById('mcpConfig');
            const instructionsBtn = document.getElementById('instructionsBtn');
            const historyBtn = document.getElementById('historyBtn');
            const attachBtn = document.getElementById('attachBtn');
            const attachmentsPreview = document.getElementById('attachmentsPreview');
            const attachError = document.getElementById('attachError');
            const attachSection = document.getElementById('attachSection');

            // === MULTI-REQUEST STATE ===
            // Map of all pending requests: requestId → { request, messageHtml, serverEndTime, isPaused, tabNumber, attachments }
            const pendingRequests = new Map();
            let activeRequestId = null; // Currently displayed tab
            let currentAttachments = []; // Attachments display for active tab
            
            // Form state preservation - stores input values by requestId
            let savedFormValues = {};
            
            let settings = {
                autoSubmitOnTimeout: false,
                soundEnabled: true,
                soundVolume: 0.5,
                soundType: 'default'
            };

            // Tab countdown update interval (updates all tab timers)
            let tabTimerInterval = null;

            // Audio context for sound playback - shared instance
            let audioContext = null;
            let audioContextResumed = false;

            // Initialize and resume AudioContext on first user interaction
            function initAudioContext() {
                if (!audioContext) {
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                if (audioContext.state === 'suspended') {
                    audioContext.resume().then(() => {
                        audioContextResumed = true;
                        console.log('AudioContext resumed');
                    });
                } else {
                    audioContextResumed = true;
                }
            }

            // Resume audio on any user click
            document.addEventListener('click', initAudioContext, { once: true });
            document.addEventListener('keydown', initAudioContext, { once: true });

            // Auto-resize textarea based on content
            function autoResizeTextarea(textarea) {
                textarea.style.height = 'auto';
                textarea.style.height = Math.max(80, textarea.scrollHeight) + 'px';
            }

            // Sound generation using Web Audio API
            function playSound(soundType, volume) {
                try {
                    // Initialize context if needed
                    if (!audioContext) {
                        audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    }
                    
                    // Try to resume if suspended
                    if (audioContext.state === 'suspended') {
                        audioContext.resume();
                    }
                    
                    const now = audioContext.currentTime;
                    
                    switch (soundType) {
                        case 'chime': {
                            // Short soft chime
                            const osc = audioContext.createOscillator();
                            const gain = audioContext.createGain();
                            osc.connect(gain);
                            gain.connect(audioContext.destination);
                            osc.frequency.value = 523.25; // C5
                            osc.type = 'sine';
                            gain.gain.value = volume;
                            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
                            osc.start(now);
                            osc.stop(now + 0.5);
                            break;
                        }
                        case 'bell': {
                            // Medium bell sound with harmonics
                            const frequencies = [880, 1760, 2640]; // A5 + harmonics
                            frequencies.forEach((freq, i) => {
                                const osc = audioContext.createOscillator();
                                const gain = audioContext.createGain();
                                osc.connect(gain);
                                gain.connect(audioContext.destination);
                                osc.frequency.value = freq;
                                osc.type = 'sine';
                                gain.gain.value = volume / (i + 1);
                                gain.gain.exponentialRampToValueAtTime(0.01, now + 1.0);
                                osc.start(now);
                                osc.stop(now + 1.0);
                            });
                            break;
                        }
                        case 'ping': {
                            // Short ping
                            const osc = audioContext.createOscillator();
                            const gain = audioContext.createGain();
                            osc.connect(gain);
                            gain.connect(audioContext.destination);
                            osc.frequency.value = 1200;
                            osc.type = 'sine';
                            gain.gain.value = volume;
                            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
                            osc.start(now);
                            osc.stop(now + 0.15);
                            break;
                        }
                        case 'alert': {
                            // Long attention-grabbing alert pattern (beep-beep-beep)
                            for (let i = 0; i < 3; i++) {
                                const osc = audioContext.createOscillator();
                                const gain = audioContext.createGain();
                                osc.connect(gain);
                                gain.connect(audioContext.destination);
                                osc.frequency.value = 800;
                                osc.type = 'square';
                                const beepStart = now + i * 0.4;
                                gain.gain.setValueAtTime(0, beepStart);
                                gain.gain.linearRampToValueAtTime(volume * 0.7, beepStart + 0.05);
                                gain.gain.setValueAtTime(volume * 0.7, beepStart + 0.2);
                                gain.gain.linearRampToValueAtTime(0, beepStart + 0.25);
                                osc.start(beepStart);
                                osc.stop(beepStart + 0.3);
                            }
                            break;
                        }
                        case 'melody': {
                            // Pleasant musical phrase (C-E-G-C ascending)
                            const notes = [523.25, 659.25, 783.99, 1046.50]; // C5-E5-G5-C6
                            notes.forEach((freq, i) => {
                                const osc = audioContext.createOscillator();
                                const gain = audioContext.createGain();
                                osc.connect(gain);
                                gain.connect(audioContext.destination);
                                osc.frequency.value = freq;
                                osc.type = 'sine';
                                const noteStart = now + i * 0.25;
                                gain.gain.setValueAtTime(0, noteStart);
                                gain.gain.linearRampToValueAtTime(volume, noteStart + 0.05);
                                gain.gain.exponentialRampToValueAtTime(0.01, noteStart + 0.4);
                                osc.start(noteStart);
                                osc.stop(noteStart + 0.4);
                            });
                            break;
                        }
                        case 'notification': {
                            // Two-tone ascending notification (like phone notification)
                            const tones = [659.25, 880]; // E5 to A5
                            tones.forEach((freq, i) => {
                                const osc = audioContext.createOscillator();
                                const gain = audioContext.createGain();
                                osc.connect(gain);
                                gain.connect(audioContext.destination);
                                osc.frequency.value = freq;
                                osc.type = 'sine';
                                const toneStart = now + i * 0.15;
                                gain.gain.setValueAtTime(0, toneStart);
                                gain.gain.linearRampToValueAtTime(volume, toneStart + 0.03);
                                gain.gain.setValueAtTime(volume, toneStart + 0.12);
                                gain.gain.exponentialRampToValueAtTime(0.01, toneStart + 0.35);
                                osc.start(toneStart);
                                osc.stop(toneStart + 0.35);
                            });
                            break;
                        }
                        default: {
                            // Default notification sound
                            const osc = audioContext.createOscillator();
                            const gain = audioContext.createGain();
                            osc.connect(gain);
                            gain.connect(audioContext.destination);
                            osc.frequency.value = 440; // A4
                            osc.type = 'sine';
                            gain.gain.value = volume;
                            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
                            osc.start(now);
                            osc.stop(now + 0.3);
                        }
                    }
                } catch (e) {
                    console.log('Could not play sound:', e);
                }
            }

            // Get current input value based on request type
            // Priority: custom text > attachments-only ("") > default (Yes / first button)
            function getCurrentInputValue() {
                const reqData = activeRequestId ? pendingRequests.get(activeRequestId) : null;
                if (!reqData) return null;
                const hasAttachments = currentAttachments.length > 0;
                switch (reqData.request.type) {
                    case 'ask_user_text':
                        if (textInput.value.trim()) return textInput.value.trim();
                        // If attachments present, send empty (attachments-only)
                        return hasAttachments ? '' : null;
                    case 'ask_user_confirm':
                        // Use custom text if typed
                        if (confirmCustomText.value.trim()) return confirmCustomText.value.trim();
                        // Attachments-only: empty value
                        if (hasAttachments) return '';
                        // Default: "Yes"
                        return 'Yes';
                    case 'ask_user_buttons':
                        // Use custom text if typed
                        if (buttonsCustomText.value.trim()) return buttonsCustomText.value.trim();
                        // Attachments-only: empty value
                        if (hasAttachments) return '';
                        // Default: first button option
                        if (reqData.request.options && reqData.request.options.length > 0) {
                            return reqData.request.options[0].value;
                        }
                        return null;
                    default:
                        return null;
                }
            }

            // Auto-submit on timeout
            function handleAutoSubmit() {
                if (!settings.autoSubmitOnTimeout || !activeRequestId) return;
                // Defense-in-depth: never auto-submit while paused
                const reqData = pendingRequests.get(activeRequestId);
                if (!reqData || reqData.isPaused) return;
                const value = getCurrentInputValue();
                // Allow empty value when there are attachments (attachments-only response)
                if (value !== null && (value !== '' || currentAttachments.length > 0)) {
                    sendResponse(value);
                }
            }

            // NOTE: Markdown rendering is done on extension side using markdown-it (html disabled)

            // === TAB MANAGEMENT ===

            // Get remaining seconds for a request
            function getRemainingSeconds(reqData) {
                if (!reqData.serverEndTime || reqData.serverEndTime <= 0) return -1; // infinite
                if (reqData.isPaused) return reqData.pausedRemaining || 0;
                return Math.max(0, Math.ceil((reqData.serverEndTime - Date.now()) / 1000));
            }

            // Format seconds as mm:ss or just seconds
            function formatTime(seconds) {
                if (seconds < 0) return '∞';
                if (seconds >= 60) {
                    const mins = Math.floor(seconds / 60);
                    const secs = seconds % 60;
                    return mins + ':' + (secs < 10 ? '0' : '') + secs;
                }
                return seconds + 's';
            }

            // Render tab bar
            function renderTabs() {
                tabBar.innerHTML = '';
                const count = pendingRequests.size;

                // Only show tab bar when 2+ requests
                if (count <= 1) {
                    tabBar.classList.remove('visible');
                    return;
                }

                tabBar.classList.add('visible');

                for (const [reqId, reqData] of pendingRequests) {
                    const tab = document.createElement('div');
                    tab.className = 'tab-item' + (reqId === activeRequestId ? ' active' : '');
                    tab.setAttribute('role', 'tab');
                    tab.setAttribute('aria-selected', reqId === activeRequestId ? 'true' : 'false');
                    tab.dataset.requestId = reqId;

                    // Tab label: #N: title (truncated)
                    const label = document.createElement('span');
                    label.className = 'tab-label';
                    const titleText = reqData.request.title || 'Request';
                    label.textContent = '#' + reqData.tabNumber + ': ' + (titleText.length > 18 ? titleText.substring(0, 18) + '…' : titleText);
                    label.title = titleText;
                    tab.appendChild(label);

                    // Tab timer
                    const timer = document.createElement('span');
                    timer.className = 'tab-timer';
                    const remaining = getRemainingSeconds(reqData);
                    if (reqData.isPaused) {
                        timer.textContent = '⏸';
                        timer.classList.add('paused');
                    } else if (remaining >= 0) {
                        timer.textContent = formatTime(remaining);
                        const total = reqData.totalTimeout || remaining || 1;
                        const tabPct = Math.max(0, Math.min(100, (remaining / total) * 100));
                        if (tabPct <= 8) timer.classList.add('critical');
                        else if (tabPct <= 20) timer.classList.add('warning');
                    }
                    tab.appendChild(timer);

                    // Click handler
                    tab.addEventListener('click', () => switchToTab(reqId));

                    tabBar.appendChild(tab);
                }
            }

            // Update tab timers without full re-render
            function updateTabTimers() {
                const tabs = tabBar.querySelectorAll('.tab-item');
                tabs.forEach(tab => {
                    const reqId = tab.dataset.requestId;
                    const reqData = pendingRequests.get(reqId);
                    if (!reqData) return;
                    const timer = tab.querySelector('.tab-timer');
                    if (!timer) return;
                    const remaining = getRemainingSeconds(reqData);
                    timer.className = 'tab-timer';
                    if (reqData.isPaused) {
                        timer.textContent = '⏸';
                        timer.classList.add('paused');
                    } else if (remaining >= 0) {
                        timer.textContent = formatTime(remaining);
                        const total = reqData.totalTimeout || remaining || 1;
                        const tabPct = Math.max(0, Math.min(100, (remaining / total) * 100));
                        if (tabPct <= 8) timer.classList.add('critical');
                        else if (tabPct <= 20) timer.classList.add('warning');
                    } else {
                        timer.textContent = '';
                    }
                });

                // Also update the main sticky timer for active request
                updateActiveTimer();
            }

            // Switch to a different tab
            function switchToTab(requestId) {
                if (!pendingRequests.has(requestId)) return;
                if (activeRequestId === requestId) return;

                // Save current form state before switching
                saveCurrentFormState();

                activeRequestId = requestId;
                const reqData = pendingRequests.get(requestId);

                // Notify extension (for attachment management)
                vscode.postMessage({ type: 'switchTab', requestId });

                // Display this request
                displayRequest(reqData);
                renderTabs();
            }

            // Save current form values
            function saveCurrentFormState() {
                if (!activeRequestId) return;
                const reqData = pendingRequests.get(activeRequestId);
                if (!reqData) return;
                const values = {};
                switch (reqData.request.type) {
                    case 'ask_user_text':
                        values.textInput = textInput.value;
                        break;
                    case 'ask_user_confirm':
                        values.confirmCustomText = confirmCustomText.value;
                        values.confirmCustomInputVisible = confirmCustomInput.style.display !== 'none';
                        break;
                    case 'ask_user_buttons':
                        values.buttonsCustomText = buttonsCustomText.value;
                        values.buttonsCustomInputVisible = buttonsCustomInput.style.display !== 'none';
                        break;
                }
                savedFormValues[activeRequestId] = values;
            }

            // Display a specific request in the main content area
            function displayRequest(reqData) {
                const request = reqData.request;
                const savedValues = savedFormValues[request.id] || {};

                // Reset input states (may have been disabled by cancellation banner)
                [textInput, confirmCustomText, buttonsCustomText].forEach(el => {
                    el.disabled = false;
                    el.style.opacity = '1';
                });

                requestTitle.textContent = request.title;
                // Remove any existing cancelled banner
                const oldBanner = requestMessage.querySelector('.cancelled-banner');
                if (oldBanner) oldBanner.remove();
                requestMessage.innerHTML = reqData.messageHtml || request.message;

                // Hide all input types
                textInputContainer.style.display = 'none';
                confirmContainer.style.display = 'none';
                confirmCustomInput.style.display = 'none';
                buttonsContainer.style.display = 'none';
                buttonsCustomInput.style.display = 'none';
                buttonsCustomToggle.style.display = 'none';
                buttonsContainer.innerHTML = '';

                switch (request.type) {
                    case 'ask_user_text':
                        textInputContainer.style.display = 'flex';
                        textInput.placeholder = request.placeholder || 'Enter your response...';
                        textInput.value = savedValues.textInput || '';
                        textInput.focus();
                        break;
                    case 'ask_user_confirm':
                        confirmContainer.style.display = 'flex';
                        confirmCustomText.value = savedValues.confirmCustomText || '';
                        if (savedValues.confirmCustomInputVisible) {
                            confirmCustomInput.style.display = 'flex';
                        }
                        break;
                    case 'ask_user_buttons':
                        buttonsContainer.style.display = 'flex';
                        buttonsCustomToggle.style.display = 'block';
                        buttonsCustomText.value = savedValues.buttonsCustomText || '';
                        if (savedValues.buttonsCustomInputVisible) {
                            buttonsCustomInput.style.display = 'flex';
                        }
                        request.options.forEach(option => {
                            const btn = document.createElement('button');
                            btn.textContent = option.label;
                            btn.addEventListener('click', () => sendResponse(option.value));
                            buttonsContainer.appendChild(btn);
                        });
                        break;
                }

                // Show request container
                requestContainer.classList.add('visible');
                emptyState.style.display = 'none';

                // Update sticky timer for this request
                updateActiveTimer();

                // Update attachments display
                currentAttachments = reqData.attachments || [];
                renderAttachments();
            }

            // Update the sticky timer for the active request
            function updateActiveTimer() {
                const reqData = activeRequestId ? pendingRequests.get(activeRequestId) : null;
                if (!reqData) {
                    stickyTimer.style.display = 'none';
                    return;
                }

                const remaining = getRemainingSeconds(reqData);
                const isPaused = reqData.isPaused;

                if (remaining < 0) {
                    // Infinite timeout
                    stickyTimer.style.display = 'none';
                    return;
                }

                stickyTimer.style.display = 'block';
                countdownTimer.textContent = formatTime(remaining);

                // Auto-submit check (with margin for IPC latency)
                // Never auto-submit while paused
                if (remaining <= 3 && settings.autoSubmitOnTimeout && !isPaused) {
                    handleAutoSubmit();
                }

                // Compute percentage
                const totalTimeout = reqData.totalTimeout || remaining || 1;
                const pct = Math.max(0, Math.min(100, (remaining / totalTimeout) * 100));

                // Show percentage
                countdownPercent.textContent = '(' + Math.round(pct) + '%)';

                // Timer text styling
                countdownTimer.classList.remove('warning', 'critical', 'paused');
                progressFill.classList.remove('warning', 'critical', 'paused');

                if (isPaused) {
                    countdownTimer.classList.add('paused');
                    progressFill.classList.add('paused');
                    pauseBtn.textContent = '▶️';
                    pauseBtn.title = 'Resume timer';
                } else {
                    if (pct <= 8) {
                        countdownTimer.classList.add('critical');
                        progressFill.classList.add('critical');
                    } else if (pct <= 20) {
                        countdownTimer.classList.add('warning');
                        progressFill.classList.add('warning');
                    }
                    pauseBtn.textContent = '⏸️';
                    pauseBtn.title = 'Pause timer';
                }

                // Progress bar width
                progressFill.style.width = pct + '%';
            }

            // Add a new request (from extension newRequest message)
            function addRequest(request, messageHtml, countdown, endTime, isActive, tabNumber, isPausedState, totalTimeoutSec) {
                const reqData = {
                    request,
                    messageHtml,
                    serverEndTime: endTime || 0,
                    totalTimeout: totalTimeoutSec || countdown || 0,
                    isPaused: !!isPausedState,
                    pausedRemaining: isPausedState && endTime > 0 ? Math.max(0, Math.ceil((endTime - Date.now()) / 1000)) : null,
                    tabNumber: tabNumber || pendingRequests.size + 1,
                    attachments: [],
                };
                pendingRequests.set(request.id, reqData);

                if (isActive || !activeRequestId) {
                    activeRequestId = request.id;
                    displayRequest(reqData);
                }

                renderTabs();
                startTabTimerIfNeeded();
            }

            // Remove a request (tab closed / answered / cancelled)
            function removeRequest(requestId) {
                delete savedFormValues[requestId];
                pendingRequests.delete(requestId);

                if (activeRequestId === requestId) {
                    // Switch to next available tab
                    const remaining = Array.from(pendingRequests.keys());
                    if (remaining.length > 0) {
                        activeRequestId = remaining[0];
                        displayRequest(pendingRequests.get(activeRequestId));
                    } else {
                        activeRequestId = null;
                        currentAttachments = [];
                        renderAttachments();
                        requestContainer.classList.remove('visible');
                        emptyState.style.display = 'flex';
                        stickyTimer.style.display = 'none';
                    }
                }

                renderTabs();
                if (pendingRequests.size === 0) {
                    stopTabTimer();
                }
            }

            // Show cancelled state for a specific request
            function showRequestCancelled(requestId, reason) {
                const reqData = pendingRequests.get(requestId);
                if (!reqData) return;

                // Mark as cancelled in the tab
                reqData.cancelled = true;

                // If this is the active request, show cancel banner
                if (activeRequestId === requestId) {
                    requestTitle.innerHTML = '🚫 ' + requestTitle.textContent;
                    const inputs = requestContainer.querySelectorAll('input, textarea, button');
                    inputs.forEach(input => { input.disabled = true; input.style.opacity = '0.5'; });

                    const banner = document.createElement('div');
                    banner.className = 'cancelled-banner';
                    banner.innerHTML = '<strong>⚠️ Request Cancelled</strong><br>' + (reason || 'The agent is no longer waiting for a response.');
                    requestMessage.insertBefore(banner, requestMessage.firstChild);

                    // Re-enable inputs and remove after delay (extension handles removal via clearRequest)
                    setTimeout(() => {
                        const allInputs = requestContainer.querySelectorAll('input, textarea, button');
                        allInputs.forEach(input => { input.disabled = false; input.style.opacity = '1'; });
                    }, 5000);
                }
            }

            // Start interval to update tab timers
            function startTabTimerIfNeeded() {
                if (tabTimerInterval) return;
                tabTimerInterval = setInterval(() => {
                    updateTabTimers();
                }, 500);
            }

            function stopTabTimer() {
                if (tabTimerInterval) {
                    clearInterval(tabTimerInterval);
                    tabTimerInterval = null;
                }
            }

            // Send response for active request
            function sendResponse(value) {
                if (!activeRequestId) return;
                const reqData = pendingRequests.get(activeRequestId);
                if (!reqData || reqData.responded) return; // Prevent double-send
                reqData.responded = true;
                delete savedFormValues[activeRequestId];
                vscode.postMessage({
                    type: 'response',
                    requestId: activeRequestId,
                    value: value
                });
                currentAttachments = [];
                renderAttachments();
            }

            // Event listeners
            
            // Pause/Resume timer button — now sends requestId
            pauseBtn.addEventListener('click', () => {
                if (activeRequestId) {
                    vscode.postMessage({
                        type: 'togglePause',
                        requestId: activeRequestId
                    });
                }
            });

            // Instructions button
            instructionsBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'showInstructions'
                });
            });

            // History button
            historyBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'showHistory'
                });
            });
            
            // Copy message button
            copyMessageBtn.addEventListener('click', async () => {
                try {
                    const reqData = activeRequestId ? pendingRequests.get(activeRequestId) : null;
                    const msgText = reqData ? reqData.request.message : '';
                    await navigator.clipboard.writeText(msgText);
                    copyMessageBtn.textContent = '✅';
                    copyMessageBtn.classList.add('copied');
                    setTimeout(() => {
                        copyMessageBtn.textContent = '📋';
                        copyMessageBtn.classList.remove('copied');
                    }, 1500);
                } catch (err) {
                    console.error('Failed to copy:', err);
                }
            });
            
            submitTextBtn.addEventListener('click', () => {
                const value = textInput.value.trim();
                if (value) {
                    sendResponse(value);
                }
            });

            textInput.addEventListener('keydown', (e) => {
                // Enter alone = send response
                // Shift+Enter = new line (default textarea behavior)
                // Ctrl+Enter = new line (default textarea behavior)
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    const value = textInput.value.trim();
                    if (value) {
                        sendResponse(value);
                    }
                }
            });

            yesBtn.addEventListener('click', () => sendResponse(true));
            noBtn.addEventListener('click', () => sendResponse(false));

            // Custom input toggle for confirm
            confirmCustomToggle.addEventListener('click', () => {
                const isVisible = confirmCustomInput.style.display !== 'none';
                confirmCustomInput.style.display = isVisible ? 'none' : 'flex';
                if (!isVisible) {
                    confirmCustomText.focus();
                }
            });

            // Send custom response for confirm
            confirmCustomSend.addEventListener('click', () => {
                const value = confirmCustomText.value.trim();
                if (value) {
                    sendResponse(value);
                }
            });

            confirmCustomText.addEventListener('keydown', (e) => {
                // Enter alone = send response
                // Shift+Enter = new line (default textarea behavior)
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    const value = confirmCustomText.value.trim();
                    if (value) {
                        sendResponse(value);
                    }
                }
            });

            // Custom input toggle for buttons
            buttonsToggleBtn.addEventListener('click', () => {
                const isVisible = buttonsCustomInput.style.display !== 'none';
                buttonsCustomInput.style.display = isVisible ? 'none' : 'flex';
                if (!isVisible) {
                    buttonsCustomText.focus();
                }
            });

            // Send custom response for buttons
            buttonsCustomSend.addEventListener('click', () => {
                const value = buttonsCustomText.value.trim();
                if (value) {
                    sendResponse(value);
                }
            });

            buttonsCustomText.addEventListener('keydown', (e) => {
                // Enter alone = send response
                // Shift+Enter = new line (default textarea behavior)
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    const value = buttonsCustomText.value.trim();
                    if (value) {
                        sendResponse(value);
                    }
                }
            });

            // Save form values on input to preserve state when switching tabs
            textInput.addEventListener('input', () => {
                autoResizeTextarea(textInput);
                if (activeRequestId) {
                    if (!savedFormValues[activeRequestId]) savedFormValues[activeRequestId] = {};
                    savedFormValues[activeRequestId].textInput = textInput.value;
                    // Report value to extension for server-side auto-submit
                    vscode.postMessage({ type: 'formValueUpdate', requestId: activeRequestId, value: textInput.value });
                }
            });

            confirmCustomText.addEventListener('input', () => {
                autoResizeTextarea(confirmCustomText);
                if (activeRequestId) {
                    if (!savedFormValues[activeRequestId]) savedFormValues[activeRequestId] = {};
                    savedFormValues[activeRequestId].confirmCustomText = confirmCustomText.value;
                    vscode.postMessage({ type: 'formValueUpdate', requestId: activeRequestId, value: confirmCustomText.value });
                }
            });

            buttonsCustomText.addEventListener('input', () => {
                autoResizeTextarea(buttonsCustomText);
                if (activeRequestId) {
                    if (!savedFormValues[activeRequestId]) savedFormValues[activeRequestId] = {};
                    savedFormValues[activeRequestId].buttonsCustomText = buttonsCustomText.value;
                    vscode.postMessage({ type: 'formValueUpdate', requestId: activeRequestId, value: buttonsCustomText.value });
                }
            });

            // Track custom input visibility state
            confirmCustomToggle.addEventListener('click', () => {
                if (activeRequestId) {
                    if (!savedFormValues[activeRequestId]) savedFormValues[activeRequestId] = {};
                    // Store visibility state after toggle
                    setTimeout(() => {
                        savedFormValues[activeRequestId].confirmCustomInputVisible = 
                            confirmCustomInput.style.display !== 'none';
                    }, 0);
                }
            });

            buttonsToggleBtn.addEventListener('click', () => {
                if (activeRequestId) {
                    if (!savedFormValues[activeRequestId]) savedFormValues[activeRequestId] = {};
                    // Store visibility state after toggle
                    setTimeout(() => {
                        savedFormValues[activeRequestId].buttonsCustomInputVisible = 
                            buttonsCustomInput.style.display !== 'none';
                    }, 0);
                }
            });

            // --- Attachment handling ---

            // Format file size for display
            function formatFileSize(bytes) {
                if (bytes < 1024) return bytes + ' B';
                if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
                return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
            }

            // Render attachments preview
            function renderAttachments() {
                attachmentsPreview.innerHTML = '';
                attachError.style.display = 'none';
                
                currentAttachments.forEach((att, index) => {
                    const item = document.createElement('div');
                    item.className = 'attachment-item';
                    
                    if (att.isImage) {
                        const img = document.createElement('img');
                        img.src = 'data:' + att.mimeType + ';base64,' + att.data;
                        img.alt = att.name;
                        item.appendChild(img);
                    } else {
                        const icon = document.createElement('span');
                        icon.textContent = '📄';
                        item.appendChild(icon);
                    }
                    
                    const nameSpan = document.createElement('span');
                    nameSpan.className = 'attachment-name';
                    nameSpan.textContent = att.name;
                    nameSpan.title = att.name;
                    item.appendChild(nameSpan);
                    
                    const sizeSpan = document.createElement('span');
                    sizeSpan.className = 'attachment-size';
                    sizeSpan.textContent = formatFileSize(att.size);
                    item.appendChild(sizeSpan);
                    
                    const removeBtn = document.createElement('button');
                    removeBtn.className = 'attachment-remove';
                    removeBtn.textContent = '✕';
                    removeBtn.title = 'Remove attachment';
                    removeBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'removeAttachment', attachmentIndex: index });
                        currentAttachments.splice(index, 1);
                        renderAttachments();
                    });
                    item.appendChild(removeBtn);
                    
                    attachmentsPreview.appendChild(item);
                });
            }

            // Attach files button
            attachBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'attachFiles' });
            });

            // === Helper: known image/text extensions ===
            const imageExts = new Set(['png','jpg','jpeg','gif','webp','bmp','svg','ico','tiff','tif']);
            const textExts = new Set([
                'txt','log','md','json','xml','yaml','yml','csv','html','htm',
                'css','js','jsx','ts','tsx','py','java','c','cpp','h','hpp',
                'cs','rs','go','rb','php','sh','bat','ps1','sql','ini','cfg',
                'conf','env','toml',
            ]);

            function getFileExtension(name) {
                const idx = name.lastIndexOf('.');
                return idx > 0 ? name.substring(idx + 1).toLowerCase() : '';
            }

            function isImageFile(file) {
                if (file.type && file.type.startsWith('image/')) return true;
                return imageExts.has(getFileExtension(file.name || ''));
            }

            function isTextFile(file) {
                if (file.type && (file.type.startsWith('text/') || file.type === 'application/json')) return true;
                return textExts.has(getFileExtension(file.name || ''));
            }

            function readFileAsAttachment(file) {
                return new Promise((resolve, reject) => {
                    const isImage = isImageFile(file);
                    const reader = new FileReader();

                    reader.onload = () => {
                        if (isImage) {
                            // base64 encode
                            const base64 = reader.result.split(',')[1] || '';
                            resolve({
                                name: file.name || 'image.png',
                                mimeType: file.type || 'image/png',
                                data: base64,
                                isImage: true,
                                size: file.size,
                            });
                        } else {
                            resolve({
                                name: file.name || 'file.txt',
                                mimeType: file.type || 'text/plain',
                                data: reader.result,
                                isImage: false,
                                size: file.size,
                            });
                        }
                    };
                    reader.onerror = () => reject(reader.error);

                    if (isImage) {
                        reader.readAsDataURL(file);
                    } else {
                        reader.readAsText(file);
                    }
                });
            }

            // === Drag and Drop ===
            let dragCounter = 0; // Track nested drag events

            requestContainer.addEventListener('dragenter', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter++;
                if (requestContainer.classList.contains('visible')) {
                    requestContainer.classList.add('drag-over');
                }
            });

            requestContainer.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });

            requestContainer.addEventListener('dragleave', (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter--;
                if (dragCounter <= 0) {
                    dragCounter = 0;
                    requestContainer.classList.remove('drag-over');
                }
            });

            requestContainer.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                dragCounter = 0;
                requestContainer.classList.remove('drag-over');

                if (!activeRequestId) return;

                const files = e.dataTransfer ? e.dataTransfer.files : null;
                if (!files || files.length === 0) return;

                const droppedFiles = [];
                for (let i = 0; i < files.length; i++) {
                    try {
                        const att = await readFileAsAttachment(files[i]);
                        droppedFiles.push(att);
                    } catch (err) {
                        console.error('Failed to read dropped file:', err);
                    }
                }

                if (droppedFiles.length > 0) {
                    vscode.postMessage({ type: 'addDroppedFiles', droppedFiles: droppedFiles });
                }
            });

            // === Clipboard Paste (images) ===
            document.addEventListener('paste', async (e) => {
                if (!activeRequestId) return;

                const items = e.clipboardData ? e.clipboardData.items : [];
                const filesToProcess = [];

                for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    // Only process file/image items (skip text/plain, text/html)
                    if (item.kind === 'file') {
                        const file = item.getAsFile();
                        if (file) {
                            filesToProcess.push(file);
                        }
                    }
                }

                if (filesToProcess.length === 0) return;

                // Prevent the paste from inserting into textarea when we have files
                e.preventDefault();

                const droppedFiles = [];
                for (const file of filesToProcess) {
                    try {
                        const att = await readFileAsAttachment(file);
                        // Clipboard images often have no name
                        if (!att.name || att.name === 'image.png') {
                            att.name = 'clipboard-' + new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19) + '.png';
                        }
                        droppedFiles.push(att);
                    } catch (err) {
                        console.error('Failed to read pasted file:', err);
                    }
                }

                if (droppedFiles.length > 0) {
                    vscode.postMessage({ type: 'addDroppedFiles', droppedFiles: droppedFiles });
                }
            });

            // Handle messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.type) {
                    case 'newRequest':
                        addRequest(
                            message.request,
                            message.messageHtml,
                            message.countdown,
                            message.serverEndTime,
                            message.isActive,
                            message.tabNumber,
                            message.isPaused,
                            message.totalTimeout
                        );
                        break;

                    case 'clearRequest': {
                        const clearId = message.requestId || activeRequestId;
                        if (clearId) removeRequest(clearId);
                        break;
                    }

                    case 'pauseState': {
                        const reqId = message.requestId || activeRequestId;
                        const rd = pendingRequests.get(reqId);
                        if (rd) {
                            if (message.isPaused) {
                                // Calculate remaining BEFORE setting isPaused
                                // (getRemainingSeconds checks isPaused first and would return stale pausedRemaining)
                                rd.pausedRemaining = rd.serverEndTime > 0
                                    ? Math.max(0, Math.ceil((rd.serverEndTime - Date.now()) / 1000))
                                    : null;
                            }
                            rd.isPaused = message.isPaused;
                            if (!message.isPaused && message.serverEndTime) {
                                // Update server end time on resume
                                rd.serverEndTime = message.serverEndTime;
                                rd.pausedRemaining = null;
                            }
                            renderTabs();
                            if (reqId === activeRequestId) {
                                updateActiveTimer();
                            }
                        }
                        break;
                    }

                    case 'serverInfo':
                        if (message.configStatus === 'not-configured') {
                            serverInfo.textContent = 'Server: Not Configured';
                            serverInfo.style.color = 'var(--vscode-errorForeground)';
                            emptyState.querySelector('h3').textContent = 'Configuration Required';
                            emptyState.querySelector('p').innerHTML = 'No MCP configuration found.<br>Please configure the server to get started.';
                            emptyState.querySelector('.icon').textContent = '⚠️';
                            document.getElementById('instructions').innerHTML = 
                                '<strong>Run command:</strong><br><br>' +
                                '<code>Human in the Loop: Configure MCP Server</code><br><br>' +
                                'Or add to <code>.vscode/mcp.json</code>:<br>' +
                                '<code>{"servers": {"human-in-the-loop": {"url": "http://127.0.0.1:PORT/mcp"}}}</code>';
                            document.getElementById('instructions').style.display = 'block';
                        } else if (message.serverPort > 0) {
                            serverInfo.textContent = 'Server: localhost:' + message.serverPort;
                            serverInfo.style.color = 'var(--vscode-foreground)';
                            mcpConfig.textContent = '"url": "' + message.serverUrl + '"';
                            emptyState.querySelector('h3').textContent = '✅ Ready';
                            emptyState.querySelector('p').innerHTML = 'Server is running on port ' + message.serverPort + '.<br>Waiting for agent requests...';
                            emptyState.querySelector('.icon').textContent = '💬';
                            document.getElementById('instructions').style.display = 'none';
                        } else {
                            serverInfo.textContent = 'Server: Starting...';
                            serverInfo.style.color = 'var(--vscode-charts-yellow)';
                            emptyState.querySelector('h3').textContent = 'Starting Server';
                            emptyState.querySelector('p').innerHTML = 'Please wait...';
                            emptyState.querySelector('.icon').textContent = '⏳';
                            document.getElementById('instructions').style.display = 'none';
                        }
                        break;

                    case 'settings':
                        if (message.settings) {
                            settings = { ...settings, ...message.settings };
                        }
                        break;

                    case 'playSound':
                        if (message.settings && message.settings.soundEnabled) {
                            playSound(message.settings.soundType, message.settings.soundVolume);
                        }
                        break;

                    case 'requestCancelled':
                        showRequestCancelled(message.requestId || activeRequestId, message.reason);
                        break;

                    case 'filesAttached':
                        if (message.attachments) {
                            // Store attachments on the target request (or active if not specified)
                            const targetId = message.requestId || activeRequestId;
                            const targetReq = targetId ? pendingRequests.get(targetId) : null;
                            if (targetReq) {
                                targetReq.attachments = message.attachments;
                            }
                            // Only update the visible display if this is the active request
                            if (targetId === activeRequestId) {
                                currentAttachments = message.attachments;
                                renderAttachments();
                            }
                        }
                        if (message.attachError) {
                            attachError.textContent = message.attachError;
                            attachError.style.display = 'block';
                            setTimeout(() => { attachError.style.display = 'none'; }, 5000);
                        }
                        break;
                }
            });

            // Notify extension that webview is ready
            vscode.postMessage({ type: 'ready' });
        }());
    </script>
</body>
</html>`;
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
