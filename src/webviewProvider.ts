/**
 * WebView Provider for Human in the Loop extension
 * Displays agent messages and handles user responses
 */

import * as vscode from "vscode";
import {
  ToolRequest,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from "./types";
import { MCPServer } from "./mcpServer";
import { renderMarkdown } from "./markdownRenderer";

export class HumanInTheLoopViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "humanInTheLoop.mainView";

  private _view?: vscode.WebviewView;
  private currentRequest: ToolRequest | null = null;
  private countdownInterval: NodeJS.Timeout | null = null;
  private isPaused: boolean = false;
  private currentCountdown: number = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly mcpServer: MCPServer,
  ) {
    // Set up request handler
    this.mcpServer.onRequest((request) => {
      this.showRequest(request);
    });
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
        if (this.currentRequest) {
          this.sendRequest(this.currentRequest);
        }
      }
    });
  }

  /**
   * Handle messages from the webview
   */
  private handleWebviewMessage(message: WebviewToExtensionMessage): void {
    switch (message.type) {
      case "ready":
        this.sendServerInfo();
        this.sendSettings();
        if (this.currentRequest) {
          this.sendRequest(this.currentRequest);
        }
        break;

      case "response":
        if (message.requestId && message.value !== undefined) {
          this.mcpServer.handleUserResponse(message.requestId, message.value);
          this.clearRequest();
        }
        break;

      case "togglePause":
        this.togglePause();
        break;
    }
  }

  /**
   * Toggle pause state of countdown timer
   */
  private togglePause(): void {
    if (!this.currentRequest) {
      return;
    }

    // Toggle pause on the MCP server (affects real timeout)
    const newPauseState = this.mcpServer.togglePauseRequest(
      this.currentRequest.id,
    );
    if (newPauseState !== undefined) {
      this.isPaused = newPauseState;
    }

    // Notify webview of pause state
    this._view?.webview.postMessage({
      type: "pauseState",
      isPaused: this.isPaused,
    });
  }

  /**
   * Show a new request in the webview
   */
  public showRequest(request: ToolRequest): void {
    this.currentRequest = request;

    // Start countdown
    this.startCountdown();

    // Show the view
    if (this._view) {
      this._view.show?.(true);
      this.sendRequest(request);
      this.playNotificationSound();
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
   * Send request to webview
   */
  private sendRequest(request: ToolRequest): void {
    if (this._view) {
      const config = vscode.workspace.getConfiguration("humanInTheLoop");
      const timeout = config.get<number>("timeout", 120);

      // Pre-render markdown on extension side for security
      const messageHtml = renderMarkdown(request.message);

      const message: ExtensionToWebviewMessage = {
        type: "newRequest",
        request,
        messageHtml,
        countdown: timeout,
      };
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Clear the current request
   */
  private clearRequest(): void {
    this.currentRequest = null;
    this.stopCountdown();

    if (this._view) {
      const message: ExtensionToWebviewMessage = {
        type: "clearRequest",
      };
      this._view.webview.postMessage(message);
    }
  }

  /**
   * Start countdown timer
   */
  private startCountdown(): void {
    this.stopCountdown();
    this.isPaused = false; // Reset pause state on new request

    const config = vscode.workspace.getConfiguration("humanInTheLoop");
    this.currentCountdown = config.get<number>("timeout", 120);

    // If timeout is 0, don't run countdown (infinite timeout)
    if (this.currentCountdown <= 0) {
      return;
    }

    this.countdownInterval = setInterval(() => {
      // Skip countdown decrement if paused
      if (this.isPaused) {
        return;
      }

      this.currentCountdown--;
      if (this.currentCountdown <= 0) {
        this.stopCountdown();
        this.clearRequest();
      } else if (this._view) {
        const message: ExtensionToWebviewMessage = {
          type: "updateCountdown",
          countdown: this.currentCountdown,
        };
        this._view.webview.postMessage(message);
      }
    }, 1000);
  }

  /**
   * Stop countdown timer
   */
  private stopCountdown(): void {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
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
        }

        .server-info {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }

        .countdown {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: bold;
        }

        .countdown-timer {
            color: var(--vscode-charts-yellow);
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
            height: 4px;
            background-color: var(--vscode-progressBar-background);
            border-radius: 2px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background-color: var(--vscode-progressBar-background);
            transition: width 1s linear;
        }

        .progress-fill.paused {
            background-color: var(--vscode-descriptionForeground) !important;
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
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <span class="server-info" id="serverInfo">Server: Not started</span>
            <div class="countdown" id="countdownContainer" style="display: none;">
                <span>⏱️</span>
                <span class="countdown-timer" id="countdownTimer" role="timer" aria-label="Time remaining" aria-live="polite">120s</span>
                <button id="pauseBtn" class="icon-btn pause-btn" title="Pause timer" aria-label="Pause timer">⏸️</button>
            </div>
        </div>
        
        <div class="progress-bar" id="progressBar" style="display: none;">
            <div class="progress-fill" id="progressFill"></div>
        </div>

        <div class="request-container" id="requestContainer">
            <div class="title-row">
                <h2 class="title" id="requestTitle"></h2>
                <button id="copyMessageBtn" class="icon-btn" title="Copy message" aria-label="Copy message to clipboard">📋</button>
            </div>
            <div class="message" id="requestMessage"></div>
            
            <div class="input-container" id="textInputContainer" style="display: none;">
                <textarea id="textInput" placeholder="Enter your response..." aria-label="Your response"></textarea>
                <button id="submitTextBtn" class="primary" aria-label="Submit response">Submit</button>
            </div>

            <div class="confirm-buttons" id="confirmContainer" style="display: none;">
                <button id="yesBtn" class="primary" aria-label="Confirm yes">Yes</button>
                <button id="noBtn" class="secondary" aria-label="Confirm no">No</button>
                <div class="custom-input-toggle">
                    <button id="confirmCustomToggle" class="toggle-btn" title="Send custom response" aria-label="Toggle custom response input">✏️ Custom response</button>
                </div>
                <div class="custom-input-row" id="confirmCustomInput" style="display: none;">
                    <input type="text" id="confirmCustomText" placeholder="Type custom response..." aria-label="Custom response text">
                    <button id="confirmCustomSend" class="primary" aria-label="Send custom response">Send</button>
                </div>
            </div>

            <div class="button-container" id="buttonsContainer" style="display: none;" role="group" aria-label="Response options">
            </div>
            
            <div class="custom-input-toggle" id="buttonsCustomToggle" style="display: none;">
                <button id="buttonsToggleBtn" class="toggle-btn" title="Send custom response" aria-label="Toggle custom response input">✏️ Custom response</button>
            </div>
            <div class="custom-input-row" id="buttonsCustomInput" style="display: none;">
                <input type="text" id="buttonsCustomText" placeholder="Type custom response..." aria-label="Custom response text">
                <button id="buttonsCustomSend" class="primary" aria-label="Send custom response">Send</button>
            </div>
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
            const countdownContainer = document.getElementById('countdownContainer');
            const countdownTimer = document.getElementById('countdownTimer');
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

            let currentRequestId = null;
            let totalTimeout = 120;
            let currentRequestType = null;
            let currentMessageText = ''; // Store original message text for copying
            let isPaused = false; // Timer pause state
            let settings = {
                autoSubmitOnTimeout: false,
                soundEnabled: true,
                soundVolume: 0.5,
                soundType: 'default'
            };

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
            function getCurrentInputValue() {
                switch (currentRequestType) {
                    case 'ask_user_text':
                        return textInput.value.trim();
                    case 'ask_user_confirm':
                        const customConfirm = confirmCustomText.value.trim();
                        return customConfirm || null;
                    case 'ask_user_buttons':
                        const customBtn = buttonsCustomText.value.trim();
                        return customBtn || null;
                    default:
                        return null;
                }
            }

            // Auto-submit on timeout
            function handleAutoSubmit() {
                if (!settings.autoSubmitOnTimeout || !currentRequestId) {
                    return;
                }
                
                const value = getCurrentInputValue();
                if (value !== null && value !== '') {
                    sendResponse(value);
                }
            }

            // NOTE: Markdown rendering is now done on extension side using marked.js + DOMPurify
            // for better security and full markdown support. See markdownRenderer.ts

            // Show request
            function showRequest(request, countdown, messageHtml) {
                currentRequestId = request.id;
                currentRequestType = request.type;
                totalTimeout = countdown;
                currentMessageText = request.message; // Store for copy function

                requestTitle.textContent = request.title;
                // Use pre-rendered HTML from extension (marked + DOMPurify)
                requestMessage.innerHTML = messageHtml || request.message;

                // Hide all input types and custom inputs
                textInputContainer.style.display = 'none';
                confirmContainer.style.display = 'none';
                confirmCustomInput.style.display = 'none';
                buttonsContainer.style.display = 'none';
                buttonsCustomInput.style.display = 'none';
                buttonsCustomToggle.style.display = 'none';
                buttonsContainer.innerHTML = '';

                // Show appropriate input
                switch (request.type) {
                    case 'ask_user_text':
                        textInputContainer.style.display = 'flex';
                        textInput.placeholder = request.placeholder || 'Enter your response...';
                        textInput.value = '';
                        textInput.focus();
                        break;

                    case 'ask_user_confirm':
                        confirmContainer.style.display = 'flex';
                        confirmCustomText.value = '';
                        break;

                    case 'ask_user_buttons':
                        buttonsContainer.style.display = 'flex';
                        buttonsCustomToggle.style.display = 'block';
                        buttonsCustomText.value = '';
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
                
                // Hide countdown and progress bar for infinite timeout (countdown <= 0)
                if (countdown > 0) {
                    countdownContainer.style.display = 'flex';
                    progressBar.style.display = 'block';
                    updateCountdown(countdown);
                } else {
                    // Infinite timeout - hide timer UI
                    countdownContainer.style.display = 'none';
                    progressBar.style.display = 'none';
                }
            }

            // Format seconds as mm:ss or just seconds
            function formatTime(seconds) {
                if (seconds >= 60) {
                    const mins = Math.floor(seconds / 60);
                    const secs = seconds % 60;
                    return mins + ':' + (secs < 10 ? '0' : '') + secs;
                }
                return seconds + 's';
            }

            // Update countdown
            function updateCountdown(seconds) {
                countdownTimer.textContent = formatTime(seconds);
                
                // Check for auto-submit when countdown reaches 1
                if (seconds <= 1 && settings.autoSubmitOnTimeout) {
                    handleAutoSubmit();
                }
                
                // Update styling based on time left
                countdownTimer.classList.remove('warning', 'critical');
                if (seconds <= 10) {
                    countdownTimer.classList.add('critical');
                } else if (seconds <= 30) {
                    countdownTimer.classList.add('warning');
                }

                // Update progress bar
                const percentage = (seconds / totalTimeout) * 100;
                progressFill.style.width = percentage + '%';
                
                // Change color based on time
                if (seconds <= 10) {
                    progressFill.style.backgroundColor = 'var(--vscode-errorForeground)';
                } else if (seconds <= 30) {
                    progressFill.style.backgroundColor = 'var(--vscode-charts-orange)';
                } else {
                    progressFill.style.backgroundColor = 'var(--vscode-progressBar-background)';
                }
            }

            // Clear request
            function clearRequest() {
                currentRequestId = null;
                requestContainer.classList.remove('visible');
                emptyState.style.display = 'flex';
                countdownContainer.style.display = 'none';
                progressBar.style.display = 'none';
            }

            // Send response
            function sendResponse(value) {
                if (currentRequestId) {
                    vscode.postMessage({
                        type: 'response',
                        requestId: currentRequestId,
                        value: value
                    });
                }
            }

            // Update pause button appearance
            function updatePauseButton() {
                if (isPaused) {
                    pauseBtn.textContent = '▶️';
                    pauseBtn.title = 'Resume timer';
                    pauseBtn.setAttribute('aria-label', 'Resume timer');
                    pauseBtn.classList.add('paused');
                    countdownTimer.classList.add('paused');
                    progressFill.classList.add('paused');
                } else {
                    pauseBtn.textContent = '⏸️';
                    pauseBtn.title = 'Pause timer';
                    pauseBtn.setAttribute('aria-label', 'Pause timer');
                    pauseBtn.classList.remove('paused');
                    countdownTimer.classList.remove('paused');
                    progressFill.classList.remove('paused');
                }
            }

            // Event listeners
            
            // Pause/Resume timer button
            pauseBtn.addEventListener('click', () => {
                vscode.postMessage({
                    type: 'togglePause'
                });
            });
            
            // Copy message button
            copyMessageBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(currentMessageText);
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
                if (e.key === 'Enter' && !e.shiftKey) {
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
                if (e.key === 'Enter') {
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
                if (e.key === 'Enter') {
                    e.preventDefault();
                    const value = buttonsCustomText.value.trim();
                    if (value) {
                        sendResponse(value);
                    }
                }
            });

            // Handle messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                
                switch (message.type) {
                    case 'newRequest':
                        isPaused = false; // Reset pause state on new request
                        updatePauseButton();
                        showRequest(message.request, message.countdown, message.messageHtml);
                        break;

                    case 'updateCountdown':
                        // Only update if not paused (extension handles actual pause)
                        updateCountdown(message.countdown);
                        break;

                    case 'clearRequest':
                        isPaused = false;
                        updatePauseButton();
                        clearRequest();
                        break;

                    case 'pauseState':
                        isPaused = message.isPaused;
                        updatePauseButton();
                        break;

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
