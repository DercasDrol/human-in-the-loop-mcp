# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.28] - 2025-01-25

### Security

- **Input validation for MCP tool parameters** 🛡️
  - Added `validateString()` function with length limits (titles: 200 chars, messages: 50000 chars)
  - Added `validateOptions()` function with max 50 button options to prevent UI freeze
  - Malformed or oversized inputs now return clean error messages
  - Prevents potential memory exhaustion attacks

- **Fixed server start/stop race condition**
  - Added `serverOperationLock` to serialize start/stop operations
  - Prevents undefined behavior when rapidly starting/stopping server
  - Refactored to use internal `_startInternal()`, `_stopInternal()`, `_startWithPortInternal()` methods

- **Fixed cancellation retry timer leak**
  - Added `cancellationRetryTimers` Map to track pending retry timers
  - Timers are now properly cleaned up on successful cancellation or max retries
  - Added `clearCancellationRetryTimers()` and `clearAllCancellationRetryTimers()` methods

- **Added proper dispose for WebviewProvider**
  - Cleans up countdown interval and all pending timers
  - Registered in extension.ts subscriptions for proper cleanup on deactivation

### Technical

- Constants: `MAX_TITLE_LENGTH=200`, `MAX_MESSAGE_LENGTH=50000`, `MAX_OPTIONS_COUNT=50`
- Lock pattern: `async start() { await lock; lock = this._startInternal(); }`
- Timer tracking: `cancellationRetryTimers: Map<string, NodeJS.Timeout[]>`

## [1.0.27] - 2025-01-25

### Added

- **Configurable logging system** 📝
  - New `humanInTheLoop.enableLogging` setting to enable detailed debugging
  - Logs appear in Output panel → "Human in the Loop MCP"
  - Structured logging with timestamps and categories (MCP, SERVER, REQUEST, UI)
  - Errors and warnings always logged regardless of setting

### Changed

- **Replaced all console.log with Logger utility**
  - Clean console output by default (no spam)
  - Full debug info available when `enableLogging: true`
  - MCP protocol messages logged with `logger.mcp("IN"/"OUT", data)`
  - Request lifecycle logged with `logger.request(id, event, details)`
  - UI events logged with `logger.ui(event, details)`

### Technical

- Created `Logger` singleton class (`src/logger.ts`)
- Logger categories: `debug`, `info`, `warn`, `error`, `mcp`, `server`, `request`, `ui`
- Logging respects `humanInTheLoop.enableLogging` configuration
- `warn` and `error` always output to both Output panel and console

## [1.0.26] - 2025-01-25

### Fixed

- **Critical: Agent cancellation detection now works correctly** 🎯
  - **Root cause identified**: Copilot sends `notifications/cancelled` with JSON-RPC request id (e.g., `3`), but we were looking up requests by internal UUID
  - **Solution**: Added mapping from JSON-RPC request id to internal request id
  - When agent stops, UI now correctly shows cancellation message instead of staying stuck
  - Panel clears properly after 5 seconds allowing for new requests

### Technical

- Added `jsonRpcIdToRequestId: Map<string | number, string>` for id translation
- Added `jsonRpcId` field to `PendingRequest` interface for reverse lookup
- Modified `handleToolCall()` to accept and store JSON-RPC id
- Modified `handleCancellation()` to lookup internal id from JSON-RPC id
- Created `deletePendingRequest()` helper method for consistent cleanup
- All pending request deletions now properly clean up both maps

## [1.0.25] - 2025-01-24

### Added

- **Debug logging for MCP messages** 🔍
  - Added logging of all incoming JSON-RPC requests and responses
  - Helps diagnose agent communication issues
  - Logs include `[MCP] Received:` and `[MCP] Response:` prefixes

## [1.0.24] - 2025-01-24

### Added

- **MCP protocol cancellation support** 🛑
  - Added handler for `notifications/cancelled` JSON-RPC method
  - Follows MCP specification for proper cancellation handling
  - Records cancellation reason in history

## [1.0.23] - 2025-01-24

### Fixed

- **Removed false-positive disconnect detection** 🔧
  - Removed problematic socket events (`close`, `end`, `setTimeout`) that fired immediately
  - Kept only reliable detection: `socket.on('error')` and polling for `socket.destroyed`/`socket.writable`
  - No more "Agent disconnected" errors while agent is still running

## [1.0.22] - 2025-01-24

### Fixed

- **Race condition in cancellation handling** ⚡
  - Added retry mechanism (5 attempts × 100ms) for cancellation events
  - Fixes case where cancellation arrives before currentRequest is set
  - Prevents stuck UI when agent stops during request setup

## [1.0.21] - 2025-01-24

### Added

- **Aggressive disconnect detection** (reverted in 1.0.23)
  - Added socket timeout and multiple event listeners
  - Caused false positives - immediate "Agent disconnected" errors

## [1.0.20] - 2025-01-24

### Fixed

- **Removed duplicate History/Instructions buttons** 🧹
  - Removed old-style span buttons, kept only new button-style elements
  - Clean UI with single set of header buttons

### Added

- **Initial disconnect detection attempt**
  - Added `socket.setKeepAlive` for TCP keep-alive probes
  - Added extended polling checks for socket state

## [1.0.18] - 2026-01-24

### Fixed

- **Improved agent disconnect detection** 🔌
  - Added multiple socket event listeners: `close`, `error`, `timeout`
  - Added `disconnected` flag to prevent duplicate handling
  - Now listens to both response and socket events for reliable detection
  - Error messages now include disconnect source for debugging

### Technical

- Added `handleDisconnect(source)` function with single-fire protection
- Added `socket.on('close')`, `socket.on('error')`, `socket.on('timeout')` handlers
- History now records which event triggered the disconnect

## [1.0.17] - 2026-01-24

### Fixed

- **Timer synchronization completely rewritten** ⏱️
  - Added local countdown timer in webview that calculates remaining time directly from `serverEndTime`
  - Timer updates every 500ms for accuracy (twice per second)
  - UI now shows exactly when server will timeout (no more 2-second drift)
  - Extension-side timer still runs as backup, webview uses its own calculation
  - Initial countdown value is now calculated, not taken from config

### Technical

- Added `serverEndTime` to `ExtensionToWebviewMessage`
- Added `localCountdownInterval` in webview JS
- Added `startLocalCountdown()` and `stopLocalCountdown()` functions
- Webview calculates: `remaining = Math.ceil((serverEndTime - Date.now()) / 1000)`
- `sendRequest()` now calculates and sends initial countdown from serverEndTime

## [1.0.16] - 2026-01-24

### Added

- **Options/buttons display in history** 📋
  - Expanded history entries now show all available options/buttons
  - Selected option is highlighted with a checkmark
  - For confirm dialogs, shows "✓ Yes" / "✗ No" buttons
  - Response preview shows the selected option label, not raw value

### Fixed

- **Timer synchronization between UI and server** ⏱️
  - Server now sends absolute `serverEndTime` timestamp
  - UI calculates remaining time from server's end timestamp
  - Eliminates drift caused by network latency and processing delays
  - Timer now accurately reflects when server will actually timeout

### Technical

- Added `serverEndTime` field to `BaseToolRequest` type
- Server calculates `serverEndTime = Date.now() + timeout` at request creation
- UI countdown uses `serverEndTime - Date.now()` for accurate sync
- Added `renderOptions()` and `formatResponse()` helper methods in history view
- Added CSS styles for `.options-section`, `.options-list`, `.option-btn`, `.option-btn.selected`

## [1.0.15] - 2026-01-24

### Fixed

- **Critical: Agent connection no longer breaks immediately** 🐛
  - **Root cause identified**: Was listening to `req.on('close')` (request stream) which fires when client finishes _sending_ the request, not when client _disconnects_
  - **Solution**: Now using `res.on('close')` (response stream) with `writableFinished` check
  - This correctly detects when client disconnects BEFORE we send our response
  - Agent can now send multiple requests without false "agent disconnected" errors

### Technical

- Passed `httpRes` (ServerResponse) through `processJsonRpc` → `handleToolCall` chain
- Changed close event listener from `httpReq.on('close')` to `httpRes.on('close')`
- Added `httpRes.writableFinished` check to distinguish normal completion from premature disconnect
- Removed unnecessary `resolved` flag wrapper

## [1.0.14] - 2026-01-24

### Added

- **Request History** 📜
  - New "Show Request History" command and button
  - Tracks all agent requests with timestamps
  - Records response time, duration, and status
  - Supports status filtering: pending, answered, timeout, cancelled
  - Persisted in workspace-specific globalState (survives restarts)
  - Maximum 100 entries per workspace (FIFO)
  - Real-time updates when history panel is open
  - Clear history button

- **Expand/Collapse messages in history** 📖
  - Each history entry has an "Expand" button
  - Expand to see full message text and full response
  - Collapse back to preview mode
  - Animated arrow indicator

- **Header action buttons** 🎛️
  - Added "📋 Instructions" button in panel header
  - Added "📜 History" button in panel header
  - Buttons styled consistently with VS Code theme

### Fixed

- **Critical bug: Agent connection no longer breaks immediately** 🐛
  - Fixed HTTP close event handler that was incorrectly firing on normal response completion
  - Added `resolved` flag to prevent false "agent disconnected" events
  - Agent can now send multiple requests without connection issues

### Changed

- Panel header now includes quick-access buttons
- Improved button styling with proper hover states

### Technical

- New `HistoryManager` class for history persistence
- New `HistoryViewProvider` class for history panel
- Added `HistoryEntry` and `HistoryStatus` types
- MCPServer now records all request events to history
- WebView can trigger commands via messages
- Fixed request lifecycle management with proper resolved state tracking

## [1.0.13] - 2026-01-24

### Added

- **Sticky countdown timer** 📌
  - Timer and progress bar now stay fixed at top when scrolling
  - Always visible even with long messages
  - Shadow effect for visual separation from content
  - Clean separation from header (server info stays in place)

### Changed

- Restructured HTML: countdown and progress bar moved to dedicated sticky container
- Timer container uses `position: sticky` with proper z-index and background

## [1.0.12] - 2026-01-24

### Added

- **Agent-UI synchronization** 🔄
  - UI now detects when agent disconnects (stops waiting for response)
  - Shows "Request Cancelled" banner with reason when agent disconnects
  - Disables input controls to prevent submitting to disconnected agent
  - Auto-clears cancelled request after 5 seconds
  - Handles both agent disconnect and server timeout scenarios

### Changed

- HTTP request handling now tracks connection state
- Added `onRequestCancelled` callback to MCPServer for UI notifications
- Added `requestCancelled` message type for Extension-WebView communication

## [1.0.11] - 2026-01-24

### Added

- **Server-side pause functionality** ⏸️
  - Pause button now actually stops the server timeout, not just UI countdown
  - When paused, remaining time is saved and timeout is cleared
  - When resumed, timeout restarts with remaining time
  - Prevents auto-timeout while user is reading long messages

- **Infinite timeout option** ♾️
  - Set `humanInTheLoop.timeout` to `0` for no timeout
  - Countdown timer and progress bar are hidden when timeout is infinite
  - Request will wait indefinitely until user responds
  - Useful for complex decisions that need unlimited thinking time

### Changed

- Simplified Markdown documentation in tool descriptions
  - Removed detailed element lists, now just states "full Markdown support"
  - Cleaner, more concise tool descriptions
- Timeout setting minimum changed from 10 to 0 (allows infinite timeout)

### Fixed

- TypeScript null checks for `timeoutId` in pause/resume logic

## [1.0.10] - 2026-01-24

### Added

- **Pause/Resume timer button** ⏸️/▶️
  - New button next to countdown timer to pause the countdown
  - Click to pause - timer stops, progress bar grays out
  - Click again to resume - timer continues from where it stopped
  - Useful for reading long messages without time pressure
  - Visual feedback: paused state shows ▶️ icon with gray timer

- **Enhanced Markdown documentation in tool descriptions**
  - Each tool now includes detailed MARKDOWN SUPPORT section
  - Lists all supported GFM elements: headers, emphasis, lists, code, tables, etc.
  - Helps AI agents know they can use rich formatting in messages

### Changed

- Tool descriptions now include comprehensive Markdown examples
- Improved documentation for `ask_user_text`, `ask_user_confirm`, `ask_user_buttons`

## [1.0.9] - 2026-01-24

### Changed

- **Replaced custom markdown parser with markdown-it** - Architectural improvement
  - Markdown rendering now happens on extension side (Node.js) instead of WebView
  - Uses `markdown-it` (v14.1.0) for full GitHub Flavored Markdown support
    - Chosen over `marked` because markdown-it supports CommonJS (marked v17+ is ESM-only)
    - "Safe by default" - built-in XSS protection, no DOMPurify needed!
    - 13M+ weekly downloads, well-maintained
  - Eliminates all regex escaping issues from v1.0.8

- **Added esbuild for bundling** - Modern build system
  - Reduces VSIX size from ~1MB to ~161KB (6x smaller!)
  - All dependencies bundled into single extension.js
  - Faster extension loading

### Added

- **Full GFM (GitHub Flavored Markdown) support**:
  - Tables with proper styling (built-in)
  - Strikethrough (built-in)
  - Autolinks via `linkify: true`
  - Line breaks via `breaks: true`
  - All standard markdown features
- **New markdownRenderer.ts module** - Clean separation of concerns
  - `renderMarkdown()` function for secure markdown-to-HTML conversion
  - `renderMarkdownForWebview()` wrapper with container div

- **Enhanced CSP (Content Security Policy)**:
  - Added `img-src https: http: data:` to allow images in markdown

- **Table styles for WebView** - Properly styled GFM tables

### Removed

- **Removed parseMarkdown() from WebView JavaScript** - No longer needed
- **Removed sanitizeUrl() from WebView** - markdown-it handles URL sanitization

### Security

- `html: false` in markdown-it prevents HTML injection at source
- Built-in URL filtering blocks dangerous schemes:
  - `javascript:`, `vbscript:` (XSS vectors)
  - `file:` (local file access)
  - `data:` (except safe images: gif/png/jpeg/webp)
- Links automatically get `target="_blank" rel="noopener noreferrer"`
- No external sanitizer needed - markdown-it is safe by default

## [1.0.8] - 2026-01-23

### Fixed

- **CRITICAL: Fixed JavaScript SyntaxError crashing WebView** - Root cause of all sync issues found!
  - Problem: Regex patterns in `parseMarkdown()` lost escape characters in template literal
  - In template literal (backticks): `\*` → `*`, `\n` → newline, `\[` → `[`, `\/` → `/`
  - Browser received invalid regex like `/^(---|***|___)$/gm` causing SyntaxError
  - JavaScript crashed before event handlers registered → "ready" never sent → sync failure
- **Fixed all regex patterns in parseMarkdown()** - Doubled escape characters for template literal context:
  - Horizontal rule: `\*\*\*` → `[*]{3}` (character class doesn't need escaping)
  - Bold: `\*\*` → `[*][*]`
  - Italic: `\*` → `[*]`
  - Code blocks: `[\\s\\S]` → `[\\\\s\\\\S]`
  - Links/Images: `\[`, `\]` → `\\[`, `\\]`
  - Newlines: `\n` → `\\n`
  - Slashes: `\/` → `\\/`
  - Ordered lists: `\d`, `\.` → `\\d`, `\\.`

## [1.0.7] - 2026-01-23

### Fixed

- **Complete rollback to v1.0.0 WebView logic** - Removed all experimental buffering code
  - Removed `webviewReady` flag and `pendingMessages` buffer that caused issues
  - Removed `postMessageToWebview()` method
  - Restored simple, working logic from v1.0.0
  - Kept valuable improvements: copy button, mm:ss timer, aria-labels, updateServerInfo()

### Added

- Test infrastructure with @vscode/test-electron for automated testing
- Extension activation tests, command registration tests, MCP server tests

## [1.0.6] - 2026-01-23

### Fixed

- **Fixed WebView panel not showing server status** - Root cause identified via git diff with v1.0.0
  - Problem: Over-complicated JavaScript conditions `configStatus === 'running' && serverPort > 0`
  - Solution: Simplified to original v1.0.0 logic `serverPort > 0` which correctly shows running server
  - Added fallback else branch for unknown states (shows "Starting...")
  - Kept message buffering system from 1.0.5 as additional reliability measure

## [1.0.5] - 2026-01-22

### Fixed

- **Fixed critical WebView synchronization bug** - Panel now reliably shows correct server status
  - Root cause: Race condition between postMessage and webview JavaScript initialization
  - Solution: Added message buffering system - messages are queued until webview confirms readiness
  - Added `webviewReady` flag and `pendingMessages` buffer for reliable message delivery
  - Removed unreliable setTimeout(100ms) approach that caused timing issues
  - Initial state now shows "Connecting..." instead of "Not started" for better UX

## [1.0.4] - 2026-01-22

### Fixed

- **Fixed WebView not displaying server status on panel open** - added immediate serverInfo send in resolveWebviewView
- Panel now correctly shows server status even if opened after server starts
- Hidden "Connection Instructions" when server is running to avoid confusion

### Improved

- Empty state now shows "✅ Ready" with port number when server is running
- Added "Starting Server..." state with yellow indicator

## [1.0.3] - 2026-01-22

### Fixed

- **Fixed critical bug: WebView panel not syncing with server status** - panel now correctly displays server status and receives agent requests
- Added `updateServerInfo()` method called after server starts/stops/restarts/config changes
- Improved serverInfo status display logic with proper handling of "running", "configured" and "not-configured" states

## [1.0.2] - 2026-01-22

### Security

- Added request body size limit (1MB) to prevent DoS attacks
- Added URL sanitization in Markdown parser to block javascript: and data: URLs

### Fixed

- Removed unused `humanInTheLoop.port` setting (port is now only configured via mcp.json)
- Server version in MCP initialize response now dynamically reads from package.json

### Improved

- Timer now displays mm:ss format for timeouts > 60 seconds
- Added copy message button (📋) to copy original message text
- Added aria-labels for accessibility (screen readers)
- Added role="timer" and aria-live="polite" to countdown for accessibility

## [1.0.1] - 2026-01-22

### Fixed

- Fixed GitHub Actions CI/CD workflow - updated Node.js from 18.x to 20.x
- Fixed deprecated vsce package - now using @vscode/vsce
- Fixed GitHub Release creation for manual workflow triggers

### Improved

- Enhanced Markdown parser with full support for headers, lists, code blocks, links, blockquotes, images
- Expanded MCP tool descriptions with detailed usage guidelines (when to use, when not to use, best practices)
- Updated documentation to be agent-agnostic (works with any MCP-compatible AI agent)
- Added sound notification options: alert, melody, notification (longer sounds)
- Improved in-extension connection instructions panel

## [1.0.0] - 2026-01-22

### Added

- Initial release
- MCP HTTP server with JSON-RPC 2.0 support
- Three MCP tools:
  - `ask_user_text` - Request text input from user
  - `ask_user_confirm` - Request yes/no confirmation
  - `ask_user_buttons` - Show multiple choice options
- Sidebar panel with WebView UI
- Visual countdown timer with color-coded urgency
- Progress bar indicator
- Markdown support in messages
- Configurable timeout (10-600 seconds)
- Status bar indicator showing server port
- Connection instructions panel
- Multi-instance support (each VS Code window has its own server)
- Privacy-first design (no data collection)
