/**
 * Logger utility for Human in the Loop extension
 * Provides conditional logging based on extension settings
 */

import * as vscode from "vscode";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Logger class that respects the enableLogging setting
 */
export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel(
      "Human in the Loop MCP",
    );
  }

  /**
   * Get the singleton Logger instance
   */
  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  /**
   * Check if logging is enabled in settings
   */
  private isLoggingEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("humanInTheLoop");
    return config.get<boolean>("enableLogging", false);
  }

  /**
   * Get timestamp for log entry
   */
  private getTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Format log message with timestamp and level
   */
  private formatMessage(level: string, message: string): string {
    return `[${this.getTimestamp()}] [${level}] ${message}`;
  }

  /**
   * Log debug message (only when logging enabled)
   */
  public debug(message: string, ...args: any[]): void {
    if (this.isLoggingEnabled()) {
      const formatted = this.formatMessage("DEBUG", message);
      this.outputChannel.appendLine(
        args.length > 0 ? `${formatted} ${JSON.stringify(args)}` : formatted,
      );
    }
  }

  /**
   * Log info message (only when logging enabled)
   */
  public info(message: string, ...args: any[]): void {
    if (this.isLoggingEnabled()) {
      const formatted = this.formatMessage("INFO", message);
      this.outputChannel.appendLine(
        args.length > 0 ? `${formatted} ${JSON.stringify(args)}` : formatted,
      );
    }
  }

  /**
   * Log warning message (always logged)
   */
  public warn(message: string, ...args: any[]): void {
    const formatted = this.formatMessage("WARN", message);
    this.outputChannel.appendLine(
      args.length > 0 ? `${formatted} ${JSON.stringify(args)}` : formatted,
    );
    console.warn(`[Human in the Loop] ${message}`, ...args);
  }

  /**
   * Log error message (always logged)
   */
  public error(message: string, error?: Error | unknown, ...args: any[]): void {
    const errorDetails =
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : error
          ? JSON.stringify(error)
          : "";
    const formatted = this.formatMessage("ERROR", `${message} ${errorDetails}`);
    this.outputChannel.appendLine(
      args.length > 0 ? `${formatted} ${JSON.stringify(args)}` : formatted,
    );
    console.error(`[Human in the Loop] ${message}`, error, ...args);
  }

  /**
   * Log MCP protocol message (only when logging enabled)
   */
  public mcp(direction: "IN" | "OUT", data: any): void {
    if (this.isLoggingEnabled()) {
      const formatted = this.formatMessage(
        `MCP ${direction}`,
        JSON.stringify(data),
      );
      this.outputChannel.appendLine(formatted);
    }
  }

  /**
   * Log server event (only when logging enabled)
   */
  public server(event: string, details?: string): void {
    if (this.isLoggingEnabled()) {
      const message = details ? `${event}: ${details}` : event;
      const formatted = this.formatMessage("SERVER", message);
      this.outputChannel.appendLine(formatted);
    }
  }

  /**
   * Log request lifecycle event (only when logging enabled)
   */
  public request(
    requestId: string,
    event: string,
    details?: Record<string, any>,
  ): void {
    if (this.isLoggingEnabled()) {
      const message = details
        ? `[${requestId}] ${event}: ${JSON.stringify(details)}`
        : `[${requestId}] ${event}`;
      const formatted = this.formatMessage("REQUEST", message);
      this.outputChannel.appendLine(formatted);
    }
  }

  /**
   * Log UI event (only when logging enabled)
   */
  public ui(event: string, details?: Record<string, any>): void {
    if (this.isLoggingEnabled()) {
      const message = details ? `${event}: ${JSON.stringify(details)}` : event;
      const formatted = this.formatMessage("UI", message);
      this.outputChannel.appendLine(formatted);
    }
  }

  /**
   * Show the output channel
   */
  public show(): void {
    this.outputChannel.show();
  }

  /**
   * Dispose the output channel
   */
  public dispose(): void {
    this.outputChannel.dispose();
  }
}

// Export singleton instance getter
export const getLogger = (): Logger => Logger.getInstance();
