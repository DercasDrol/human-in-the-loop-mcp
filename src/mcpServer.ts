/**
 * MCP Server implementation for Human in the Loop extension
 * Uses HTTP server with SSE transport for MCP protocol
 */

import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  ToolRequest,
  ToolResponse,
  TextToolRequest,
  ConfirmToolRequest,
  ButtonsToolRequest,
  PendingRequest,
} from "./types";

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
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private onRequestCallback: ((request: ToolRequest) => void) | null = null;
  private statusBarItem: vscode.StatusBarItem;
  private configStatus: "not-configured" | "configured" | "running" =
    "not-configured";

  constructor(private context: vscode.ExtensionContext) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.statusBarItem.command = "humanInTheLoop.showInstructions";
    context.subscriptions.push(this.statusBarItem);
  }

  /**
   * Get configuration status
   */
  public getConfigStatus(): "not-configured" | "configured" | "running" {
    return this.configStatus;
  }

  /**
   * Find the mcp.json file path in workspace
   */
  public getMcpJsonPath(): string | null {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return null;
    }
    return path.join(workspaceFolders[0].uri.fsPath, ".vscode", "mcp.json");
  }

  /**
   * Try to read port from workspace .vscode/mcp.json
   * Returns: { port: number, found: true } or { port: null, found: false, reason: string }
   */
  public getPortFromMcpJson():
    | { port: number; found: true }
    | { port: null; found: false; reason: string } {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      console.log("No workspace folders found");
      return { port: null, found: false, reason: "no-workspace" };
    }

    for (const folder of workspaceFolders) {
      const mcpJsonPath = path.join(folder.uri.fsPath, ".vscode", "mcp.json");
      console.log(`Checking for mcp.json at: ${mcpJsonPath}`);

      try {
        if (!fs.existsSync(mcpJsonPath)) {
          console.log(`mcp.json does not exist at ${mcpJsonPath}`);
          continue;
        }

        const content = fs.readFileSync(mcpJsonPath, "utf-8");
        console.log(`mcp.json content: ${content}`);

        const mcpConfig = JSON.parse(content);

        // Look for human-in-the-loop or interactive-m server configuration
        const servers = mcpConfig.servers || mcpConfig.mcpServers || {};
        console.log(`Found servers in mcp.json:`, Object.keys(servers));

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
            console.log(`Found server config for "${name}":`, server);

            // Check for direct port property
            if (server.port && typeof server.port === "number") {
              console.log(
                `Found port ${server.port} in mcp.json server "${name}"`,
              );
              return { port: server.port, found: true };
            }

            // Check for URL property
            if (server.url && typeof server.url === "string") {
              console.log(
                `Found URL "${server.url}" in mcp.json server "${name}"`,
              );
              const port = extractPortFromUrl(server.url);
              if (port) {
                console.log(
                  `Extracted port ${port} from URL in mcp.json server "${name}"`,
                );
                return { port, found: true };
              } else {
                console.log(`Failed to extract port from URL: ${server.url}`);
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
              console.log(
                `Extracted port ${port} from URL in mcp.json server "${name}"`,
              );
              return { port, found: true };
            }
          }
        }

        // mcp.json exists but no matching server config
        return { port: null, found: false, reason: "no-server-config" };
      } catch (error) {
        console.log(`Error reading mcp.json from ${mcpJsonPath}:`, error);
        return { port: null, found: false, reason: "parse-error" };
      }
    }

    return { port: null, found: false, reason: "no-mcp-json" };
  }

  /**
   * Create default mcp.json configuration
   */
  public async createDefaultConfig(port: number): Promise<boolean> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return false;
    }

    const vscodePath = path.join(workspaceFolders[0].uri.fsPath, ".vscode");
    const mcpJsonPath = path.join(vscodePath, "mcp.json");

    try {
      // Create .vscode directory if it doesn't exist
      if (!fs.existsSync(vscodePath)) {
        fs.mkdirSync(vscodePath, { recursive: true });
      }

      // Check if mcp.json already exists
      let existingConfig: any = { servers: {} };
      if (fs.existsSync(mcpJsonPath)) {
        try {
          const content = fs.readFileSync(mcpJsonPath, "utf-8");
          existingConfig = JSON.parse(content);
          if (!existingConfig.servers) {
            existingConfig.servers = {};
          }
        } catch {
          // If parsing fails, start fresh
          existingConfig = { servers: {} };
        }
      }

      // Add our server config
      existingConfig.servers["human-in-the-loop"] = {
        url: `http://127.0.0.1:${port}/mcp`,
      };

      // Write the config
      fs.writeFileSync(
        mcpJsonPath,
        JSON.stringify(existingConfig, null, 2),
        "utf-8",
      );
      console.log(`Created/updated mcp.json at ${mcpJsonPath}`);

      return true;
    } catch (error) {
      console.error("Failed to create mcp.json:", error);
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
   * Start the MCP server
   * Returns port number if started, or null if no config found
   */
  public async start(): Promise<number | null> {
    if (this.server) {
      await this.stop();
    }

    // Try to get port from workspace mcp.json
    const portResult = this.getPortFromMcpJson();

    if (!portResult.found) {
      console.log(`Cannot start server: ${portResult.reason}`);
      this.configStatus = "not-configured";
      this.updateStatusBar();
      return null;
    }

    const targetPort = portResult.port;
    console.log(`Using port from mcp.json: ${targetPort}`);
    this.configStatus = "configured";

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        console.error("MCP Server error:", error);
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

      this.server.listen(targetPort, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address === "object") {
          this.port = address.port;
          this.configStatus = "running";
          this.updateStatusBar();
          console.log(`MCP Server started on port ${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
    });
  }

  /**
   * Start with a specific port (used when creating new config)
   */
  public async startWithPort(port: number): Promise<number> {
    if (this.server) {
      await this.stop();
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error: NodeJS.ErrnoException) => {
        console.error("MCP Server error:", error);
        if (error.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(error);
        }
      });

      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server!.address();
        if (address && typeof address === "object") {
          this.port = address.port;
          this.configStatus = "running";
          this.updateStatusBar();
          console.log(`MCP Server started on port ${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
    });
  }

  /**
   * Stop the MCP server
   */
  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        // Cancel all pending requests
        for (const [id, pending] of this.pendingRequests) {
          if (pending.timeoutId) {
            clearTimeout(pending.timeoutId);
          }
          pending.resolve({
            id,
            success: false,
            error: "Server stopped",
          });
        }
        this.pendingRequests.clear();

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
   * Handle user response from WebView
   */
  public handleUserResponse(requestId: string, value: string | boolean): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      this.pendingRequests.delete(requestId);
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
        const response = await this.processJsonRpc(jsonRpcRequest);

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
  private async processJsonRpc(request: any): Promise<any> {
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
        case "tools/list":
          result = this.handleToolsList();
          break;
        case "tools/call":
          result = await this.handleToolCall(params);
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
  private async handleToolCall(params: any): Promise<any> {
    const { name, arguments: args } = params;

    const config = vscode.workspace.getConfiguration("humanInTheLoop");
    const timeout = config.get<number>("timeout", 120) * 1000;

    const requestId = generateId();
    let toolRequest: ToolRequest;

    switch (name) {
      case "ask_user_text":
        toolRequest = {
          id: requestId,
          type: "ask_user_text",
          title: args.title || "Input Required",
          message: args.prompt || args.message || "",
          placeholder: args.placeholder,
          timestamp: Date.now(),
        } as TextToolRequest;
        break;

      case "ask_user_confirm":
        toolRequest = {
          id: requestId,
          type: "ask_user_confirm",
          title: args.title || "Confirmation Required",
          message: args.message || "",
          timestamp: Date.now(),
        } as ConfirmToolRequest;
        break;

      case "ask_user_buttons":
        toolRequest = {
          id: requestId,
          type: "ask_user_buttons",
          title: args.title || "Selection Required",
          message: args.message || "",
          options: args.options || [],
          timestamp: Date.now(),
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
      const timeoutHandler = () => {
        this.pendingRequests.delete(requestId);
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

      this.pendingRequests.set(requestId, {
        request: toolRequest,
        resolve,
        reject,
        timeoutId,
        remainingTime: timeout,
        isPaused: false,
        startTime: Date.now(),
        totalTimeout: timeout,
      });
    });

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
        this.pendingRequests.delete(requestId);
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
