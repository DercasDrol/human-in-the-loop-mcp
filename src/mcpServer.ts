/**
 * MCP Server implementation for Human in the Loop extension
 * Uses HTTP server with SSE transport for MCP protocol
 */

import * as http from "http";
import * as crypto from "crypto";
import * as vscode from "vscode";
import {
  ToolRequest,
  ToolResponse,
  TextToolRequest,
  ConfirmToolRequest,
  ButtonsToolRequest,
  PendingRequest,
} from "./types";
import { HistoryManager } from "./historyManager";
import { getLogger } from "./logger";

// Get logger instance
const logger = getLogger();

// Input validation constants
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 50000;
const MAX_PLACEHOLDER_LENGTH = 500;
const MAX_OPTION_LABEL_LENGTH = 200;
const MAX_OPTION_VALUE_LENGTH = 1000;
const MAX_OPTIONS_COUNT = 50;

/**
 * Validate and sanitize a string input
 * @param value - Value to validate
 * @param maxLength - Maximum allowed length
 * @param defaultValue - Default value if invalid
 * @returns Sanitized string
 */
function validateString(
  value: unknown,
  maxLength: number,
  defaultValue: string = "",
): string {
  if (typeof value !== "string") {
    return defaultValue;
  }
  return value.slice(0, maxLength);
}

/**
 * Validate button options array
 * @param options - Options array to validate
 * @returns Validated and sanitized options array
 */
function validateOptions(
  options: unknown,
): Array<{ label: string; value: string }> {
  if (!Array.isArray(options)) {
    return [];
  }

  return options
    .filter(
      (opt): opt is { label: unknown; value: unknown } =>
        opt !== null && typeof opt === "object",
    )
    .slice(0, MAX_OPTIONS_COUNT)
    .map((opt) => ({
      label: validateString(opt.label, MAX_OPTION_LABEL_LENGTH, "Option"),
      value: validateString(opt.value, MAX_OPTION_VALUE_LENGTH, "option"),
    }))
    .filter((opt) => opt.label.length > 0 && opt.value.length > 0);
}

// Generate UUID using crypto
function generateId(): string {
  return crypto.randomUUID();
}

/**
 * Parse port from URL string
 */
function extractPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = parseInt(parsed.port, 10);
    return isNaN(port) ? null : port;
  } catch {
    // Try to extract port from string like "http://localhost:3000"
    const match = url.match(/:(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }
}

/**
 * MCP Server class that handles tool requests from agents
 */
export class MCPServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private externalUri: vscode.Uri | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  // Map from JSON-RPC request id to internal requestId for cancellation lookup
  private jsonRpcIdToRequestId: Map<string | number, string> = new Map();
  private onRequestCallback: ((request: ToolRequest) => void) | null = null;
  private onRequestCancelledCallback:
    | ((requestId: string, reason: string) => void)
    | null = null;
  private historyManager: HistoryManager | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private configStatus: "not-configured" | "configured" | "running" =
    "not-configured";
  // Lock to prevent race conditions during server start/stop
  private serverOperationLock: Promise<any> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = "humanInTheLoop.showInstructions";
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Set history manager for recording requests/responses
   */
  public setHistoryManager(historyManager: HistoryManager): void {
    this.historyManager = historyManager;
  }

  /**
   * Get configuration status
   */
  public getConfigStatus(): "not-configured" | "configured" | "running" {
    return this.configStatus;
  }

  /**
   * Get the external URI for the server (used for port forwarding info)
   */
  public getExternalUri(): vscode.Uri | null {
    return this.externalUri;
  }

  /**
   * Register port with VS Code for automatic port forwarding in Remote/WSL/Codespaces
   * This is crucial for making the MCP server accessible when running remotely
   */
  private async registerPortForwarding(port: number): Promise<void> {
    try {
      const localUri = vscode.Uri.parse(`http://localhost:${port}`);
      this.externalUri = await vscode.env.asExternalUri(localUri);

      if (this.externalUri.toString() !== localUri.toString()) {
        logger.info(
          `Port forwarding registered: localhost:${port} -> ${this.externalUri.toString()}`,
        );
      } else {
        logger.debug(
          `Port ${port} registered (no forwarding needed - running locally)`,
        );
      }
    } catch (error) {
      logger.warn(`Failed to register port forwarding for port ${port}`, error);
      // Not critical - server still works, just might not be accessible remotely
    }
  }

  /**
   * Find the mcp.json file URI in workspace
   * Returns vscode.Uri for cross-platform compatibility (WSL, Remote, etc.)
   */
  public getMcpJsonUri(): vscode.Uri | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return vscode.Uri.joinPath(workspaceFolders[0].uri, ".vscode", "mcp.json");
  }

  /**
   * Find the mcp.json file path in workspace (legacy, for display purposes)
   */
  public getMcpJsonPath(): string | null {
    const uri = this.getMcpJsonUri();
    return uri ? uri.fsPath : null;
  }

  /**
   * Try to read port from workspace .vscode/mcp.json
   * Returns: { port: number, found: true } or { port: null, found: false, reason: string }
   * Uses vscode.workspace.fs API for cross-platform compatibility (WSL, Remote, etc.)
   */
  public async getPortFromMcpJson(): Promise<
    { port: number; found: true } | { port: null; found: false; reason: string }
  > {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      logger.debug("No workspace folders found");
      return { port: null, found: false, reason: "no-workspace" };
    }

    for (const folder of workspaceFolders) {
      const mcpJsonUri = vscode.Uri.joinPath(folder.uri, ".vscode", "mcp.json");
      logger.debug(`Checking for mcp.json at: ${mcpJsonUri.toString()}`);

      try {
        // Check if file exists using workspace.fs.stat
        try {
          await vscode.workspace.fs.stat(mcpJsonUri);
        } catch {
          logger.debug(`mcp.json does not exist at ${mcpJsonUri.toString()}`);
          continue;
        }

        // Read file using workspace.fs.readFile
        const contentBytes = await vscode.workspace.fs.readFile(mcpJsonUri);
        const content = Buffer.from(contentBytes).toString("utf-8");
        logger.debug(`mcp.json content: ${content}`);

        const mcpConfig = JSON.parse(content);

        // Look for human-in-the-loop or interactive-m server configuration
        const servers = mcpConfig.servers || mcpConfig.mcpServers || {};
        logger.debug(
          `Found servers in mcp.json: ${Object.keys(servers).join(", ")}`,
        );

        // Try different possible server names
        const serverNames = [
          "human-in-the-loop",
          "humanInTheLoop",
          "interactive-m",
          "interactive",
          "human-loop",
        ];

        for (const name of serverNames) {
          const server = servers[name];
          if (server) {
            logger.debug(
              `Found server config for "${name}": ${JSON.stringify(server)}`,
            );

            // Check for direct port property
            if (server.port && typeof server.port === "number") {
              logger.info(
                `Found port ${server.port} in mcp.json server "${name}"`,
              );
              return { port: server.port, found: true };
            }

            // Check for URL property
            if (server.url && typeof server.url === "string") {
              logger.debug(
                `Found URL "${server.url}" in mcp.json server "${name}"`,
              );
              const port = extractPortFromUrl(server.url);
              if (port) {
                logger.info(
                  `Extracted port ${port} from URL in mcp.json server "${name}"`,
                );
                return { port, found: true };
              } else {
                logger.warn(`Failed to extract port from URL: ${server.url}`);
              }
            }
          }
        }

        // If no specific server found, look for any server with our URL pattern
        for (const [name, server] of Object.entries(servers)) {
          const srv = server as any;
          if (
            srv.url &&
            typeof srv.url === "string" &&
            srv.url.includes("127.0.0.1")
          ) {
            const port = extractPortFromUrl(srv.url);
            if (port) {
              logger.info(
                `Extracted port ${port} from URL in mcp.json server "${name}"`,
              );
              return { port, found: true };
            }
          }
        }

        // mcp.json exists but no matching server config
        return { port: null, found: false, reason: "no-server-config" };
      } catch (error) {
        logger.error(
          `Error reading mcp.json from ${mcpJsonUri.toString()}`,
          error,
        );
        return { port: null, found: false, reason: "parse-error" };
      }
    }

    return { port: null, found: false, reason: "no-mcp-json" };
  }

  /**
   * Create default mcp.json configuration
   * Uses vscode.workspace.fs API for cross-platform compatibility (WSL, Remote, etc.)
   */
  public async createDefaultConfig(port: number): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const vscodeUri = vscode.Uri.joinPath(workspaceFolders[0].uri, ".vscode");
    const mcpJsonUri = vscode.Uri.joinPath(vscodeUri, "mcp.json");

    try {
      // Create .vscode directory if it doesn't exist
      try {
        await vscode.workspace.fs.stat(vscodeUri);
      } catch {
        await vscode.workspace.fs.createDirectory(vscodeUri);
      }

      // Check if mcp.json already exists and read it
      let existingConfig: any = { servers: {} };
      try {
        const contentBytes = await vscode.workspace.fs.readFile(mcpJsonUri);
        const content = Buffer.from(contentBytes).toString("utf-8");
        existingConfig = JSON.parse(content);
        if (!existingConfig.servers) {
          existingConfig.servers = {};
        }
      } catch {
        // If reading fails (file doesn't exist or parse error), start fresh
        existingConfig = { servers: {} };
      }

      // Add our server config
      existingConfig.servers["human-in-the-loop"] = {
        url: `http://127.0.0.1:${port}/mcp`,
      };

      // Write the config using workspace.fs
      const configContent = JSON.stringify(existingConfig, null, 2);
      const encoder = new TextEncoder();
      await vscode.workspace.fs.writeFile(
        mcpJsonUri,
        encoder.encode(configContent),
      );
      logger.info(`Created/updated mcp.json at ${mcpJsonUri.toString()}`);

      return true;
    } catch (error) {
      logger.error("Failed to create mcp.json", error);
      return false;
    }
  }

  /**
   * Set callback for new requests
   */
  public onRequest(callback: (request: ToolRequest) => void): void {
    this.onRequestCallback = callback;
  }

  /**
   * Set callback for cancelled requests (agent disconnected, timeout, etc.)
   */
  public onRequestCancelled(
    callback: (requestId: string, reason: string) => void,
  ): void {
    this.onRequestCancelledCallback = callback;
  }

  /**
   * Start the MCP server
   * Returns port number if started, or null if no config found
   * Uses lock to prevent race conditions from rapid calls
   */
  public async start(): Promise<number | null> {
    // Wait for any pending operation to complete
    if (this.serverOperationLock) {
      await this.serverOperationLock;
    }

    const startOperation = this._startInternal();
    this.serverOperationLock = startOperation;

    try {
      const port = await startOperation;

      // Register port for VS Code port forwarding (important for WSL/Remote)
      if (port !== null) {
        await this.registerPortForwarding(port);
      }

      return port;
    } finally {
      this.serverOperationLock = null;
    }
  }

  /**
   * Internal start implementation
   */
  private async _startInternal(): Promise<number | null> {
    if (this.server) {
      await this._stopInternal();
    }

    // Try to get port from workspace mcp.json
    const portResult = await this.getPortFromMcpJson();

    if (!portResult.found) {
      logger.debug(`Cannot start server: ${portResult.reason}`);
      this.configStatus = "not-configured";
      this.updateStatusBar();
      return null;
    }

    const targetPort = portResult.port;
    logger.info(`Using port from mcp.json: ${targetPort}`);
    this.configStatus = "configured";

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        logger.error("MCP Server error", error);
        if (error.code === "EADDRINUSE") {
          reject(
            new Error(
              `Port ${targetPort} is already in use. Please choose a different port in mcp.json`,
            ),
          );
        } else {
          reject(error);
        }
      });

      const bindAddress = vscode.workspace
        .getConfiguration("humanInTheLoop")
        .get<string>("bindAddress", "0.0.0.0");

      this.server.listen(targetPort, bindAddress, () => {
        const address = this.server!.address();
        if (address && typeof address === "object") {
          this.port = address.port;
          this.configStatus = "running";
          this.updateStatusBar();
          logger.server("Started", `port ${this.port} on ${bindAddress}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
    });
  }

  /**
   * Start with a specific port (used when creating new config)
   * Uses lock to prevent race conditions
   */
  public async startWithPort(port: number): Promise<number> {
    // Wait for any pending operation to complete
    if (this.serverOperationLock) {
      await this.serverOperationLock;
    }

    const startOperation = this._startWithPortInternal(port);
    this.serverOperationLock = startOperation;

    try {
      const resultPort = await startOperation;

      // Register port for VS Code port forwarding (important for WSL/Remote)
      await this.registerPortForwarding(resultPort);

      return resultPort;
    } finally {
      this.serverOperationLock = null;
    }
  }

  /**
   * Internal startWithPort implementation
   */
  private async _startWithPortInternal(port: number): Promise<number> {
    if (this.server) {
      await this._stopInternal();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        logger.error("MCP Server error", error);
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(error);
        }
      });

      const bindAddress = vscode.workspace
        .getConfiguration("humanInTheLoop")
        .get<string>("bindAddress", "0.0.0.0");

      this.server.listen(port, bindAddress, () => {
        const address = this.server!.address();
        if (address && typeof address === "object") {
          this.port = address.port;
          this.configStatus = "running";
          this.updateStatusBar();
          logger.server("Started", `port ${this.port} on ${bindAddress}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
    });
  }

  /**
   * Stop the MCP server
   * Uses lock to prevent race conditions
   */
  public async stop(): Promise<void> {
    // Wait for any pending operation to complete
    if (this.serverOperationLock) {
      await this.serverOperationLock;
    }

    const stopOperation = this._stopInternal();
    this.serverOperationLock = stopOperation;

    try {
      await stopOperation;
    } finally {
      this.serverOperationLock = null;
    }
  }

  /**
   * Internal stop implementation
   */
  private async _stopInternal(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Cancel all pending requests
        for (const [id, pending] of this.pendingRequests) {
          if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          if (pending.checkIntervalId) {
            clearInterval(pending.checkIntervalId);
          }
          pending.resolve({
            id,
            success: false,
            error: "Server stopped",
          });
        }
        this.pendingRequests.clear();
        this.jsonRpcIdToRequestId.clear();

        this.server.close(() => {
          this.server = null;
          this.port = 0;
          this.updateStatusBar();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Get the current server port
   */
  public getPort(): number {
    return this.port;
  }

  /**
   * Get the server URL
   */
  public getUrl(): string {
    return `http://localhost:${this.port}/mcp`;
  }

  /**
   * Delete a pending request and clean up associated mappings
   */
  private deletePendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending?.jsonRpcId !== undefined) {
      this.jsonRpcIdToRequestId.delete(pending.jsonRpcId);
    }
    this.pendingRequests.delete(requestId);
  }

  /**
   * Handle user response from WebView
   */
  public handleUserResponse(requestId: string, value: string | boolean): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      if (pending.checkIntervalId) {
        clearInterval(pending.checkIntervalId);
      }
      this.deletePendingRequest(requestId);

      // Record response in history
      if (this.historyManager) {
        this.historyManager.updateEntry(requestId, "answered", value);
      }

      pending.resolve({
        id: requestId,
        success: true,
        value,
      });
    }
  }

  /**
   * Update status bar item
   */
  private updateStatusBar(): void {
    if (this.configStatus === "running" && this.port > 0) {
      this.statusBarItem.text = `$(radio-tower) MCP: ${this.port}`;
      this.statusBarItem.tooltip = `Human in the Loop MCP Server\nPort: ${this.port}\nStatus: Running\nClick for connection instructions`;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
    } else if (this.configStatus === "not-configured") {
      this.statusBarItem.text = `$(warning) MCP: Not Configured`;
      this.statusBarItem.tooltip = `Human in the Loop MCP Server\nNo mcp.json configuration found\nClick to configure`;
      this.statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground",
      );
      this.statusBarItem.show();
    } else {
      this.statusBarItem.text = `$(sync~spin) MCP: Starting...`;
      this.statusBarItem.tooltip = `Human in the Loop MCP Server\nStarting...`;
      this.statusBarItem.backgroundColor = undefined;
      this.statusBarItem.show();
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Enable CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://localhost:${this.port}`);

    if (url.pathname === "/mcp" && req.method === "POST") {
      this.handleMCPRequest(req, res);
    } else if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: this.port }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  }

  /**
   * Handle MCP JSON-RPC request
   */
  private handleMCPRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const MAX_BODY_SIZE = 1024 * 1024; // 1MB limit to prevent DoS
    let body = "";
    let aborted = false;

    req.on("data", (chunk) => {
      if (aborted) return;

      body += chunk.toString();

      // Check body size limit
      if (body.length > MAX_BODY_SIZE) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message: "Request body too large",
              data: `Maximum allowed size is ${MAX_BODY_SIZE} bytes`,
            },
          }),
        );
        req.destroy();
        return;
      }
    });

    req.on("end", async () => {
      if (aborted) return;

      try {
        const jsonRpcRequest = JSON.parse(body);

        // Log all incoming requests for debugging
        logger.mcp("IN", jsonRpcRequest);

        const response = await this.processJsonRpc(jsonRpcRequest, req, res);

        logger.mcp("OUT", response);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32700,
              message: "Parse error",
              data: errorMessage,
            },
          }),
        );
      }
    });
  }

  /**
   * Process JSON-RPC request
   */
  private async processJsonRpc(
    request: any,
    httpReq?: http.IncomingMessage,
    httpRes?: http.ServerResponse,
  ): Promise<any> {
    const { jsonrpc, id, method, params } = request;

    if (jsonrpc !== "2.0") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request" },
      };
    }

    try {
      let result: any;

      switch (method) {
        case "initialize":
          result = this.handleInitialize(params);
          break;
        case "notifications/initialized":
          result = {};
          break;
        case "notifications/cancelled":
          // Handle MCP cancellation notification
          this.handleCancellation(params);
          result = {}; // Notifications don't require a response, but we return empty for consistency
          break;
        case "tools/list":
          result = this.handleToolsList();
          break;
        case "tools/call":
          result = await this.handleToolCall(params, httpReq, httpRes, id);
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Internal error", data: errorMessage },
      };
    }
  }

  /**
   * Handle MCP notifications/cancelled - cancel a pending request
   */
  private handleCancellation(params: any): void {
    const { requestId: jsonRpcRequestId, reason } = params || {};

    if (jsonRpcRequestId === undefined) {
      logger.warn("Cancellation notification received without requestId");
      return;
    }

    // Lookup internal requestId from JSON-RPC id mapping
    const internalRequestId = this.jsonRpcIdToRequestId.get(jsonRpcRequestId);

    logger.request(
      internalRequestId || String(jsonRpcRequestId),
      "Cancellation received",
      { jsonRpcId: jsonRpcRequestId, reason: reason || "No reason provided" },
    );

    if (!internalRequestId) {
      logger.warn(
        `No internal requestId found for JSON-RPC id ${jsonRpcRequestId}`,
      );
      return;
    }

    const pending = this.pendingRequests.get(internalRequestId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      if (pending.checkIntervalId) {
        clearInterval(pending.checkIntervalId);
      }
      this.deletePendingRequest(internalRequestId);

      // Record cancellation in history
      if (this.historyManager) {
        this.historyManager.updateEntry(
          internalRequestId,
          "cancelled",
          undefined,
          reason || "Request cancelled by agent",
        );
      }

      // Notify UI that request was cancelled
      if (this.onRequestCancelledCallback) {
        this.onRequestCancelledCallback(
          internalRequestId,
          reason || "Request cancelled by agent",
        );
      }

      pending.resolve({
        id: internalRequestId,
        success: false,
        error: reason || "Request cancelled by agent",
      });

      logger.request(internalRequestId, "Cancelled successfully");
    } else {
      logger.warn(
        `No pending request found for internal id ${internalRequestId}`,
      );
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(params: any): any {
    // Get version from extension context
    const extension = vscode.extensions.getExtension(
      "DercasDrol.human-in-the-loop-mcp",
    );
    const version = extension?.packageJSON?.version || "1.0.0";

    return {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "human-in-the-loop-mcp",
        version: version,
      },
    };
  }

  /**
   * Handle tools/list request
   */
  private handleToolsList(): any {
    return {
      tools: [
        {
          name: "ask_user_text",
          description: `Ask the user to provide free-form text input through a text field. 

WHEN TO USE:
- When you need open-ended input that cannot be predicted (e.g., API keys, custom paths, names, descriptions)
- When asking for clarification or additional context from the user
- When collecting user preferences, credentials, or configuration values
- When the response could be anything and predefined options won't work

WHEN NOT TO USE:
- For yes/no questions - use ask_user_confirm instead
- For selecting between known options - use ask_user_buttons instead
- When you can infer the answer from context without user input

BEHAVIOR:
- User sees a text input field with your prompt message
- User can type any text and submit
- If timeout expires, returns a timeout error (unless auto-submit is enabled)
- The prompt message supports full Markdown formatting (GFM)

BEST PRACTICES:
- Provide clear, specific prompts explaining what input is expected
- Use placeholder text to show example format (e.g., "/path/to/file" or "sk-...")
- Keep titles short and descriptive
- Use Markdown for better readability (headers, lists, code blocks, etc.)`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  "Short descriptive title shown at the top of the input panel (e.g., 'API Key Required', 'Enter File Path')",
              },
              prompt: {
                type: "string",
                description:
                  "Detailed prompt message explaining what input is needed. Supports full Markdown formatting including headers, lists, code blocks, links, and emphasis.",
              },
              placeholder: {
                type: "string",
                description:
                  "Example text shown in the empty input field to guide the user (e.g., 'sk-...' for API keys, '/home/user/project' for paths)",
              },
            },
            required: ["title", "prompt"],
          },
        },
        {
          name: "ask_user_confirm",
          description: `Ask the user for confirmation with Yes/No buttons, with an optional custom text response.

WHEN TO USE:
- Before performing destructive or irreversible actions (delete, overwrite, format)
- When you need explicit permission to proceed with something risky
- For simple yes/no decisions where the choices are clear
- When asking "Should I...?" or "Do you want me to...?" questions

WHEN NOT TO USE:
- When there are more than 2 options - use ask_user_buttons instead
- When you need free-form text input - use ask_user_text instead
- When the answer is obvious from context

BEHAVIOR:
- User sees Yes and No buttons
- User can also provide a custom text response instead of Yes/No
- Returns "Yes", "No", or the custom text entered by user
- The message supports full Markdown formatting (GFM)

BEST PRACTICES:
- Make the consequences of Yes/No clear in the message
- Explain what will happen for each choice
- Use Markdown to highlight important warnings or details
- Keep the message concise but complete`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  "Short descriptive title for the confirmation dialog (e.g., 'Confirm Deletion', 'Proceed with Changes?')",
              },
              message: {
                type: "string",
                description:
                  "Detailed explanation of what the user is confirming. Should clearly explain the consequences of Yes vs No. Supports full Markdown formatting.",
              },
            },
            required: ["title", "message"],
          },
        },
        {
          name: "ask_user_buttons",
          description: `Ask the user to choose from multiple predefined options using buttons, with an optional custom text response.

WHEN TO USE:
- When presenting a menu of specific choices (e.g., language selection, action options)
- When the valid responses are known and limited
- For multiple-choice decisions with 3+ options
- When guiding the user through a decision tree

WHEN NOT TO USE:
- For simple yes/no questions - use ask_user_confirm instead
- When you need open-ended text input - use ask_user_text instead
- When there are too many options (consider grouping or filtering first)

BEHAVIOR:
- User sees buttons for each option you provide
- User can click a button or enter custom text response
- Returns the 'value' of the clicked button, or the custom text
- The message supports full Markdown formatting (GFM)

BEST PRACTICES:
- Use clear, descriptive button labels
- Keep button values simple and machine-readable
- Limit to 5-7 options for best UX (or use categories)
- Order options logically (most common first, or alphabetically)
- Use Markdown in the message to explain each option if needed`,
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description:
                  "Short descriptive title for the selection (e.g., 'Choose Language', 'Select Action')",
              },
              message: {
                type: "string",
                description:
                  "Explanatory message shown above the buttons. Can include descriptions of each option. Supports full Markdown formatting.",
              },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description:
                        "Human-readable button text shown to the user (e.g., 'TypeScript', 'Create New File')",
                    },
                    value: {
                      type: "string",
                      description:
                        "Machine-readable value returned when this button is clicked (e.g., 'ts', 'create_file')",
                    },
                  },
                  required: ["label", "value"],
                },
                description:
                  "Array of button options. Each option has a human-readable label and a machine-readable value.",
              },
            },
            required: ["title", "message", "options"],
          },
        },
      ],
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolCall(
    params: any,
    httpReq?: http.IncomingMessage,
    httpRes?: http.ServerResponse,
    jsonRpcId?: string | number,
  ): Promise<any> {
    const { name, arguments: args } = params;

    const config = vscode.workspace.getConfiguration("humanInTheLoop");
    const timeout = config.get<number>("timeout", 120) * 1000;

    const requestId = generateId();

    // Store mapping from JSON-RPC id to internal requestId for cancellation lookup
    if (jsonRpcId !== undefined) {
      this.jsonRpcIdToRequestId.set(jsonRpcId, requestId);
    }

    const now = Date.now();
    // Calculate absolute end time for UI synchronization (0 = infinite)
    const serverEndTime = timeout > 0 ? now + timeout : 0;
    let toolRequest: ToolRequest;

    // Validate and sanitize all input parameters
    const safeArgs = args || {};

    switch (name) {
      case "ask_user_text":
        toolRequest = {
          id: requestId,
          type: "ask_user_text",
          title: validateString(
            safeArgs.title,
            MAX_TITLE_LENGTH,
            "Input Required",
          ),
          message: validateString(
            safeArgs.prompt || safeArgs.message,
            MAX_MESSAGE_LENGTH,
            "",
          ),
          placeholder: validateString(
            safeArgs.placeholder,
            MAX_PLACEHOLDER_LENGTH,
            undefined,
          ),
          timestamp: now,
          serverEndTime,
        } as TextToolRequest;
        break;

      case "ask_user_confirm":
        toolRequest = {
          id: requestId,
          type: "ask_user_confirm",
          title: validateString(
            safeArgs.title,
            MAX_TITLE_LENGTH,
            "Confirmation Required",
          ),
          message: validateString(safeArgs.message, MAX_MESSAGE_LENGTH, ""),
          timestamp: now,
          serverEndTime,
        } as ConfirmToolRequest;
        break;

      case "ask_user_buttons":
        toolRequest = {
          id: requestId,
          type: "ask_user_buttons",
          title: validateString(
            safeArgs.title,
            MAX_TITLE_LENGTH,
            "Selection Required",
          ),
          message: validateString(safeArgs.message, MAX_MESSAGE_LENGTH, ""),
          options: validateOptions(safeArgs.options),
          timestamp: now,
          serverEndTime,
        } as ButtonsToolRequest;
        break;

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }

    // Create promise for response
    const responsePromise = new Promise<ToolResponse>((resolve, reject) => {
      let checkIntervalId: NodeJS.Timeout | null = null;

      const timeoutHandler = () => {
        // Clear check interval
        if (checkIntervalId) {
          clearInterval(checkIntervalId);
        }
        this.deletePendingRequest(requestId);
        // Record timeout in history
        if (this.historyManager) {
          this.historyManager.updateEntry(
            requestId,
            "timeout",
            undefined,
            "Request timed out",
          );
        }
        // Notify UI that request timed out
        if (this.onRequestCancelledCallback) {
          this.onRequestCancelledCallback(requestId, "Request timed out");
        }
        resolve({
          id: requestId,
          success: false,
          timedOut: true,
          error: "Request timed out waiting for user response",
        });
      };

      // If timeout is 0, don't set a timeout (infinite wait)
      const timeoutId =
        timeout > 0 ? setTimeout(timeoutHandler, timeout) : null;

      // Listen for HTTP connection close (agent disconnected)
      // Use both event listeners and periodic polling for reliable detection
      let disconnected = false;

      const handleDisconnect = (source: string) => {
        // Only handle once and if response was NOT successfully sent
        if (disconnected || (httpRes && httpRes.writableFinished)) {
          return;
        }
        disconnected = true;

        // Clear check interval
        if (checkIntervalId) {
          clearInterval(checkIntervalId);
        }

        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          if (pending.checkIntervalId) {
            clearInterval(pending.checkIntervalId);
          }
          this.deletePendingRequest(requestId);
          // Record cancellation in history
          if (this.historyManager) {
            this.historyManager.updateEntry(
              requestId,
              "cancelled",
              undefined,
              `Agent disconnected (${source})`,
            );
          }
          // Notify UI that request was cancelled
          if (this.onRequestCancelledCallback) {
            this.onRequestCancelledCallback(requestId, "Agent disconnected");
          }
          resolve({
            id: requestId,
            success: false,
            error: "Agent disconnected before user responded",
          });
        }
      };

      // Listen for client disconnection
      // Be careful with events that can fire prematurely in HTTP keep-alive connections
      if (httpReq) {
        // Only track error events on request - 'close' can fire normally
        httpReq.on("error", (err) => {
          handleDisconnect(`request error: ${err.message}`);
        });
      }

      if (httpRes) {
        // Track response close - but only if response was NOT successfully finished
        httpRes.on("close", () => {
          // Check if response was NOT successfully finished
          if (!httpRes.writableFinished) {
            handleDisconnect("response close (not finished)");
          }
        });

        httpRes.on("error", (err) => {
          handleDisconnect(`response error: ${err.message}`);
        });

        // Socket event listeners
        const socket = httpRes.socket;
        if (socket) {
          // Enable TCP keep-alive with short interval for faster disconnect detection
          // This makes the OS send keep-alive probes to detect dead connections
          socket.setKeepAlive(true, 1000); // 1 second initial delay

          // Only listen for error - 'close' and 'end' can fire prematurely in HTTP
          socket.on("error", (err) => handleDisconnect(`socket error: ${err}`));

          // Periodic socket state checking (every 500ms)
          // This is the most reliable method for detecting disconnections
          checkIntervalId = setInterval(() => {
            // Check multiple indicators of socket health
            if (socket.destroyed) {
              handleDisconnect("socket polling: destroyed");
              return;
            }
            if (!socket.writable) {
              handleDisconnect("socket polling: not writable");
              return;
            }
          }, 500);
        }
      }

      this.pendingRequests.set(requestId, {
        request: toolRequest,
        resolve,
        reject,
        timeoutId,
        checkIntervalId,
        remainingTime: timeout,
        isPaused: false,
        startTime: Date.now(),
        totalTimeout: timeout,
        jsonRpcId,
      });
    });

    // Record in history
    if (this.historyManager) {
      this.historyManager.addEntry(toolRequest);
    }

    // Notify WebView about new request
    if (this.onRequestCallback) {
      this.onRequestCallback(toolRequest);
    }

    // Focus the extension view
    vscode.commands.executeCommand("humanInTheLoop.mainView.focus");

    // Wait for response
    const response = await responsePromise;

    if (response.timedOut) {
      return {
        content: [
          {
            type: "text",
            text: "Request timed out. The user did not respond in time.",
          },
        ],
        isError: true,
      };
    }

    if (!response.success) {
      return {
        content: [
          {
            type: "text",
            text: response.error || "User cancelled the request",
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: "text",
          text:
            typeof response.value === "boolean"
              ? response.value
                ? "Yes"
                : "No"
              : String(response.value),
        },
      ],
    };
  }

  /**
   * Get pending request by ID
   */
  public getPendingRequest(id: string): PendingRequest | undefined {
    return this.pendingRequests.get(id);
  }

  /**
   * Get all pending requests
   */
  public getPendingRequests(): Map<string, PendingRequest> {
    return this.pendingRequests;
  }

  /**
   * Pause the timeout for a specific request
   * @param requestId - The ID of the request to pause
   * @returns true if paused successfully, false if request not found or already paused
   */
  public pauseRequest(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.isPaused) {
      return false;
    }

    // Clear the current timeout
    if (pending.timeoutId) {
      clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }

    // Calculate remaining time
    const elapsed = Date.now() - pending.startTime;
    pending.remainingTime = Math.max(0, pending.remainingTime - elapsed);
    pending.isPaused = true;

    return true;
  }

  /**
   * Resume the timeout for a specific request
   * @param requestId - The ID of the request to resume
   * @returns true if resumed successfully, false if request not found or not paused
   */
  public resumeRequest(requestId: string): boolean {
    const pending = this.pendingRequests.get(requestId);
    if (!pending || !pending.isPaused) {
      return false;
    }

    // If there's remaining time and it's not infinite timeout, restart the timeout
    if (pending.remainingTime > 0 && pending.totalTimeout > 0) {
      pending.timeoutId = setTimeout(() => {
        this.deletePendingRequest(requestId);
        pending.resolve({
          id: requestId,
          success: false,
          timedOut: true,
          error: "Request timed out waiting for user response",
        });
      }, pending.remainingTime);
    }

    pending.startTime = Date.now();
    pending.isPaused = false;

    return true;
  }

  /**
   * Toggle pause state for a request
   * @param requestId - The ID of the request to toggle
   * @returns The new pause state, or undefined if request not found
   */
  public togglePauseRequest(requestId: string): boolean | undefined {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) {
      return undefined;
    }

    if (pending.isPaused) {
      this.resumeRequest(requestId);
      return false;
    } else {
      this.pauseRequest(requestId);
      return true;
    }
  }
}
