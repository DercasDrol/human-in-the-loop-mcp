/**
 * Human in the Loop MCP Extension
 *
 * This extension provides MCP tools for human-in-the-loop interactions
 * with any AI agent that supports the Model Context Protocol (MCP).
 */

import * as vscode from "vscode";
import { MCPServer } from "./mcpServer";
import { HumanInTheLoopViewProvider } from "./webviewProvider";

let mcpServer: MCPServer | null = null;
let viewProvider: HumanInTheLoopViewProvider | null = null;
let fileWatcher: vscode.FileSystemWatcher | null = null;

/**
 * Activate the extension
 */
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  console.log("Human in the Loop MCP extension is now active");

  // Create MCP server
  mcpServer = new MCPServer(context);

  // Create and register webview provider
  viewProvider = new HumanInTheLoopViewProvider(
    context.extensionUri,
    mcpServer,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      HumanInTheLoopViewProvider.viewType,
      viewProvider,
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("humanInTheLoop.showInstructions", () => {
      showConnectionInstructions();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "humanInTheLoop.restartServer",
      async () => {
        await restartServer();
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "humanInTheLoop.configureServer",
      async () => {
        await configureServer();
      },
    ),
  );

  // Watch for mcp.json changes
  setupFileWatcher(context);

  // Try to start the server
  await tryStartServer();
}

/**
 * Setup file watcher for mcp.json
 */
function setupFileWatcher(context: vscode.ExtensionContext): void {
  // Watch for mcp.json in any .vscode folder
  fileWatcher = vscode.workspace.createFileSystemWatcher("**/.vscode/mcp.json");

  fileWatcher.onDidCreate(async () => {
    console.log("mcp.json created, attempting to start server");
    await tryStartServer();
  });

  fileWatcher.onDidChange(async () => {
    console.log("mcp.json changed, restarting server");
    await restartServer();
  });

  fileWatcher.onDidDelete(async () => {
    console.log("mcp.json deleted, stopping server");
    if (mcpServer) {
      await mcpServer.stop();
      // Update WebView to show server stopped
      if (viewProvider) {
        viewProvider.updateServerInfo();
      }
      vscode.window
        .showWarningMessage(
          "MCP configuration deleted. Server stopped.",
          "Configure Now",
        )
        .then((selection) => {
          if (selection === "Configure Now") {
            configureServer();
          }
        });
    }
  });

  context.subscriptions.push(fileWatcher);
}

/**
 * Try to start the server if configured
 */
async function tryStartServer(): Promise<void> {
  if (!mcpServer) {
    return;
  }

  try {
    const port = await mcpServer.start();

    if (port === null) {
      // No configuration found - offer to create one
      const selection = await vscode.window.showWarningMessage(
        "Human in the Loop MCP: No configuration found in .vscode/mcp.json",
        "Configure Now",
        "Later",
      );

      if (selection === "Configure Now") {
        await configureServer();
      }
    } else {
      vscode.window.showInformationMessage(
        `Human in the Loop MCP server started on port ${port}`,
      );
      // Update WebView with server info
      if (viewProvider) {
        viewProvider.updateServerInfo();
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    vscode.window.showErrorMessage(`Failed to start MCP server: ${message}`);
  }

  // Update WebView status even on failure
  if (viewProvider) {
    viewProvider.updateServerInfo();
  }
}

/**
 * Configure the MCP server
 */
async function configureServer(): Promise<void> {
  if (!mcpServer) {
    return;
  }

  // Check if workspace is available
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      "Please open a folder or workspace to configure the MCP server.",
    );
    return;
  }

  // Ask user for port
  const portInput = await vscode.window.showInputBox({
    prompt: "Enter the port number for the MCP server",
    value: "3847",
    validateInput: (value) => {
      const port = parseInt(value, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        return "Please enter a valid port number between 1024 and 65535";
      }
      return null;
    },
  });

  if (!portInput) {
    return; // User cancelled
  }

  const port = parseInt(portInput, 10);

  // Create the configuration
  const success = await mcpServer.createDefaultConfig(port);

  if (success) {
    vscode.window.showInformationMessage(
      `MCP configuration created with port ${port}. Starting server...`,
    );

    // Start the server with the configured port
    try {
      await mcpServer.startWithPort(port);
      vscode.window.showInformationMessage(
        `Human in the Loop MCP server started on port ${port}`,
      );
      // Update WebView with server info
      if (viewProvider) {
        viewProvider.updateServerInfo();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(`Failed to start MCP server: ${message}`);
    }
  } else {
    vscode.window.showErrorMessage("Failed to create MCP configuration");
  }

  // Update WebView status
  if (viewProvider) {
    viewProvider.updateServerInfo();
  }
}

/**
 * Deactivate the extension
 */
export async function deactivate(): Promise<void> {
  console.log("Human in the Loop MCP extension is now deactivated");

  if (mcpServer) {
    await mcpServer.stop();
    mcpServer = null;
  }
}

/**
 * Restart the MCP server
 */
async function restartServer(): Promise<void> {
  if (mcpServer) {
    await mcpServer.stop();
    // Update WebView immediately to show stopping status
    if (viewProvider) {
      viewProvider.updateServerInfo();
    }

    try {
      const port = await mcpServer.start();
      if (port !== null) {
        vscode.window.showInformationMessage(
          `MCP server restarted on port ${port}`,
        );
        // Update WebView with new server info
        if (viewProvider) {
          viewProvider.updateServerInfo();
        }
      } else {
        const selection = await vscode.window.showWarningMessage(
          "No MCP configuration found",
          "Configure Now",
        );
        if (selection === "Configure Now") {
          await configureServer();
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      vscode.window.showErrorMessage(
        `Failed to restart MCP server: ${message}`,
      );
    }

    // Update WebView status after restart attempt
    if (viewProvider) {
      viewProvider.updateServerInfo();
    }
  }
}

/**
 * Show connection instructions
 */
function showConnectionInstructions(): void {
  if (!mcpServer) {
    vscode.window.showErrorMessage("MCP server is not initialized");
    return;
  }

  const status = mcpServer.getConfigStatus();

  if (status === "not-configured") {
    // Offer to configure
    vscode.window
      .showWarningMessage(
        "MCP server is not configured. Would you like to configure it now?",
        "Configure Now",
        "Later",
      )
      .then((selection) => {
        if (selection === "Configure Now") {
          configureServer();
        }
      });
    return;
  }

  const port = mcpServer.getPort();
  const url = mcpServer.getUrl();

  const message = `
# Human in the Loop MCP Connection Instructions

## Server URL
\`${url}\`

## Configuration for MCP-Compatible Agents

Add to your \`.vscode/mcp.json\`:

\`\`\`json
{
  "servers": {
    "human-in-the-loop": {
      "url": "${url}"
    }
  }
}
\`\`\`

## Available Tools

- **ask_user_text**: Request text input from user
- **ask_user_confirm**: Request yes/no confirmation
- **ask_user_buttons**: Show multiple choice options

## Settings

- Timeout: Configure in Settings > Human in the Loop > Timeout
`;

  // Show as markdown preview
  const panel = vscode.window.createWebviewPanel(
    "humanInTheLoopInstructions",
    "Human in the Loop - Connection Instructions",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      enableCommandUris: true,
    },
  );

  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Connection Instructions</title>
    <style>
        body {
            padding: 20px;
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 {
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-widget-border);
            padding-bottom: 10px;
        }
        h2 {
            color: var(--vscode-foreground);
            margin-top: 24px;
        }
        h3 {
            color: var(--vscode-foreground);
            margin-top: 16px;
            margin-bottom: 8px;
        }
        code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 16px;
            border-radius: 4px;
            overflow-x: auto;
        }
        pre code {
            padding: 0;
            background: none;
        }
        ul {
            padding-left: 24px;
        }
        li {
            margin: 8px 0;
        }
        strong {
            color: var(--vscode-textLink-foreground);
        }
        a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
            cursor: pointer;
        }
        a:hover {
            text-decoration: underline;
        }
        .settings-link {
            display: inline-block;
            padding: 4px 8px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 4px;
            margin: 4px 0;
        }
        .settings-link:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
            text-decoration: none;
        }
        .all-settings {
            margin-top: 16px;
            padding: 12px;
            background-color: var(--vscode-textBlockQuote-background);
            border-radius: 4px;
        }
        .concept-box {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 12px 16px;
            margin: 16px 0;
            border-radius: 0 4px 4px 0;
        }
        .tool-card {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 12px 16px;
            margin: 12px 0;
            border-radius: 4px;
        }
        .tool-card h3 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
        }
        .tool-card p {
            margin: 4px 0;
        }
    </style>
</head>
<body>
    <h1>🔗 Human in the Loop MCP</h1>
    
    <div class="concept-box">
        <strong>What is Human in the Loop?</strong><br>
        A pattern where AI agents can pause execution to request human input, verification, or decision-making. 
        This keeps humans informed and in control of AI actions.
    </div>
    
    <h2>🌐 Server URL</h2>
    <p><code>${url}</code></p>
    
    <h2>⚙️ Configuration</h2>
    <p>Add to your <code>.vscode/mcp.json</code>:</p>
    <pre><code>{
  "servers": {
    "human-in-the-loop": {
      "url": "${url}"
    }
  }
}</code></pre>
    
    <h2>🛠️ Available Tools</h2>
    
    <div class="tool-card">
        <h3>ask_user_text</h3>
        <p><strong>Purpose:</strong> Request free-form text input from the user</p>
        <p><strong>Use for:</strong> API keys, file paths, names, descriptions, clarifications</p>
        <p><strong>Parameters:</strong> title, prompt (Markdown), placeholder (optional)</p>
    </div>
    
    <div class="tool-card">
        <h3>ask_user_confirm</h3>
        <p><strong>Purpose:</strong> Request Yes/No confirmation with optional custom response</p>
        <p><strong>Use for:</strong> Destructive operations, permission requests, verification</p>
        <p><strong>Parameters:</strong> title, message (Markdown)</p>
    </div>
    
    <div class="tool-card">
        <h3>ask_user_buttons</h3>
        <p><strong>Purpose:</strong> Present multiple options for user selection</p>
        <p><strong>Use for:</strong> Language selection, action menus, configuration choices</p>
        <p><strong>Parameters:</strong> title, message (Markdown), options (array of {label, value})</p>
    </div>
    
    <h2>⚡ Settings</h2>
    <ul>
        <li><a class="settings-link" href="command:workbench.action.openSettings?%22humanInTheLoop.timeout%22">⏱️ Timeout</a> - Time to wait for user response (default: 120s)</li>
        <li><a class="settings-link" href="command:workbench.action.openSettings?%22humanInTheLoop.autoSubmitOnTimeout%22">📤 Auto Submit</a> - Auto-send current input when timer expires</li>
        <li><a class="settings-link" href="command:workbench.action.openSettings?%22humanInTheLoop.soundEnabled%22">🔔 Sound</a> - Play sound on new messages</li>
        <li><a class="settings-link" href="command:workbench.action.openSettings?%22humanInTheLoop.soundVolume%22">🔊 Volume</a> - Notification volume (0.0 - 1.0)</li>
        <li><a class="settings-link" href="command:workbench.action.openSettings?%22humanInTheLoop.soundType%22">🎵 Sound Type</a> - Choose notification sound style</li>
    </ul>
    
    <div class="all-settings">
        <a href="command:workbench.action.openSettings?%22humanInTheLoop%22">⚙️ Open All Human in the Loop Settings</a>
    </div>
    
    <h2>🔒 Privacy</h2>
    <p>This extension runs entirely locally. No telemetry, no external connections. All communication stays between VS Code and your AI agent.</p>
    
    <h2>📖 Compatibility</h2>
    <p>Works with any AI agent or tool that supports the <strong>Model Context Protocol (MCP)</strong>.</p>
</body>
</html>`;
}
