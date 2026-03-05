/**
 * Types for Human in the Loop MCP Extension
 */

/**
 * Types of MCP tool requests
 */
export type ToolType =
  | "ask_user_text"
  | "ask_user_confirm"
  | "ask_user_buttons";

/**
 * Button option for ask_user_buttons tool
 */
export interface ButtonOption {
  label: string;
  value: string;
}

/**
 * File attachment for tool responses
 */
export interface Attachment {
  /** File name (e.g. "screenshot.png") */
  name: string;
  /** MIME type (e.g. "image/png", "text/plain") */
  mimeType: string;
  /** File data: base64 for images/binary, raw text for text files */
  data: string;
  /** Whether this is an image file */
  isImage: boolean;
  /** File size in bytes */
  size: number;
}

/**
 * Base request from MCP tool
 */
export interface BaseToolRequest {
  id: string;
  type: ToolType;
  title: string;
  message: string;
  timestamp: number;
  /** Absolute timestamp when server timeout will occur (for UI sync) */
  serverEndTime?: number;
}

/**
 * Text input request
 */
export interface TextToolRequest extends BaseToolRequest {
  type: "ask_user_text";
  placeholder?: string;
}

/**
 * Confirmation request
 */
export interface ConfirmToolRequest extends BaseToolRequest {
  type: "ask_user_confirm";
}

/**
 * Button selection request
 */
export interface ButtonsToolRequest extends BaseToolRequest {
  type: "ask_user_buttons";
  options: ButtonOption[];
}

/**
 * Union type for all tool requests
 */
export type ToolRequest =
  | TextToolRequest
  | ConfirmToolRequest
  | ButtonsToolRequest;

/**
 * Response from user
 */
export interface ToolResponse {
  id: string;
  success: boolean;
  value?: string | boolean;
  error?: string;
  timedOut?: boolean;
  /** File attachments included with the response */
  attachments?: Attachment[];
}

/**
 * Message from extension to webview
 */
export interface ExtensionToWebviewMessage {
  type:
    | "newRequest"
    | "updateCountdown"
    | "clearRequest"
    | "serverInfo"
    | "settings"
    | "playSound"
    | "pauseState"
    | "requestCancelled"
    | "filesAttached";
  request?: ToolRequest;
  messageHtml?: string; // Pre-rendered markdown HTML
  countdown?: number;
  /** Absolute timestamp when server timeout will occur (for UI sync) */
  serverEndTime?: number;
  serverUrl?: string;
  serverPort?: number;
  configStatus?: "not-configured" | "configured" | "running";
  isPaused?: boolean; // Timer pause state
  // For requestCancelled
  requestId?: string;
  reason?: string;
  settings?: {
    autoSubmitOnTimeout?: boolean;
    soundEnabled?: boolean;
    soundVolume?: number;
    soundType?: string;
  };
  // For filesAttached
  attachments?: Attachment[];
  /** Error message when file attachment fails */
  attachError?: string;
}

/**
 * Message from webview to extension
 */
export interface WebviewToExtensionMessage {
  type:
    | "response"
    | "ready"
    | "togglePause"
    | "showInstructions"
    | "showHistory"
    | "attachFiles"
    | "removeAttachment"
    | "addDroppedFiles";
  requestId?: string;
  value?: string | boolean;
  /** File attachments included with the response */
  attachments?: Attachment[];
  /** Index of attachment to remove (for removeAttachment) */
  attachmentIndex?: number;
  /** Dropped/pasted file data from webview */
  droppedFiles?: Array<{
    name: string;
    mimeType: string;
    data: string; // base64 for binary/images, raw text for text files
    isImage: boolean;
    size: number;
  }>;
}

/**
 * Pending request with resolve/reject functions
 */
export interface PendingRequest {
  request: ToolRequest;
  resolve: (response: ToolResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout | null;
  checkIntervalId: NodeJS.Timeout | null; // Interval for socket state checking
  remainingTime: number; // Remaining time in ms when paused
  isPaused: boolean;
  startTime: number; // When the current timeout started
  totalTimeout: number; // Original total timeout in ms
  jsonRpcId?: string | number; // Original JSON-RPC request id for mapping cleanup
}

/**
 * History entry status
 */
export type HistoryStatus = "pending" | "answered" | "timeout" | "cancelled";

/**
 * Reference to an attachment file stored on disk
 */
export interface AttachmentRef {
  /** File name (e.g. "screenshot.png") */
  name: string;
  /** MIME type */
  mimeType: string;
  /** Whether this is an image file */
  isImage: boolean;
  /** File size in bytes */
  size: number;
  /** Relative path within attachments storage dir: {entryId}/{filename} */
  relativePath: string;
}

/**
 * History entry for request/response tracking
 */
export interface HistoryEntry {
  id: string;
  requestId: string;
  toolName: ToolType;
  title: string;
  message: string;
  options?: Array<{ label: string; value: string }>;
  requestTime: number; // timestamp ms
  responseTime?: number; // timestamp ms
  status: HistoryStatus;
  response?: string | boolean;
  error?: string;
  /** References to attachment files stored on disk */
  attachmentRefs?: AttachmentRef[];
}
