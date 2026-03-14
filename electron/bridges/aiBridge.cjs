/**
 * AI Bridge - Handles AI provider API calls and agent tool execution
 *
 * Proxies LLM API calls through the main process (avoiding CORS),
 * and provides tool execution capabilities for the Catty Agent.
 */

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");
const { spawn, execSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync } = require("node:fs");
const path = require("node:path");

const mcpServerBridge = require("./mcpServerBridge.cjs");

let sessions = null;
let sftpClients = null;
let electronModule = null;

// Active streaming requests (for cancellation)
const activeStreams = new Map();

// External agent processes
const agentProcesses = new Map();

// ACP providers (module-level so cleanup() can access them)
const acpProviders = new Map();
const acpActiveStreams = new Map();

// Claude Agent SDK active streams
const claudeActiveStreams = new Map();

// Claude session IDs (chatSessionId → SDK sessionId for resume)
const claudeSessionIds = new Map();

// Claude SDK query function cache (avoid re-importing on every message)
let cachedClaudeQuery = null;

// Keys to strip from env before passing to Claude SDK (prevent interference)
const CLAUDE_STRIPPED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
];

// Claude config dir base path for session isolation
let claudeConfigDirBase = null;

function getClaudeConfigDirBase() {
  if (claudeConfigDirBase) return claudeConfigDirBase;
  const home = process.env.HOME || require("node:os").homedir();
  claudeConfigDirBase = path.join(home, ".netcatty", "claude-sessions");
  return claudeConfigDirBase;
}

function ensureClaudeConfigDir(chatSessionId) {
  const dirBase = getClaudeConfigDirBase();
  const sessionDir = path.join(dirBase, chatSessionId);
  const { mkdirSync, existsSync: fsExistsSync, symlinkSync, readdirSync } = require("node:fs");
  mkdirSync(sessionDir, { recursive: true });

  // Symlink skills/commands/agents from ~/.claude/ if they exist
  const home = process.env.HOME || require("node:os").homedir();
  const claudeDir = path.join(home, ".claude");
  const symlinkTargets = ["skills", "commands", "agents", "plugins"];
  for (const target of symlinkTargets) {
    const src = path.join(claudeDir, target);
    const dest = path.join(sessionDir, target);
    if (fsExistsSync(src) && !fsExistsSync(dest)) {
      try {
        symlinkSync(src, dest, "dir");
      } catch {
        // Ignore symlink failures (e.g., already exists, permissions)
      }
    }
  }

  return sessionDir;
}

function buildClaudeEnv(shellEnv) {
  const env = { ...shellEnv };

  // Overlay process.env but preserve shell PATH (Electron's PATH is minimal)
  const shellPath = env.PATH;
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  if (shellPath) {
    env.PATH = shellPath;
  }

  // Strip sensitive keys (prevent interference from unrelated providers)
  for (const key of CLAUDE_STRIPPED_ENV_KEYS) {
    delete env[key];
  }

  // Ensure critical vars
  const os = require("node:os");
  if (!env.HOME) env.HOME = os.homedir();
  if (!env.USER) env.USER = os.userInfo().username;
  if (!env.TERM) env.TERM = "xterm-256color";
  if (!env.SHELL) env.SHELL = process.env.SHELL || "/bin/zsh";

  // Mark as SDK entry
  env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";

  return env;
}
const codexLoginSessions = new Map();
let codexChatGptValidationCache = null;

const URL_CANDIDATE_REGEX = /https?:\/\/[^\s]+/g;
const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_REGEX = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CODEX_AUTH_HINTS = [
  "not logged in",
  "authentication required",
  "auth required",
  "login required",
  "missing credentials",
  "no credentials",
  "unauthorized",
  "forbidden",
  "codex login",
  "401",
  "403",
  "invalid_grant",
  "invalid_token",
  "credentials",
];

function getCodexPackageName() {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return "@zed-industries/codex-acp-darwin-arm64";
    case "darwin-x64":
      return "@zed-industries/codex-acp-darwin-x64";
    case "linux-arm64":
      return "@zed-industries/codex-acp-linux-arm64";
    case "linux-x64":
      return "@zed-industries/codex-acp-linux-x64";
    case "win32-arm64":
      return "@zed-industries/codex-acp-win32-arm64";
    case "win32-x64":
      return "@zed-industries/codex-acp-win32-x64";
    default:
      return null;
  }
}

function toUnpackedAsarPath(filePath) {
  const unpackedPath = filePath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
  if (unpackedPath !== filePath && existsSync(unpackedPath)) {
    return unpackedPath;
  }
  return filePath;
}

function resolveCodexAcpBinaryPath(shellEnv) {
  const binaryName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
  const isPackaged = electronModule?.app?.isPackaged;

  // Dev mode: prefer system PATH (stays in sync with user's codex installation)
  if (!isPackaged && shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const systemPath = execSync(`${whichCmd} ${binaryName}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellEnv,
      }).trim().split("\n")[0].trim();
      if (systemPath && existsSync(systemPath)) {
        return systemPath;
      }
    } catch {
      // Not on PATH
    }
  }

  // Packaged build (or dev fallback): use npm-bundled binary
  try {
    const pkgName = getCodexPackageName();
    if (!pkgName) return binaryName;

    const pkgRoot = path.dirname(require.resolve("@zed-industries/codex-acp/package.json"));
    const resolved = require.resolve(`${pkgName}/bin/${binaryName}`, { paths: [pkgRoot] });
    return toUnpackedAsarPath(resolved);
  } catch {
    return binaryName;
  }
}

// Resolve CLI binaries from system PATH using shell env
function resolveCliFromPath(command, shellEnv) {
  if (shellEnv) {
    try {
      const whichCmd = process.platform === "win32" ? "where" : "which";
      const resolved = execSync(`${whichCmd} ${command}`, {
        encoding: "utf8",
        timeout: 3000,
        stdio: ["pipe", "pipe", "pipe"],
        env: shellEnv,
      }).trim().split("\n")[0].trim();
      if (resolved && existsSync(resolved)) return resolved;
    } catch {
      // Not found on PATH
    }
  }
  return null;
}

function stripAnsi(input) {
  return String(input || "").replace(ANSI_OSC_REGEX, "").replace(ANSI_ESCAPE_REGEX, "");
}

function isLocalhostHostname(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.endsWith(".localhost")
  );
}

function extractFirstNonLocalhostUrl(output) {
  const matches = stripAnsi(output).match(URL_CANDIDATE_REGEX);
  if (!matches) return null;

  for (const match of matches) {
    try {
      const parsedUrl = new URL(match.trim().replace(/[),.;!?]+$/, ""));
      if (!isLocalhostHostname(parsedUrl.hostname)) {
        return parsedUrl.toString();
      }
    } catch {
      // Ignore invalid URL candidates.
    }
  }

  return null;
}

function appendCodexLoginOutput(session, chunk) {
  const cleanChunk = stripAnsi(chunk);
  if (!cleanChunk) return;

  session.output += cleanChunk;
  if (!session.url) {
    session.url = extractFirstNonLocalhostUrl(session.output);
  }
}

function toCodexLoginSessionResponse(session) {
  return {
    sessionId: session.id,
    state: session.state,
    url: session.url,
    output: session.output,
    error: session.error,
    exitCode: session.exitCode,
  };
}

function getActiveCodexLoginSession() {
  for (const session of codexLoginSessions.values()) {
    if (session.state === "running" && session.process && !session.process.killed) {
      return session;
    }
  }
  return null;
}

function normalizeCodexIntegrationState(rawOutput) {
  const normalizedOutput = String(rawOutput || "").toLowerCase();

  if (normalizedOutput.includes("logged in using chatgpt")) {
    return "connected_chatgpt";
  }
  if (
    normalizedOutput.includes("logged in using an api key") ||
    normalizedOutput.includes("logged in using api key")
  ) {
    return "connected_api_key";
  }
  if (normalizedOutput.includes("not logged in")) {
    return "not_logged_in";
  }
  return "unknown";
}

function extractCodexError(error) {
  const message =
    error?.data?.message ||
    error?.errorText ||
    error?.message ||
    error?.error ||
    String(error);
  const code = error?.data?.code || error?.code;
  return {
    message: typeof message === "string" ? message : String(message),
    code: typeof code === "string" ? code : undefined,
  };
}

function isCodexAuthError(params) {
  const searchableText = `${params?.code || ""} ${params?.message || ""}`.toLowerCase();
  return CODEX_AUTH_HINTS.some((hint) => searchableText.includes(hint));
}

function getCodexAuthFingerprint(apiKey) {
  const normalized = String(apiKey || "").trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

function getCodexMcpFingerprint(mcpServers) {
  return createHash("sha256").update(JSON.stringify(mcpServers || [])).digest("hex");
}

function cleanupAcpProvider(chatSessionId) {
  const entry = acpProviders.get(chatSessionId);
  if (!entry) return;
  try {
    if (typeof entry.provider.forceCleanup === "function") {
      entry.provider.forceCleanup();
    } else if (typeof entry.provider.cleanup === "function") {
      entry.provider.cleanup();
    }
  } catch {
    // Ignore provider cleanup failures.
  }
  acpProviders.delete(chatSessionId);
}

function invalidateCodexValidationCache() {
  codexChatGptValidationCache = null;
}

function init(deps) {
  sessions = deps.sessions;
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
  mcpServerBridge.init({ sessions, sftpClients });
}

/**
 * Make a streaming HTTP request and forward SSE events back to renderer
 */
function streamRequest(url, options, event, requestId) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    const req = lib.request(
      parsedUrl,
      {
        method: options.method || "POST",
        headers: options.headers || {},
        timeout: 120000, // 2 min connection timeout
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          let errorBody = "";
          res.on("data", (chunk) => { errorBody += chunk.toString(); });
          res.on("end", () => {
            event.sender.send("netcatty:ai:stream:error", {
              requestId,
              error: `HTTP ${res.statusCode}: ${errorBody}`,
            });
            resolve();
          });
          return;
        }

        let buffer = "";

        res.on("data", (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Forward raw SSE data line to renderer
            if (trimmed.startsWith("data: ")) {
              event.sender.send("netcatty:ai:stream:data", {
                requestId,
                data: trimmed.slice(6),
              });
            }
          }
        });

        res.on("end", () => {
          // Flush any remaining buffer
          if (buffer.trim().startsWith("data: ")) {
            event.sender.send("netcatty:ai:stream:data", {
              requestId,
              data: buffer.trim().slice(6),
            });
          }
          event.sender.send("netcatty:ai:stream:end", { requestId });
          activeStreams.delete(requestId);
          resolve();
        });

        res.on("error", (err) => {
          event.sender.send("netcatty:ai:stream:error", {
            requestId,
            error: err.message,
          });
          activeStreams.delete(requestId);
          resolve();
        });
      }
    );

    req.on("error", (err) => {
      event.sender.send("netcatty:ai:stream:error", {
        requestId,
        error: err.message,
      });
      activeStreams.delete(requestId);
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      event.sender.send("netcatty:ai:stream:error", {
        requestId,
        error: "Request timeout",
      });
      activeStreams.delete(requestId);
    });

    // Store ref for cancellation
    activeStreams.set(requestId, req);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Execute command through the terminal PTY stream (visible in terminal).
 * Uses unique markers to detect when the command finishes and capture output.
 * Same approach as MCP server's execViaPty.
 */
function execViaPtyForCatty(ptyStream, command) {
  const marker = `__NCMCP_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}__`;

  return new Promise((resolve) => {
    let output = "";
    let foundStart = false;
    let timeoutId = null;

    const MAX_TIMEOUT = 300000; // 5 min

    const onData = (data) => {
      const text = data.toString();

      if (!foundStart) {
        const startIdx = text.indexOf(marker + "_S");
        if (startIdx !== -1) {
          foundStart = true;
          const afterMarker = text.slice(startIdx);
          const nlIdx = afterMarker.indexOf("\n");
          if (nlIdx !== -1) {
            output += afterMarker.slice(nlIdx + 1);
          }
        }
        if (foundStart) checkEnd();
        return;
      }

      output += text;
      checkEnd();
    };

    function checkEnd() {
      const endPattern = marker + "_E:";
      const endIdx = output.indexOf(endPattern);
      if (endIdx === -1) return;

      const afterEnd = output.slice(endIdx + endPattern.length);
      const codeMatch = afterEnd.match(/^(\d+)/);
      const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : null;

      const stdout = output.slice(0, endIdx);
      finish(stdout, exitCode);
    }

    function finish(stdout, exitCode) {
      clearTimeout(timeoutId);
      ptyStream.removeListener("data", onData);
      // Strip ANSI codes and any leaked MCP markers
      let cleaned = stripAnsi(stdout || "").trim();
      cleaned = cleaned.replace(/__NCMCP_[^\r\n]*[\r\n]*/g, "").trim();
      resolve({
        ok: exitCode === 0 || exitCode === null,
        stdout: cleaned,
        stderr: "",
        exitCode: exitCode ?? 0,
      });
    }

    timeoutId = setTimeout(() => {
      ptyStream.removeListener("data", onData);
      if (typeof ptyStream.write === "function") ptyStream.write("\x03");
      const cleaned = stripAnsi(output).trim();
      resolve({ ok: false, stdout: cleaned, stderr: "", exitCode: -1, error: "Command timed out (5min)" });
    }, MAX_TIMEOUT);

    ptyStream.on("data", onData);

    const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
    ptyStream.write(
      `printf '${marker}_S\\n';${noPager}${command}\n` +
      `__nc=$?;printf '${marker}_E:'$__nc'\\n';(exit $__nc)\n`
    );
  });
}

function registerHandlers(ipcMain) {
  // Start a streaming chat request (proxied through main process)
  ipcMain.handle("netcatty:ai:chat:stream", async (event, { requestId, url, headers, body }) => {
    try {
      await streamRequest(url, { method: "POST", headers, body }, event, requestId);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Cancel an active stream
  ipcMain.handle("netcatty:ai:chat:cancel", async (_event, { requestId }) => {
    const req = activeStreams.get(requestId);
    if (req) {
      req.destroy();
      activeStreams.delete(requestId);
      return true;
    }
    return false;
  });

  // Non-streaming request (for model listing, validation, etc.)
  ipcMain.handle("netcatty:ai:fetch", async (_event, { url, method, headers, body }) => {
    return new Promise((resolve) => {
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === "https:";
      const lib = isHttps ? https : http;

      const req = lib.request(
        parsedUrl,
        { method: method || "GET", headers: headers || {}, timeout: 30000 },
        (res) => {
          let data = "";
          res.on("data", (chunk) => { data += chunk.toString(); });
          res.on("end", () => {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              data,
            });
          });
        }
      );

      req.on("error", (err) => {
        resolve({ ok: false, status: 0, data: "", error: err.message });
      });
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, status: 0, data: "", error: "Request timeout" });
      });

      if (body) req.write(body);
      req.end();
    });
  });

  // Execute a command on a terminal session (for Catty Agent)
  // Uses PTY-based execution so commands are visible in the terminal,
  // matching the MCP server approach with start/end markers.
  ipcMain.handle("netcatty:ai:exec", async (_event, { sessionId, command }) => {
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }

    try {
      // Prefer PTY stream (visible in terminal) — same approach as MCP server
      const ptyStream = session.stream || session.pty;
      if (ptyStream && typeof ptyStream.write === "function") {
        return execViaPtyForCatty(ptyStream, command);
      }

      // Fallback: SSH exec channel (invisible to terminal)
      const sshClient = session.sshClient || session.conn;
      if (sshClient && typeof sshClient.exec === "function") {
        return new Promise((resolve) => {
          sshClient.exec(command, (err, stream) => {
            if (err) {
              resolve({ ok: false, error: err.message });
              return;
            }
            let stdout = "";
            let stderr = "";
            stream.on("data", (data) => { stdout += data.toString(); });
            stream.stderr.on("data", (data) => { stderr += data.toString(); });
            stream.on("close", (code) => {
              resolve({ ok: code === 0, stdout, stderr, exitCode: code });
            });
          });
        });
      }

      return { ok: false, error: "No terminal stream or SSH client available for this session" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Write to terminal session (send input like a user typing)
  ipcMain.handle("netcatty:ai:terminal:write", async (_event, { sessionId, data }) => {
    const session = sessions?.get(sessionId);
    if (!session) {
      return { ok: false, error: "Session not found" };
    }
    try {
      if (session.stream) {
        session.stream.write(data);
        return { ok: true };
      }
      if (session.pty) {
        session.pty.write(data);
        return { ok: true };
      }
      return { ok: false, error: "No writable stream for session" };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Resolve user's real shell environment (Electron GUI apps have a minimal PATH).
  // Cache the result so we only do this once.
  let _cachedShellEnv = null;
  async function getShellEnv() {
    if (_cachedShellEnv) return _cachedShellEnv;

    const home = process.env.HOME || "";
    // Extra paths to always include
    const extraPaths = [
      `${home}/.local/bin`,
      `${home}/.npm-global/bin`,
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];

    if (process.platform === "win32") {
      _cachedShellEnv = {
        ...process.env,
        PATH: [...extraPaths, process.env.PATH || ""].join(path.delimiter),
      };
      return _cachedShellEnv;
    }

    // On macOS/Linux, spawn a login shell to capture the real environment.
    try {
      const { execSync } = require("node:child_process");
      const shell = process.env.SHELL || "/bin/zsh";
      const envOutput = execSync(`${shell} -ilc 'env'`, {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, HOME: home },
      });
      const envMap = {};
      for (const line of envOutput.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          envMap[line.slice(0, idx)] = line.slice(idx + 1);
        }
      }
      // Merge: login-shell env as base, then process.env overrides, then extra paths
      const shellPath = envMap.PATH || "";
      _cachedShellEnv = {
        ...envMap,
        ...process.env,
        PATH: [...extraPaths, shellPath, process.env.PATH || ""].join(path.delimiter),
      };
    } catch {
      // Fallback if login shell fails
      _cachedShellEnv = {
        ...process.env,
        PATH: [...extraPaths, process.env.PATH || ""].join(path.delimiter),
      };
    }
    return _cachedShellEnv;
  }

  // AI SDK fullStream chunks use getters/non-enumerable properties that
  // JSON.parse(JSON.stringify()) silently drops.  Manually read the fields
  // the renderer actually needs so IPC serialization works reliably.
  function serializeStreamChunk(chunk) {
    if (!chunk || !chunk.type) return null;
    switch (chunk.type) {
      case "text-delta":
        return { type: "text-delta", textDelta: chunk.text ?? chunk.textDelta ?? "" };
      case "reasoning-delta":
        return { type: "reasoning-delta", delta: chunk.text ?? chunk.delta ?? "" };
      case "reasoning-start":
        return { type: "reasoning-start", id: chunk.id ?? undefined };
      case "reasoning-end":
        return { type: "reasoning-end", id: chunk.id ?? undefined };
      case "tool-call":
        return {
          type: "tool-call",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          args: chunk.args,
        };
      case "tool-result":
        return {
          type: "tool-result",
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          result: chunk.result,
          output: chunk.output,
        };
      case "error":
        return { type: "error", error: chunk.error };
      default:
        // For non-content events (start, finish, step-start, etc.) use a
        // plain-object snapshot so IPC can serialise them.
        try {
          return JSON.parse(JSON.stringify(chunk));
        } catch {
          return { type: chunk.type };
        }
    }
  }

  async function runCommand(command, args, options) {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args || [], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: options?.cwd || undefined,
        env: options?.env || process.env,
        windowsHide: true,
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.once("error", (error) => {
        reject(error);
      });

      child.once("close", (exitCode) => {
        resolve({
          stdout: stripAnsi(stdout),
          stderr: stripAnsi(stderr),
          exitCode,
        });
      });
    });
  }

  async function runCodexCli(args, options) {
    const shellEnv = await getShellEnv();
    const codexCliPath = resolveCliFromPath("codex", await getShellEnv()) || "codex";
    return await runCommand(codexCliPath, args, {
      cwd: options?.cwd?.trim() || undefined,
      env: shellEnv,
    });
  }

  async function runCodexCliChecked(args, options) {
    const result = await runCodexCli(args, options);
    if (result.exitCode === 0) {
      return result;
    }

    const errorText =
      result.stderr.trim() ||
      result.stdout.trim() ||
      `Codex command failed with exit code ${result.exitCode ?? "unknown"}`;
    throw new Error(errorText);
  }

  async function validateCodexChatGptAuth(options) {
    const maxAgeMs = options?.maxAgeMs ?? 30000;
    const now = Date.now();
    if (
      codexChatGptValidationCache &&
      now - codexChatGptValidationCache.checkedAt < maxAgeMs
    ) {
      return codexChatGptValidationCache;
    }

    const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
    const shellEnv = await getShellEnv();
    const provider = createACPProvider({
      command: resolveCodexAcpBinaryPath(shellEnv),
      env: shellEnv,
      session: {
        cwd: process.cwd(),
        mcpServers: [],
      },
      authMethodId: "chatgpt",
    });

    try {
      await provider.initSession();
      const result = { ok: true, checkedAt: now, error: null };
      codexChatGptValidationCache = result;
      return result;
    } catch (error) {
      const normalized = extractCodexError(error);
      const result = {
        ok: false,
        checkedAt: now,
        error: normalized.message,
        code: normalized.code,
      };
      codexChatGptValidationCache = result;
      return result;
    } finally {
      try {
        if (typeof provider.forceCleanup === "function") {
          provider.forceCleanup();
        } else if (typeof provider.cleanup === "function") {
          provider.cleanup();
        }
      } catch {
        // Ignore validation cleanup failures.
      }
    }
  }

  function objectToPairs(value) {
    if (!value || typeof value !== "object") return [];
    return Object.entries(value)
      .filter(([name, val]) => typeof name === "string" && typeof val === "string")
      .map(([name, val]) => ({ name, value: val }));
  }

  function resolveCodexStdioEnv(transport, shellEnv) {
    const merged = {};

    if (transport?.env && typeof transport.env === "object") {
      for (const [name, value] of Object.entries(transport.env)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (Array.isArray(transport?.env_vars)) {
      for (const envName of transport.env_vars) {
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0 && !merged[envName]) {
          merged[envName] = value;
        }
      }
    }

    return merged;
  }

  function resolveCodexHttpHeaders(transport, shellEnv) {
    const merged = {};

    if (transport?.http_headers && typeof transport.http_headers === "object") {
      for (const [name, value] of Object.entries(transport.http_headers)) {
        if (typeof name === "string" && typeof value === "string") {
          merged[name] = value;
        }
      }
    }

    if (transport?.env_http_headers && typeof transport.env_http_headers === "object") {
      for (const [headerName, envName] of Object.entries(transport.env_http_headers)) {
        if (typeof headerName !== "string" || typeof envName !== "string") continue;
        const value = shellEnv[envName] || process.env[envName];
        if (typeof value === "string" && value.length > 0) {
          merged[headerName] = value;
        }
      }
    }

    const bearerEnvVar = typeof transport?.bearer_token_env_var === "string"
      ? transport.bearer_token_env_var.trim()
      : "";
    if (bearerEnvVar && !merged.Authorization) {
      const token = shellEnv[bearerEnvVar] || process.env[bearerEnvVar];
      if (typeof token === "string" && token.trim()) {
        merged.Authorization = `Bearer ${token.trim()}`;
      }
    }

    return merged;
  }

  async function resolveCodexMcpSnapshot(cwd) {
    const empty = { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };

    try {
      const result = await runCodexCliChecked(["mcp", "list", "--json"], {
        cwd: cwd || undefined,
      });
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) {
        return empty;
      }

      const shellEnv = await getShellEnv();
      const mcpServers = [];

      for (const entry of parsed) {
        if (!entry?.enabled || !entry?.transport || typeof entry?.name !== "string") {
          continue;
        }

        const transportType = String(entry.transport.type || "").trim().toLowerCase();

        if (transportType === "stdio") {
          const command = String(entry.transport.command || "").trim();
          if (!command) continue;
          mcpServers.push({
            name: entry.name,
            type: "stdio",
            command,
            args: Array.isArray(entry.transport.args)
              ? entry.transport.args.filter((arg) => typeof arg === "string")
              : [],
            env: objectToPairs(resolveCodexStdioEnv(entry.transport, shellEnv)),
          });
          continue;
        }

        if (transportType === "streamable_http" || transportType === "http" || transportType === "sse") {
          const url = String(entry.transport.url || "").trim();
          if (!url) continue;
          mcpServers.push({
            name: entry.name,
            type: "http",
            url,
            headers: objectToPairs(resolveCodexHttpHeaders(entry.transport, shellEnv)),
          });
        }
      }

      return {
        mcpServers,
        fingerprint: getCodexMcpFingerprint(mcpServers),
      };
    } catch (err) {
      console.warn("[Codex] Failed to resolve MCP servers:", err?.message || err);
      return empty;
    }
  }

  // Discover external agents from PATH, plus the bundled Codex CLI if present.
  ipcMain.handle("netcatty:ai:agents:discover", async () => {
    const agents = [];
    const knownAgents = [
      {
        command: "claude",
        name: "Claude Code",
        icon: "claude",
        description: "Anthropic's agentic coding assistant",
        acpCommand: "claude-code-acp",
        acpArgs: [],
        args: ["-p", "--output-format", "text", "{prompt}"],
      },
      {
        command: "codex",
        name: "Codex CLI",
        icon: "openai",
        description: "OpenAI's coding agent",
        acpCommand: "codex-acp",
        acpArgs: [],
        args: ["exec", "--full-auto", "--json", "{prompt}"],
      },
    ];

    const shellEnv = await getShellEnv();
    const seenPaths = new Set();

    for (const agent of knownAgents) {
      let resolvedPath = null;

      if (!resolvedPath) {
        try {
          const whichCmd = process.platform === "win32" ? "where" : "which";
          const result = execSync(`${whichCmd} ${agent.command}`, {
            encoding: "utf8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
            env: shellEnv,
          }).trim();
          if (result) {
            resolvedPath = result.split("\n")[0].trim();
          }
        } catch {
          resolvedPath = null;
        }
      }

      if (!resolvedPath || seenPaths.has(resolvedPath)) {
        continue;
      }

      let version = "";
      try {
        const result = await runCommand(resolvedPath, ["--version"], { env: shellEnv });
        version = (result.stdout || result.stderr || "").trim().split("\n")[0];
      } catch {
        version = "";
      }

      agents.push({
        ...agent,
        path: resolvedPath,
        version,
        available: true,
        sdkType: undefined, // Use ACP for all agents (including Claude Code)
      });
      seenPaths.add(resolvedPath);
    }

    return agents;
  });

  // Resolve a CLI binary path (auto-detect or validate custom path)
  ipcMain.handle("netcatty:ai:resolve-cli", async (_event, { command, customPath }) => {
    const shellEnv = await getShellEnv();
    let resolvedPath = null;

    if (customPath) {
      // User provided a custom path – validate it exists
      if (existsSync(customPath)) {
        resolvedPath = customPath;
      }
    } else {
      resolvedPath = resolveCliFromPath(command, shellEnv);
    }

    if (!resolvedPath) {
      return { path: null, version: null, available: false };
    }

    let version = "";
    try {
      const result = await runCommand(resolvedPath, ["--version"], { env: shellEnv });
      version = (result.stdout || result.stderr || "").trim().split("\n")[0];
    } catch {
      version = "";
    }

    return { path: resolvedPath, version, available: true };
  });

  ipcMain.handle("netcatty:ai:codex:get-integration", async () => {
    try {
      const result = await runCodexCli(["login", "status"]);
      const rawOutput = [result.stdout, result.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      let state = normalizeCodexIntegrationState(rawOutput);
      let effectiveRawOutput = rawOutput;

      if (state === "connected_chatgpt") {
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures; we still want to surface the invalid state.
            }
            invalidateCodexValidationCache();
            state = "not_logged_in";
          } else {
            state = "unknown";
          }

          effectiveRawOutput = [
            rawOutput,
            "",
            "ChatGPT auth validation failed:",
            validation.error || "Unknown validation error",
          ].join("\n").trim();
        }
      }

      return {
        state,
        isConnected: state === "connected_chatgpt" || state === "connected_api_key",
        rawOutput: effectiveRawOutput,
        exitCode: result.exitCode,
      };
    } catch (err) {
      return {
        state: "unknown",
        isConnected: false,
        rawOutput: err?.message || String(err),
        exitCode: null,
      };
    }
  });

  ipcMain.handle("netcatty:ai:codex:start-login", async () => {
    const existingSession = getActiveCodexLoginSession();
    if (existingSession) {
      return { ok: true, session: toCodexLoginSessionResponse(existingSession) };
    }

    try {
      const shellEnv = await getShellEnv();
      const codexCliPath = resolveCliFromPath("codex", await getShellEnv()) || "codex";
      const sessionId = `codex_login_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const child = spawn(codexCliPath, ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: shellEnv,
        windowsHide: true,
      });

      const session = {
        id: sessionId,
        process: child,
        state: "running",
        output: "",
        url: null,
        error: null,
        exitCode: null,
      };

      const handleChunk = (chunk) => {
        appendCodexLoginOutput(session, chunk.toString("utf8"));
      };

      child.stdout.on("data", handleChunk);
      child.stderr.on("data", handleChunk);

      child.once("error", (error) => {
        session.state = "error";
        session.error = `[codex] Failed to start login flow: ${error.message}`;
        session.process = null;
      });

      child.once("close", (exitCode) => {
        session.exitCode = exitCode;
        session.process = null;

        if (session.state === "cancelled") {
          return;
        }

        if (exitCode === 0) {
          session.state = "success";
          session.error = null;
        } else {
          session.state = "error";
          session.error = session.error || `Codex login exited with code ${exitCode ?? "unknown"}`;
        }
      });

      codexLoginSessions.set(sessionId, session);
      invalidateCodexValidationCache();
      return { ok: true, session: toCodexLoginSessionResponse(session) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:codex:get-login-session", async (_event, { sessionId }) => {
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: false, error: "Codex login session not found" };
    }
    return { ok: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:cancel-login", async (_event, { sessionId }) => {
    const session = codexLoginSessions.get(sessionId);
    if (!session) {
      return { ok: true, found: false };
    }

    session.state = "cancelled";
    session.error = null;
    if (session.process && !session.process.killed) {
      session.process.kill("SIGTERM");
    }

    invalidateCodexValidationCache();
    return { ok: true, found: true, session: toCodexLoginSessionResponse(session) };
  });

  ipcMain.handle("netcatty:ai:codex:logout", async () => {
    try {
      const logoutResult = await runCodexCli(["logout"]);
      invalidateCodexValidationCache();
      const statusResult = await runCodexCli(["login", "status"]);
      const rawOutput = [statusResult.stdout, statusResult.stderr]
        .filter((chunk) => chunk.trim().length > 0)
        .join("\n")
        .trim();
      const state = normalizeCodexIntegrationState(rawOutput);

      return {
        ok: true,
        state,
        isConnected: state === "connected_chatgpt" || state === "connected_api_key",
        rawOutput,
        logoutOutput: [logoutResult.stdout, logoutResult.stderr]
          .filter((chunk) => chunk.trim().length > 0)
          .join("\n")
          .trim(),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Spawn an external agent process
  ipcMain.handle("netcatty:ai:agent:spawn", async (event, { agentId, command, args, env, closeStdin }) => {
    if (agentProcesses.has(agentId)) {
      return { ok: false, error: "Agent already running" };
    }

    try {
      const shellEnv = await getShellEnv();
      const stdinMode = closeStdin ? "ignore" : "pipe";

      const proc = spawn(command, args || [], {
        stdio: [stdinMode, "pipe", "pipe"],
        env: { ...shellEnv, ...env },
      });

      proc.stdout.on("data", (data) => {
        event.sender.send("netcatty:ai:agent:stdout", {
          agentId,
          data: data.toString(),
        });
      });

      proc.stderr.on("data", (data) => {
        event.sender.send("netcatty:ai:agent:stderr", {
          agentId,
          data: data.toString(),
        });
      });

      proc.on("exit", (code) => {
        agentProcesses.delete(agentId);
        event.sender.send("netcatty:ai:agent:exit", { agentId, code });
      });

      proc.on("error", (err) => {
        agentProcesses.delete(agentId);
        event.sender.send("netcatty:ai:agent:error", {
          agentId,
          error: err.message,
        });
      });

      agentProcesses.set(agentId, proc);

      return { ok: true, pid: proc.pid };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Send data to agent's stdin
  ipcMain.handle("netcatty:ai:agent:write", async (_event, { agentId, data }) => {
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (!proc.stdin || proc.stdin.destroyed) {
        return { ok: false, error: "stdin not available" };
      }
      proc.stdin.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // Close agent's stdin (signal EOF)
  ipcMain.handle("netcatty:ai:agent:close-stdin", async (_event, { agentId }) => {
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.end();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── MCP Server session metadata ──

  ipcMain.handle("netcatty:ai:mcp:update-sessions", async (_event, { sessions: sessionList }) => {
    mcpServerBridge.updateSessionMetadata(sessionList || []);
    return { ok: true };
  });

  // ── ACP (Agent Client Protocol) streaming ──

  ipcMain.handle("netcatty:ai:acp:stream", async (event, { requestId, chatSessionId, acpCommand, acpArgs, prompt, cwd, apiKey, model, images }) => {
    console.log("[ACP] stream handler called:", { requestId, chatSessionId, acpCommand, prompt: prompt?.slice(0, 50) });
    try {
      const { createACPProvider } = require("@mcpc-tech/acp-ai-provider");
      const { streamText, stepCountIs } = require("ai");

      const shellEnv = await getShellEnv();
      const sessionCwd = cwd || process.cwd();
      const isCodexAgent = acpCommand === "codex-acp";

      console.log("[ACP] isCodexAgent:", isCodexAgent, "apiKey:", apiKey ? "set" : "none");

      if (isCodexAgent && !apiKey) {
        console.log("[ACP] Validating ChatGPT auth...");
        const validation = await validateCodexChatGptAuth({ maxAgeMs: 10000 });
        console.log("[ACP] Auth validation result:", { ok: validation.ok, error: validation.error });
        if (!validation.ok) {
          if (isCodexAuthError(validation)) {
            try {
              await runCodexCli(["logout"]);
            } catch {
              // Ignore logout failures during recovery.
            }
            invalidateCodexValidationCache();
          }

          event.sender.send("netcatty:ai:acp:error", {
            requestId,
            error: `Codex ChatGPT login is stale or invalid. Reconnect Codex in Settings -> AI.\n\nDetails: ${validation.error || "Unknown authentication error"}`,
          });
          return { ok: false, error: validation.error || "Codex authentication validation failed" };
        }
      }

      const authFingerprint = isCodexAgent ? getCodexAuthFingerprint(apiKey) : null;
      console.log("[ACP] Resolving MCP snapshot...");
      const mcpSnapshot = isCodexAgent
        ? await resolveCodexMcpSnapshot(sessionCwd)
        : { mcpServers: [], fingerprint: getCodexMcpFingerprint([]) };

      // Inject Netcatty MCP server for remote host access
      try {
        const mcpPort = await mcpServerBridge.getOrCreateHost();
        // Parse scoped session IDs from the chatSessionId context if available
        const netcattyMcpConfig = mcpServerBridge.buildMcpServerConfig(mcpPort);
        mcpSnapshot.mcpServers.push(netcattyMcpConfig);
        console.log("[ACP] Injected netcatty-remote-hosts MCP server on port", mcpPort);
      } catch (err) {
        console.warn("[ACP] Failed to inject Netcatty MCP server:", err?.message || err);
      }

      // Recalculate fingerprint after injection
      mcpSnapshot.fingerprint = getCodexMcpFingerprint(mcpSnapshot.mcpServers);
      console.log("[ACP] MCP snapshot:", { count: mcpSnapshot.mcpServers.length, fingerprint: mcpSnapshot.fingerprint?.slice(0, 12) });

      let providerEntry = acpProviders.get(chatSessionId);
      const shouldReuseProvider = Boolean(
        providerEntry &&
        providerEntry.acpCommand === acpCommand &&
        providerEntry.cwd === sessionCwd &&
        providerEntry.authFingerprint === authFingerprint &&
        providerEntry.mcpFingerprint === mcpSnapshot.fingerprint,
      );

      console.log("[ACP] shouldReuseProvider:", shouldReuseProvider);

      if (!shouldReuseProvider) {
        cleanupAcpProvider(chatSessionId);

        const agentEnv = { ...shellEnv };
        if (apiKey) {
          agentEnv.CODEX_API_KEY = apiKey;
        }

        const resolvedCommand = isCodexAgent
          ? resolveCodexAcpBinaryPath(shellEnv)
          : acpCommand;

        console.log("[ACP] Creating new provider:", { resolvedCommand, cwd: sessionCwd, authMethodId: apiKey ? "codex-api-key" : "chatgpt" });
        const provider = createACPProvider({
          command: resolvedCommand,
          args: acpArgs || [],
          env: agentEnv,
          session: {
            cwd: sessionCwd,
            mcpServers: mcpSnapshot.mcpServers,
          },
          ...(isCodexAgent
            ? { authMethodId: apiKey ? "codex-api-key" : "chatgpt" }
            : {}),
          persistSession: true,
        });

        providerEntry = {
          provider,
          acpCommand,
          cwd: sessionCwd,
          authFingerprint,
          mcpFingerprint: mcpSnapshot.fingerprint,
        };
        acpProviders.set(chatSessionId, providerEntry);
      }

      const abortController = new AbortController();
      acpActiveStreams.set(requestId, abortController);

      // Prepend context hint so the agent uses MCP tools for remote hosts
      const contextualPrompt =
        `[Context: You are inside Netcatty, a multi-host SSH terminal manager. ` +
        `The user is managing REMOTE servers, not the local machine. ` +
        `Use the "netcatty-remote-hosts" MCP tools to operate on the remote hosts. ` +
        `Call get_environment first to discover available hosts and their session IDs. ` +
        `Do NOT use local shell execution.]\n\n${prompt}`;

      // Build message content: text + optional images (same as 1code)
      function buildMessageContent(text, imgs) {
        const content = [{ type: "text", text }];
        if (Array.isArray(imgs)) {
          for (const img of imgs) {
            if (!img.base64Data || !img.mediaType) continue;
            content.push({
              type: "file",
              mediaType: img.mediaType,
              data: img.base64Data,
              ...(img.filename ? { filename: img.filename } : {}),
            });
          }
        }
        return content;
      }

      if (Array.isArray(images) && images.length > 0) {
        console.log("[ACP] Images attached:", images.map(img => ({
          mediaType: img.mediaType,
          filename: img.filename,
          dataLen: img.base64Data?.length || 0,
          dataPrefix: img.base64Data?.slice(0, 30),
        })));
      }
      console.log("[ACP] Starting streamText...", images?.length ? `with ${images.length} image(s)` : "");
      const result = streamText({
        model: providerEntry.provider.languageModel(model || undefined),
        messages: [{
          role: "user",
          content: buildMessageContent(contextualPrompt, images),
        }],
        tools: providerEntry.provider.tools,
        stopWhen: stepCountIs(50),
        abortSignal: abortController.signal,
      });
      console.log("[ACP] streamText created, reading fullStream via getReader...");

      // Use getReader() instead of for-await — avoids Electron/Node ReadableStream
      // async iteration issues where for-await silently hangs.
      const reader = result.fullStream.getReader();
      let hasContent = false;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done || abortController.signal.aborted) break;
          try {
            const serialized = serializeStreamChunk(chunk);
            if (!serialized || !serialized.type) continue;

            if (serialized.type === "text-delta" || serialized.type === "reasoning-delta" || serialized.type === "tool-call") {
              hasContent = true;
            }
            event.sender.send("netcatty:ai:acp:event", {
              requestId,
              event: serialized,
            });
          } catch (serErr) {
            console.warn("[ACP stream] Failed to serialize chunk:", chunk?.type, serErr?.message);
          }
        }
      } finally {
        reader.releaseLock();
      }

      // If stream completed with zero content, likely an auth or connection issue
      if (!hasContent && !abortController.signal.aborted) {
        event.sender.send("netcatty:ai:acp:error", {
          requestId,
          error: isCodexAgent
            ? "Codex returned an empty response. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key."
            : "Agent returned an empty response.",
        });
      } else {
        event.sender.send("netcatty:ai:acp:done", { requestId });
      }
    } catch (err) {
      console.error("[ACP] Handler caught error:", err?.message || err, err?.stack?.split("\n").slice(0, 3).join("\n"));
      const normalized = extractCodexError(err);
      const errMsg = normalized.message;
      const isAuthError = isCodexAuthError(normalized);

      if (isAuthError) {
        console.error("[ACP] Auth error — user needs to re-login:", errMsg);
        cleanupAcpProvider(chatSessionId);
      }

      event.sender.send("netcatty:ai:acp:error", {
        requestId,
        error: isAuthError
          ? `Authentication failed. Connect Codex in Settings -> AI, or configure an enabled OpenAI provider API key.\n\nDetails: ${errMsg}`
          : errMsg,
      });
    } finally {
      acpActiveStreams.delete(requestId);
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:acp:cancel", async (_event, { requestId }) => {
    // Cancel any active PTY executions (send Ctrl+C)
    mcpServerBridge.cancelAllPtyExecs();
    const controller = acpActiveStreams.get(requestId);
    if (controller) {
      controller.abort();
      acpActiveStreams.delete(requestId);
      return { ok: true };
    }
    return { ok: false, error: "Stream not found" };
  });

  // Cleanup a specific ACP session (when chat session is deleted)
  ipcMain.handle("netcatty:ai:acp:cleanup", async (_event, { chatSessionId }) => {
    cleanupAcpProvider(chatSessionId);
    return { ok: true };
  });

  // ── Claude Agent SDK streaming ──

  ipcMain.handle("netcatty:ai:claude:stream", async (event, { requestId, chatSessionId, prompt, model }) => {
    try {
      // Cache the dynamic import (ESM module)
      if (!cachedClaudeQuery) {
        const sdk = await import("@anthropic-ai/claude-agent-sdk");
        cachedClaudeQuery = sdk.query;
      }
      const claudeQuery = cachedClaudeQuery;

      const shellEnv = await getShellEnv();
      const claudeCliPath = resolveCliFromPath("claude", shellEnv);

      // Build filtered env (strip sensitive keys, preserve shell PATH)
      const claudeEnv = buildClaudeEnv(shellEnv);

      // NOTE: Do NOT set CLAUDE_CONFIG_DIR here. The Claude Agent SDK needs access
      // to the default ~/.claude/ directory and the user's Keychain credentials.
      // Session isolation via CLAUDE_CONFIG_DIR would break auth since credentials
      // are stored in macOS Keychain tied to the default config path.

      const abortController = new AbortController();
      claudeActiveStreams.set(requestId, abortController);

      // Session resume: use stored SDK session ID if available
      const existingSessionId = claudeSessionIds.get(chatSessionId) || null;

      // Resolve MCP servers: codex MCP list + netcatty remote hosts
      let mcpServers = undefined;
      try {
        const mcpObj = {};

        // 1. From codex CLI (if available)
        try {
          const snapshot = await resolveCodexMcpSnapshot();
          for (const srv of snapshot.mcpServers || []) {
            if (srv.type === "stdio") {
              const envObj = {};
              if (Array.isArray(srv.env)) {
                for (const { name, value } of srv.env) envObj[name] = value;
              }
              mcpObj[srv.name] = { command: srv.command, args: srv.args || [], env: envObj };
            } else if (srv.type === "http") {
              const headerObj = {};
              if (Array.isArray(srv.headers)) {
                for (const { name, value } of srv.headers) headerObj[name] = value;
              }
              mcpObj[srv.name] = { url: srv.url, headers: headerObj };
            }
          }
        } catch {
          // codex MCP not available — that's fine
        }

        // 2. Inject netcatty-remote-hosts MCP server
        try {
          const mcpPort = await mcpServerBridge.getOrCreateHost();
          const cfg = mcpServerBridge.buildMcpServerConfig(mcpPort);
          const envObj = {};
          if (Array.isArray(cfg.env)) {
            for (const { name, value } of cfg.env) envObj[name] = value;
          }
          mcpObj[cfg.name] = { command: cfg.command, args: cfg.args || [], env: envObj };
          console.log("[Claude SDK] Injected netcatty-remote-hosts MCP server");
        } catch (err) {
          console.warn("[Claude SDK] Failed to inject Netcatty MCP:", err?.message);
        }

        if (Object.keys(mcpObj).length > 0) {
          mcpServers = mcpObj;
        }
      } catch (err) {
        console.warn("[Claude SDK] Failed to resolve MCP servers:", err?.message);
      }

      // Claude SDK discovers MCP tools via protocol — no need for prompt prefix.
      const queryOptions = {
        prompt,
        options: {
          abortController,
          cwd: process.cwd(),
          env: claudeEnv,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          ...(existingSessionId
            ? { resume: existingSessionId, continue: true }
            : { continue: true }),
          ...(claudeCliPath && { pathToClaudeCodeExecutable: claudeCliPath }),
          ...(model && { model }),
          ...(mcpServers && { mcpServers }),
          stderr: (data) => {
            console.error("[Claude SDK stderr]", data);
          },
        },
      };

      // Track which tool IDs have been emitted via streaming to avoid duplicates
      const emittedToolIds = new Set();
      let textStarted = false;
      let inThinkingBlock = false;
      let hasContent = false;

      // Auto-retry for transient policy violations
      const MAX_POLICY_RETRIES = 2;
      let policyRetryCount = 0;
      let policyRetryNeeded = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        policyRetryNeeded = false;

        const conversation = claudeQuery(queryOptions);

        try {
          for await (const msg of conversation) {
            if (abortController.signal.aborted) break;

            try {
              // Track session ID for resume
              if (msg.session_id) {
                claudeSessionIds.set(chatSessionId, msg.session_id);
              }

              // ── stream_event: token-by-token streaming ──
              if (msg.type === "stream_event" && msg.event) {
                const ev = msg.event;

                // Text streaming
                if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
                  textStarted = true;
                }
                if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
                  hasContent = true;
                  event.sender.send("netcatty:ai:claude:event", {
                    requestId,
                    event: { type: "text-delta", delta: ev.delta.text || "" },
                  });
                }

                // Thinking streaming (Extended Thinking)
                if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") {
                  inThinkingBlock = true;
                }
                if (ev.delta?.type === "thinking_delta" && inThinkingBlock) {
                  hasContent = true;
                  event.sender.send("netcatty:ai:claude:event", {
                    requestId,
                    event: { type: "thinking-delta", delta: String(ev.delta.thinking || "") },
                  });
                }
                if (ev.type === "content_block_stop" && inThinkingBlock) {
                  inThinkingBlock = false;
                  emittedToolIds.add("thinking-streamed");
                  event.sender.send("netcatty:ai:claude:event", {
                    requestId,
                    event: { type: "thinking-done" },
                  });
                }

                // Tool use streaming
                if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
                  const toolId = ev.content_block.id;
                  emittedToolIds.add(toolId);
                  hasContent = true;
                  event.sender.send("netcatty:ai:claude:event", {
                    requestId,
                    event: {
                      type: "tool-call",
                      toolCallId: toolId,
                      toolName: ev.content_block.name || "unknown",
                      input: {},
                    },
                  });
                }

                continue;
              }

              // ── assistant: complete message with content blocks ──
              if (msg.type === "assistant" && msg.message?.content) {
                for (const block of msg.message.content) {
                  // Skip blocks already emitted via streaming
                  if (block.type === "text" && !textStarted) {
                    hasContent = true;
                    event.sender.send("netcatty:ai:claude:event", {
                      requestId,
                      event: { type: "text-delta", delta: block.text || "" },
                    });
                  }
                  if (block.type === "thinking" && !emittedToolIds.has("thinking-streamed")) {
                    hasContent = true;
                    event.sender.send("netcatty:ai:claude:event", {
                      requestId,
                      event: { type: "thinking-delta", delta: block.thinking || "" },
                    });
                    event.sender.send("netcatty:ai:claude:event", {
                      requestId,
                      event: { type: "thinking-done" },
                    });
                  }
                  if (block.type === "tool_use" && !emittedToolIds.has(block.id)) {
                    hasContent = true;
                    emittedToolIds.add(block.id);
                    event.sender.send("netcatty:ai:claude:event", {
                      requestId,
                      event: {
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: block.name || "unknown",
                        input: block.input || {},
                      },
                    });
                  }
                }
                // Reset text state after complete message
                textStarted = false;
              }

              // ── user: tool results ──
              if (msg.type === "user" && Array.isArray(msg.message?.content)) {
                for (const block of msg.message.content) {
                  if (block.type === "tool_result") {
                    const output = block.is_error
                      ? `Error: ${block.content}`
                      : (typeof block.content === "string" ? block.content : JSON.stringify(block.content));
                    event.sender.send("netcatty:ai:claude:event", {
                      requestId,
                      event: {
                        type: "tool-result",
                        toolCallId: block.tool_use_id,
                        output,
                      },
                    });
                  }
                }
              }

              // ── error: SDK-level errors ──
              if (msg.type === "error" || msg.error) {
                const errorText = msg.message?.content?.[0]?.text || msg.error || msg.message || "Unknown SDK error";
                const errorStr = String(errorText);

                // Auto-retry on transient policy violations
                if (
                  (errorStr.includes("Usage Policy") || errorStr.includes("violate")) &&
                  policyRetryCount < MAX_POLICY_RETRIES &&
                  !abortController.signal.aborted
                ) {
                  policyRetryCount++;
                  policyRetryNeeded = true;
                  console.log(`[Claude SDK] Policy violation - retry ${policyRetryCount}/${MAX_POLICY_RETRIES}`);
                  break;
                }

                event.sender.send("netcatty:ai:claude:event", {
                  requestId,
                  event: { type: "error", error: errorStr },
                });
              }

              // ── result: final ──
              if (msg.type === "result") {
                if (msg.session_id) {
                  claudeSessionIds.set(chatSessionId, msg.session_id);
                }
                if (msg.error) {
                  event.sender.send("netcatty:ai:claude:event", {
                    requestId,
                    event: { type: "error", error: String(msg.error) },
                  });
                }
              }
            } catch (serErr) {
              console.warn("[Claude SDK] Failed to process message:", msg?.type, serErr?.message);
            }
          }
        } catch (streamErr) {
          // Check for session expiration
          const errMsg = String(streamErr?.message || streamErr);
          if (errMsg.includes("No conversation found with session ID")) {
            console.warn("[Claude SDK] Session expired, clearing cached session ID");
            claudeSessionIds.delete(chatSessionId);
          }
          throw streamErr;
        }

        if (policyRetryNeeded) {
          // Wait before retry (escalating: 3s, 6s)
          await new Promise(r => setTimeout(r, policyRetryCount * 3000));
          continue;
        }
        break;
      }

      if (!abortController.signal.aborted) {
        event.sender.send("netcatty:ai:claude:done", { requestId });
      }
    } catch (err) {
      event.sender.send("netcatty:ai:claude:error", {
        requestId,
        error: err?.message || String(err),
      });
    } finally {
      claudeActiveStreams.delete(requestId);
    }

    return { ok: true };
  });

  ipcMain.handle("netcatty:ai:claude:cancel", async (_event, { requestId }) => {
    const controller = claudeActiveStreams.get(requestId);
    if (controller) {
      controller.abort();
      claudeActiveStreams.delete(requestId);
      return { ok: true };
    }
    return { ok: false, error: "Stream not found" };
  });

  // Kill an agent process
  ipcMain.handle("netcatty:ai:agent:kill", async (_event, { agentId }) => {
    const proc = agentProcesses.get(agentId);
    if (!proc) return { ok: false, error: "Agent not found" };
    try {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (agentProcesses.has(agentId)) {
          try { proc.kill("SIGKILL"); } catch {}
        }
      }, 5000);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// Cleanup all agent processes on shutdown
function cleanup() {
  for (const [id, proc] of agentProcesses) {
    try {
      proc.kill("SIGTERM");
    } catch {}
  }
  agentProcesses.clear();

  for (const [id, req] of activeStreams) {
    try {
      req.destroy();
    } catch {}
  }
  activeStreams.clear();

  // Abort active ACP streams
  for (const [id, controller] of acpActiveStreams) {
    try { controller.abort(); } catch {}
  }
  acpActiveStreams.clear();

  // Abort active Claude Agent SDK streams
  for (const [id, controller] of claudeActiveStreams) {
    try { controller.abort(); } catch {}
  }
  claudeActiveStreams.clear();
  claudeSessionIds.clear();
  cachedClaudeQuery = null;

  // Cleanup ACP providers (kills codex-acp child processes)
  for (const [id] of acpProviders) {
    cleanupAcpProvider(id);
  }

  for (const [id, session] of codexLoginSessions) {
    try {
      if (session.process && !session.process.killed) {
        session.process.kill("SIGTERM");
      }
    } catch {}
  }
  codexLoginSessions.clear();
  invalidateCodexValidationCache();
}

module.exports = { init, registerHandlers, cleanup };
