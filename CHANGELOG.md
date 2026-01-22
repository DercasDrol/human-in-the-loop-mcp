# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Configurable port (0 = auto-assign)
- Status bar indicator showing server port
- Connection instructions panel
- Multi-instance support (each VS Code window has its own server)
- Privacy-first design (no data collection)
