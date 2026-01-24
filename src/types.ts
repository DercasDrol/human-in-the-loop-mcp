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
 * Base request from MCP tool
 */
export interface BaseToolRequest {
  id: string;
  type: ToolType;
  title: string;
  message: string;
  timestamp: number;
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
    | "requestCancelled";
  request?: ToolRequest;
  messageHtml?: string; // Pre-rendered markdown HTML
  countdown?: number;
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
}

/**
 * Message from webview to extension
 */
export interface WebviewToExtensionMessage {
  type: "response" | "ready" | "togglePause" | "showInstructions" | "showHistory";
  requestId?: string;
  value?: string | boolean;
}

/**
 * Pending request with resolve/reject functions
 */
export interface PendingRequest {
  request: ToolRequest;
  resolve: (response: ToolResponse) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout | null;
  remainingTime: number; // Remaining time in ms when paused
  isPaused: boolean;
  startTime: number; // When the current timeout started
  totalTimeout: number; // Original total timeout in ms
}

/**
 * History entry status
 */
export type HistoryStatus = "pending" | "answered" | "timeout" | "cancelled";

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
}
