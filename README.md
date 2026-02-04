# Human in the Loop MCP

[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-blue.svg)](https://code.visualstudio.com/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A VS Code extension that implements an MCP (Model Context Protocol) server for **human-in-the-loop** interactions. It allows any MCP-compatible AI agent to request user input, confirmations, or selections directly within VS Code.

## What is Human in the Loop?

**Human in the Loop (HITL)** is a pattern where AI agents can pause their execution to request human input, verification, or decision-making. This is essential for:

- 🔐 **Security**: Getting explicit permission before destructive operations
- 🎯 **Accuracy**: Clarifying ambiguous requirements with the user
- 🔧 **Flexibility**: Collecting dynamic input that can't be predicted
- ✅ **Trust**: Keeping humans informed and in control of AI actions

## Features

| Feature                     | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| 🔄 **MCP Server**           | Built-in HTTP server implementing the Model Context Protocol         |
| 💬 **Interactive Panel**    | Beautiful sidebar panel for viewing and responding to agent messages |
| ⏱️ **Countdown Timer**      | Visual countdown with configurable timeout (10-600 seconds)          |
| 🎯 **Multiple Input Types** | Text input, Yes/No confirmation, and button selections               |
| 🔔 **Sound Notifications**  | Configurable audio alerts when agent needs your attention            |
| 📤 **Auto-Submit**          | Optionally auto-submit current input when timer expires              |
| 🔒 **Privacy First**        | All data stays local, no external connections                        |
| 🖥️ **Multi-Instance**       | Each VS Code window runs its own isolated server                     |
| 📝 **Full Markdown**        | Rich formatting support in agent messages                            |

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for "Human in the Loop MCP"
4. Click Install

### From Source

```bash
git clone https://github.com/DercasDrol/human-in-the-loop-mcp.git
cd human-in-the-loop-mcp
npm install
npm run compile
# Press F5 in VS Code to launch debug mode
```

## Quick Start

### 1. Configure Your AI Agent

Add the MCP server to your project's `.vscode/mcp.json`:

```json
{
  "servers": {
    "human-in-the-loop": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

> **Note**: The extension automatically detects this configuration and starts the server on the specified port.

### 2. Use the Sidebar Panel

1. Click the **Human in the Loop** icon in the Activity Bar
2. When your AI agent sends a request, it appears in the panel
3. A countdown timer shows the remaining time to respond
4. Enter your response or click the appropriate button

### Keyboard Shortcuts

| Shortcut      | Action                        |
| ------------- | ----------------------------- |
| `Enter`       | Send response                 |
| `Shift+Enter` | Insert new line in text input |

> **Tip**: Use `Shift+Enter` to write multi-line responses, then `Enter` to send.

## Available MCP Tools

Your AI agent can use these tools to interact with users:

### `ask_user_text`

Request free-form text input from the user.

**Use for**: API keys, file paths, custom names, descriptions, clarifications

```json
{
  "name": "ask_user_text",
  "arguments": {
    "title": "API Key Required",
    "prompt": "Please enter your **OpenAI API key**:\n\nYou can find it at [platform.openai.com](https://platform.openai.com/api-keys)",
    "placeholder": "sk-..."
  }
}
```

### `ask_user_confirm`

Request a Yes/No confirmation from the user.

**Use for**: Destructive operations, permission requests, verification

```json
{
  "name": "ask_user_confirm",
  "arguments": {
    "title": "Confirm Deletion",
    "message": "Are you sure you want to delete the following files?\n\n- `src/old-module.ts`\n- `tests/old-module.test.ts`\n\n⚠️ **This action cannot be undone.**"
  }
}
```

### `ask_user_buttons`

Present multiple options for the user to choose from.

**Use for**: Language selection, action menus, configuration choices

```json
{
  "name": "ask_user_buttons",
  "arguments": {
    "title": "Select Framework",
    "message": "Which framework would you like to use for this project?",
    "options": [
      { "label": "React", "value": "react" },
      { "label": "Vue.js", "value": "vue" },
      { "label": "Angular", "value": "angular" },
      { "label": "Svelte", "value": "svelte" }
    ]
  }
}
```

## Settings

Configure the extension in VS Code Settings (`Ctrl+,`):

| Setting                              | Type    | Default   | Description                                               |
| ------------------------------------ | ------- | --------- | --------------------------------------------------------- |
| `humanInTheLoop.timeout`             | number  | 120       | Response timeout in seconds (0-600). 0 = infinite timeout |
| `humanInTheLoop.autoSubmitOnTimeout` | boolean | false     | Auto-submit current input when timer expires              |
| `humanInTheLoop.soundEnabled`        | boolean | true      | Play sound on new requests                                |
| `humanInTheLoop.soundVolume`         | number  | 0.5       | Sound volume (0.0 - 1.0)                                  |
| `humanInTheLoop.soundType`           | string  | "default" | Notification sound type                                   |
| `humanInTheLoop.enableLogging`       | boolean | false     | Enable detailed logging (Output > Human in the Loop MCP)  |
| `humanInTheLoop.bindAddress`         | string  | "0.0.0.0" | Server bind address (see WSL/Remote section below)        |

### Sound Types

- `default` - Standard notification (short)
- `chime` - Soft chime (short)
- `ping` - Quick ping (short)
- `bell` - Bell with harmonics (medium)
- `notification` - Two-tone ascending (medium)
- `alert` - Attention-grabbing beeps (long)
- `melody` - Musical phrase C-E-G-C (long)

## Architecture

```
┌─────────────────┐     ┌──────────────────┐
│    AI Agent     │────▶│   MCP Server     │
│ (Any MCP Client)│◀────│  (HTTP/JSON-RPC) │
└─────────────────┘     └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │   VS Code        │
                        │   Extension      │
                        └────────┬─────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Sidebar Panel   │
                        │  (User Interface)│
                        └──────────────────┘
```

### Session Isolation

Each VS Code window:

- Runs its own HTTP server on a unique port
- Has its own sidebar panel
- Handles requests independently

This enables working on multiple projects simultaneously without conflicts.

## Compatibility

This extension works with **any AI agent or tool that supports the Model Context Protocol (MCP)**, including:

- VS Code extensions with MCP support
- CLI tools implementing MCP client
- Custom AI agents using MCP SDK
- Any HTTP client that can send JSON-RPC requests

## Commands

| Command                                           | Description                                       |
| ------------------------------------------------- | ------------------------------------------------- |
| `Human in the Loop: Show Connection Instructions` | Display setup instructions and current server URL |
| `Human in the Loop: Restart MCP Server`           | Restart the local MCP server                      |

## Privacy & Security

This extension:

- ✅ Runs entirely locally on your machine
- ✅ Does not collect any telemetry or analytics
- ✅ Does not send data to external servers
- ✅ All communication is between VS Code and your local AI agent
- ✅ By default binds to `0.0.0.0` for WSL/Remote compatibility (configurable to `127.0.0.1`)

## WSL & Remote Development

This extension fully supports VS Code Remote Development:

- **WSL** (Windows Subsystem for Linux)
- **Remote - SSH**
- **Dev Containers**
- **GitHub Codespaces**

### How it works

When working in a remote environment, the extension runs in the **workspace context** (remote machine). VS Code automatically forwards the MCP server port to your local machine.

### Bind Address Setting

| Value       | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| `0.0.0.0`   | Listen on all interfaces (default, required for WSL/Remote)    |
| `127.0.0.1` | Listen only on localhost (more restrictive, local-only access) |

If you're only working locally and want stricter network isolation, you can change `humanInTheLoop.bindAddress` to `127.0.0.1`.

## Requirements

- VS Code 1.100.0 or higher
- Node.js 20+ (for development; VS Code includes its own runtime)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Release Process

This project uses GitHub Actions for automated releases:

1. Update version in `package.json`
2. Create and push a version tag: `git tag v1.0.1 && git push --tags`
3. GitHub Actions will automatically:
   - Build the extension
   - Create a GitHub Release with the VSIX
   - Publish to VS Code Marketplace (if `VSCE_PAT` secret is configured)
   - Publish to Open VSX Registry (if `OVSX_PAT` secret is configured)

## License

MIT License - see [LICENSE](LICENSE) for details.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

Made with ❤️ for the AI community
