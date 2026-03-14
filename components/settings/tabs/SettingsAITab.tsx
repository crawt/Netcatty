/**
 * Settings AI Tab - AI provider configuration, agent CLI detection, and safety settings
 */
import {
  Bot,
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  ExternalLink,
  Globe,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AIPermissionMode,
  AIProviderId,
  ExternalAgentConfig,
  ProviderConfig,
} from "../../../infrastructure/ai/types";
import { PROVIDER_PRESETS } from "../../../infrastructure/ai/types";
import { useAgentDiscovery } from "../../../application/state/useAgentDiscovery";
import { encryptField, decryptField } from "../../../infrastructure/persistence/secureFieldAdapter";
import { TabsContent } from "../../ui/tabs";
import { Button } from "../../ui/button";
import { Toggle, Select, SettingRow } from "../settings-ui";
import { cn } from "../../../lib/utils";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SettingsAITabProps {
  providers: ProviderConfig[];
  addProvider: (provider: ProviderConfig) => void;
  updateProvider: (id: string, updates: Partial<ProviderConfig>) => void;
  removeProvider: (id: string) => void;
  activeProviderId: string;
  setActiveProviderId: (id: string) => void;
  activeModelId: string;
  setActiveModelId: (id: string) => void;
  globalPermissionMode: AIPermissionMode;
  setGlobalPermissionMode: (mode: AIPermissionMode) => void;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  defaultAgentId: string;
  setDefaultAgentId: (id: string) => void;
  commandTimeout: number;
  setCommandTimeout: (value: number) => void;
  maxIterations: number;
  setMaxIterations: (value: number) => void;
}

type CodexIntegrationState =
  | "connected_chatgpt"
  | "connected_api_key"
  | "not_logged_in"
  | "unknown";

interface CodexIntegrationStatus {
  state: CodexIntegrationState;
  isConnected: boolean;
  rawOutput: string;
  exitCode: number | null;
}

type CodexLoginState = "running" | "success" | "error" | "cancelled";

interface CodexLoginSession {
  sessionId: string;
  state: CodexLoginState;
  url: string | null;
  output: string;
  error: string | null;
  exitCode: number | null;
}

interface AgentPathInfo {
  path: string | null;
  version: string | null;
  available: boolean;
}

interface NetcattyAiBridge {
  aiCodexGetIntegration?: () => Promise<CodexIntegrationStatus>;
  aiCodexStartLogin?: () => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexGetLoginSession?: (sessionId: string) => Promise<{ ok: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexCancelLogin?: (sessionId: string) => Promise<{ ok: boolean; found?: boolean; session?: CodexLoginSession; error?: string }>;
  aiCodexLogout?: () => Promise<{ ok: boolean; state?: CodexIntegrationState; isConnected?: boolean; rawOutput?: string; logoutOutput?: string; error?: string }>;
  aiResolveCli?: (params: { command: string; customPath?: string }) => Promise<AgentPathInfo>;
  openExternal?: (url: string) => Promise<void>;
}

function getBridge(): NetcattyAiBridge | undefined {
  return (window as unknown as { netcatty?: NetcattyAiBridge }).netcatty;
}

function normalizeCodexBridgeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered for 'netcatty:ai:codex:")) {
    return "Codex main-process handlers are not loaded yet. Fully restart Netcatty, or restart the Electron dev process, then try again.";
  }
  return message;
}

// Agent default configs for registration in externalAgents
const AGENT_DEFAULTS: Record<string, Omit<ExternalAgentConfig, "id" | "command" | "enabled">> = {
  codex: {
    name: "Codex CLI",
    args: ["exec", "--full-auto", "--json", "{prompt}"],
    icon: "openai",
    acpCommand: "codex-acp",
    acpArgs: [],
  },
  claude: {
    name: "Claude Code",
    args: ["-p", "--output-format", "text", "{prompt}"],
    icon: "claude",
    acpCommand: "claude-code-acp",
    acpArgs: [],
  },
};

// ---------------------------------------------------------------------------
// Provider icon helper
// ---------------------------------------------------------------------------

type SettingsIconId = AIProviderId | "claude";

const SETTINGS_ICON_PATHS: Record<SettingsIconId, string> = {
  openai: "/ai/providers/openai.svg",
  anthropic: "/ai/providers/anthropic.svg",
  claude: "/ai/agents/claude.svg",
  google: "/ai/providers/google.svg",
  ollama: "/ai/providers/ollama.svg",
  openrouter: "/ai/providers/openrouter.svg",
  custom: "/ai/providers/custom.svg",
};

const SETTINGS_ICON_COLORS: Record<SettingsIconId, string> = {
  openai: "bg-emerald-600",
  anthropic: "bg-orange-600",
  claude: "bg-orange-600",
  google: "bg-blue-600",
  ollama: "bg-purple-600",
  openrouter: "bg-pink-600",
  custom: "bg-zinc-600",
};

const ProviderIconBadge: React.FC<{
  providerId: SettingsIconId;
  size?: "sm" | "md";
}> = ({ providerId, size = "md" }) => (
  <div
    className={cn(
      "rounded-md flex items-center justify-center shrink-0 overflow-hidden",
      size === "sm" ? "w-5 h-5" : "w-8 h-8",
      SETTINGS_ICON_COLORS[providerId],
    )}
  >
    <img
      src={SETTINGS_ICON_PATHS[providerId]}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn(
        "object-contain brightness-0 invert",
        size === "sm" ? "w-3 h-3" : "w-4 h-4",
      )}
    />
  </div>
);

// ---------------------------------------------------------------------------
// Provider Config Form (inline expandable)
// ---------------------------------------------------------------------------

interface ProviderFormState {
  apiKey: string;
  baseURL: string;
  defaultModel: string;
}

// Fetch models from a provider's models endpoint (e.g. OpenRouter /api/v1/models)
interface FetchedModel {
  id: string;
  name?: string;
}

interface FetchBridge {
  aiFetch?: (url: string, method?: string, headers?: Record<string, string>, body?: string) => Promise<{ ok: boolean; data: string; error?: string }>;
}

function getFetchBridge(): FetchBridge | undefined {
  return (window as unknown as { netcatty?: FetchBridge }).netcatty;
}

// ---------------------------------------------------------------------------
// Model Selector (searchable dropdown with remote fetch)
// ---------------------------------------------------------------------------

const ModelSelector: React.FC<{
  value: string;
  onChange: (value: string) => void;
  baseURL: string;
  modelsEndpoint: string;
}> = ({ value, onChange, baseURL, modelsEndpoint }) => {
  const [models, setModels] = useState<FetchedModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [hasFetched, setHasFetched] = useState(false);

  const fetchModels = useCallback(async () => {
    const bridge = getFetchBridge();
    if (!bridge?.aiFetch) return;

    setIsLoading(true);
    setError(null);
    try {
      const url = `${baseURL.replace(/\/+$/, "")}${modelsEndpoint}`;
      const result = await bridge.aiFetch(url, "GET");
      if (!result.ok) {
        setError(`Failed to fetch models (${result.error || "unknown error"})`);
        return;
      }
      const parsed = JSON.parse(result.data);
      const list: FetchedModel[] = (parsed.data || parsed.models || []).map((m: { id: string; name?: string }) => ({
        id: m.id,
        name: m.name,
      }));
      // Sort by name/id
      list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
      setModels(list);
      setHasFetched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse response");
    } finally {
      setIsLoading(false);
    }
  }, [baseURL, modelsEndpoint]);

  // Fetch on first open
  useEffect(() => {
    if (isOpen && !hasFetched && !isLoading) {
      void fetchModels();
    }
  }, [isOpen, hasFetched, isLoading, fetchModels]);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter((m) =>
      m.id.toLowerCase().includes(q) || (m.name && m.name.toLowerCase().includes(q)),
    );
  }, [models, search]);

  return (
    <div className="relative">
      {/* Input with dropdown toggle */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={() => setIsOpen(true)}
            placeholder="Search or type model ID..."
            className="w-full h-8 rounded-md border border-input bg-background px-3 pr-8 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <ChevronDown size={14} className={cn("transition-transform", isOpen && "rotate-180")} />
          </button>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setHasFetched(false); void fetchModels(); }}
          disabled={isLoading}
          className="shrink-0 px-2"
          title="Refresh models"
        >
          <RefreshCw size={14} className={isLoading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setIsOpen(false)} />
          <div className="absolute top-full left-0 right-0 mt-1 z-[101] rounded-md border border-border bg-popover shadow-md">
            {/* Search within dropdown */}
            <div className="p-2 border-b border-border/60">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter models..."
                autoFocus
                className="w-full h-7 rounded border border-input bg-background px-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <div className="max-h-60 overflow-y-auto">
              {isLoading ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  <RefreshCw size={14} className="animate-spin inline mr-1.5" />
                  Loading models...
                </div>
              ) : error ? (
                <div className="px-3 py-4 text-center text-xs text-destructive">{error}</div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                  {hasFetched ? "No matching models" : "Click to load models"}
                </div>
              ) : (
                filtered.slice(0, 100).map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      onChange(m.id);
                      setIsOpen(false);
                      setSearch("");
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs hover:bg-accent transition-colors flex items-center justify-between gap-2",
                      m.id === value && "bg-accent",
                    )}
                  >
                    <span className="font-mono truncate">{m.id}</span>
                    {m.id === value && <Check size={12} className="text-primary shrink-0" />}
                  </button>
                ))
              )}
              {filtered.length > 100 && (
                <div className="px-3 py-2 text-center text-[10px] text-muted-foreground border-t border-border/40">
                  Showing first 100 of {filtered.length} models. Type to filter.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const ProviderConfigForm: React.FC<{
  provider: ProviderConfig;
  onSave: (updates: Partial<ProviderConfig>) => void;
  onCancel: () => void;
}> = ({ provider, onSave, onCancel }) => {
  const [form, setForm] = useState<ProviderFormState>({
    apiKey: "",
    baseURL: provider.baseURL ?? PROVIDER_PRESETS[provider.providerId]?.defaultBaseURL ?? "",
    defaultModel: provider.defaultModel ?? "",
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [isDecrypting, setIsDecrypting] = useState(false);

  const preset = PROVIDER_PRESETS[provider.providerId];
  const hasModelsEndpoint = !!preset?.modelsEndpoint;

  // Decrypt and load existing API key on mount
  useEffect(() => {
    if (provider.apiKey) {
      setIsDecrypting(true);
      decryptField(provider.apiKey)
        .then((decrypted) => {
          setForm((prev) => ({ ...prev, apiKey: decrypted ?? "" }));
        })
        .catch(() => {
          // If decryption fails, show raw value
          setForm((prev) => ({ ...prev, apiKey: provider.apiKey ?? "" }));
        })
        .finally(() => setIsDecrypting(false));
    }
  }, [provider.apiKey]);

  const handleSave = useCallback(async () => {
    const updates: Partial<ProviderConfig> = {
      baseURL: form.baseURL || undefined,
      defaultModel: form.defaultModel || undefined,
    };

    // Encrypt API key before saving
    if (form.apiKey) {
      updates.apiKey = await encryptField(form.apiKey);
    } else {
      updates.apiKey = undefined;
    }

    onSave(updates);
  }, [form, onSave]);

  return (
    <div className="mt-3 space-y-3 border-t border-border/40 pt-3">
      {/* API Key */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">API Key</label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={showApiKey ? "text" : "password"}
              value={isDecrypting ? "" : form.apiKey}
              onChange={(e) => setForm((prev) => ({ ...prev, apiKey: e.target.value }))}
              placeholder={isDecrypting ? "Decrypting..." : "Enter API key"}
              disabled={isDecrypting}
              className="w-full h-8 rounded-md border border-input bg-background px-3 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Base URL</label>
        <input
          type="text"
          value={form.baseURL}
          onChange={(e) => setForm((prev) => ({ ...prev, baseURL: e.target.value }))}
          placeholder={preset?.defaultBaseURL || "https://"}
          className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      {/* Default Model */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Default Model</label>
        {hasModelsEndpoint ? (
          <ModelSelector
            value={form.defaultModel}
            onChange={(val) => setForm((prev) => ({ ...prev, defaultModel: val }))}
            baseURL={form.baseURL || preset.defaultBaseURL}
            modelsEndpoint={preset.modelsEndpoint!}
          />
        ) : (
          <input
            type="text"
            value={form.defaultModel}
            onChange={(e) => setForm((prev) => ({ ...prev, defaultModel: e.target.value }))}
            placeholder="e.g. gpt-4o, claude-sonnet-4-20250514"
            className="w-full h-8 rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <Button variant="default" size="sm" onClick={() => void handleSave()}>
          <Check size={14} className="mr-1.5" />
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Provider Card
// ---------------------------------------------------------------------------

const ProviderCard: React.FC<{
  provider: ProviderConfig;
  isActive: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
  onUpdate: (updates: Partial<ProviderConfig>) => void;
  isEditing: boolean;
  onCancelEdit: () => void;
}> = ({ provider, isActive, onToggleEnabled, onEdit, onRemove, onUpdate, isEditing, onCancelEdit }) => {
  const hasApiKey = !!provider.apiKey;

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        isActive ? "border-primary/50 bg-primary/5" : "border-border/60 bg-muted/20",
      )}
    >
      <div className="flex items-center gap-3">
        {/* Provider icon */}
        <ProviderIconBadge providerId={provider.providerId} />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{provider.name}</span>
            {isActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/20 text-primary font-medium">
                Active
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span
              className={cn(
                "text-xs",
                hasApiKey ? "text-emerald-500" : "text-muted-foreground",
              )}
            >
              {hasApiKey ? "API key configured" : "No API key"}
            </span>
            {provider.defaultModel && (
              <>
                <span className="text-muted-foreground text-xs">|</span>
                <span className="text-xs text-muted-foreground truncate">{provider.defaultModel}</span>
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={onEdit}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Configure"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={onRemove}
            className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="Remove"
          >
            <Trash2 size={14} />
          </button>
          <Toggle checked={provider.enabled} onChange={onToggleEnabled} />
        </div>
      </div>

      {/* Expandable config form */}
      {isEditing && (
        <ProviderConfigForm
          provider={provider}
          onSave={(updates) => {
            onUpdate(updates);
            onCancelEdit();
          }}
          onCancel={onCancelEdit}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Add Provider Dropdown
// ---------------------------------------------------------------------------

const AddProviderDropdown: React.FC<{
  onAdd: (providerId: AIProviderId) => void;
}> = ({ onAdd }) => {
  const [isOpen, setIsOpen] = useState(false);

  const providerIds = Object.keys(PROVIDER_PRESETS) as AIProviderId[];

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(!isOpen)}
        className="gap-1.5"
      >
        <Plus size={14} />
        Add Provider
        <ChevronDown size={12} className={cn("transition-transform", isOpen && "rotate-180")} />
      </Button>

      {isOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[100]" onClick={() => setIsOpen(false)} />
          {/* Menu */}
          <div className="absolute top-full left-0 mt-1 z-[101] min-w-[200px] rounded-md border border-border bg-popover shadow-md py-1">
            {providerIds.map((pid) => (
              <button
                key={pid}
                onClick={() => {
                  onAdd(pid);
                  setIsOpen(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
              >
                <ProviderIconBadge providerId={pid} size="sm" />
                {PROVIDER_PRESETS[pid].name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Codex Connection Card (with path detection)
// ---------------------------------------------------------------------------

const CodexConnectionCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
  integration: CodexIntegrationStatus | null;
  loginSession: CodexLoginSession | null;
  isLoading: boolean;
  hasOpenAiProviderKey: boolean;
  error: string | null;
  onRefresh: () => void;
  onConnect: () => void;
  onCancel: () => void;
  onOpenUrl: () => void;
  onLogout: () => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
  integration,
  loginSession,
  isLoading,
  hasOpenAiProviderKey,
  error,
  onRefresh,
  onConnect,
  onCancel,
  onOpenUrl,
  onLogout,
}) => {
  const found = pathInfo?.available;

  const status = isResolvingPath
    ? "Detecting..."
    : !found
      ? "Not found"
      : loginSession?.state === "running"
        ? "Awaiting login"
        : integration?.state === "connected_chatgpt"
          ? "Connected via ChatGPT"
          : integration?.state === "connected_api_key"
            ? "Connected via API key"
            : integration?.state === "not_logged_in"
              ? "Not connected"
              : "Status unknown";

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : !found
      ? "text-amber-500"
      : loginSession?.state === "running"
        ? "text-amber-500"
        : integration?.isConnected
          ? "text-emerald-500"
          : "text-muted-foreground";

  const outputText = loginSession?.error
    ? loginSession.error
    : loginSession?.output?.trim()
      ? loginSession.output.trim()
      : integration?.rawOutput?.trim()
        ? integration.rawOutput.trim()
        : "";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ProviderIconBadge providerId="openai" size="sm" />
            <span className="text-sm font-medium">Codex CLI</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-5">
            Bundled <span className="font-mono">codex</span> + <span className="font-mono">codex-acp</span> for ACP protocol streaming.
            Login with ChatGPT subscription here, or configure an OpenAI provider API key (passed as <span className="font-mono">CODEX_API_KEY</span>).
          </p>
        </div>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {status}
        </div>
      </div>

      {/* Path detection info */}
      {found ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Path:</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">{pathInfo.version}</span>
            </>
          )}
        </div>
      ) : !isResolvingPath ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-500">
            Could not find <span className="font-mono">codex</span> in PATH. Install it or specify the executable path below.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder="e.g. /usr/local/bin/codex"
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              Check
            </Button>
          </div>
        </div>
      ) : null}

      {/* Connection & login UI – only when codex is detected */}
      {found && (
        <>
          <div className="border-t border-border/40 pt-3 flex items-center gap-2 flex-wrap">
            {loginSession?.state === "running" ? (
              <>
                <Button variant="default" size="sm" onClick={onOpenUrl} disabled={!loginSession.url}>
                  <ExternalLink size={14} className="mr-1.5" />
                  Open Login
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel}>
                  <X size={14} className="mr-1.5" />
                  Cancel
                </Button>
              </>
            ) : integration?.isConnected ? (
              <Button variant="outline" size="sm" onClick={onLogout}>
                <LogOut size={14} className="mr-1.5" />
                Logout
              </Button>
            ) : (
              <Button variant="default" size="sm" onClick={onConnect}>
                <LogIn size={14} className="mr-1.5" />
                Connect ChatGPT
              </Button>
            )}

            <Button variant="outline" size="sm" onClick={onRefresh} disabled={isLoading}>
              <RefreshCw size={14} className={cn("mr-1.5", isLoading && "animate-spin")} />
              Refresh Status
            </Button>
          </div>

          {hasOpenAiProviderKey && (
            <p className="text-xs text-emerald-500">
              Enabled OpenAI provider API key detected. Codex ACP can also authenticate without ChatGPT login.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="text-xs text-destructive">
          {error}
        </p>
      )}

      {found && outputText && (
        <pre className="rounded-md border border-border/60 bg-background px-3 py-2 text-[11px] leading-5 text-muted-foreground whitespace-pre-wrap max-h-40 overflow-auto">
          {outputText}
        </pre>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Claude Code Card (with path detection)
// ---------------------------------------------------------------------------

const ClaudeCodeCard: React.FC<{
  pathInfo: AgentPathInfo | null;
  isResolvingPath: boolean;
  customPath: string;
  onCustomPathChange: (path: string) => void;
  onRecheckPath: () => void;
}> = ({
  pathInfo,
  isResolvingPath,
  customPath,
  onCustomPathChange,
  onRecheckPath,
}) => {
  const found = pathInfo?.available;

  const statusText = isResolvingPath
    ? "Detecting..."
    : found
      ? "Detected"
      : "Not found";

  const statusClassName = isResolvingPath
    ? "text-muted-foreground"
    : found
      ? "text-emerald-500"
      : "text-amber-500";

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ProviderIconBadge providerId="claude" size="sm" />
            <span className="text-sm font-medium">Claude Code</span>
          </div>
          <p className="text-xs text-muted-foreground mt-2 leading-5">
            Anthropic's agentic coding assistant. Uses <span className="font-mono">claude-code-acp</span> for ACP protocol streaming.
          </p>
        </div>
        <div className={cn("text-xs font-medium shrink-0", statusClassName)}>
          {statusText}
        </div>
      </div>

      {/* Path detection info */}
      {found ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Path:</span>
          <span className="font-mono text-foreground truncate">{pathInfo.path}</span>
          {pathInfo.version && (
            <>
              <span className="text-muted-foreground">|</span>
              <span className="text-muted-foreground">{pathInfo.version}</span>
            </>
          )}
        </div>
      ) : !isResolvingPath ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-500">
            Could not find <span className="font-mono">claude</span> in PATH. Install it or specify the executable path below.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => onCustomPathChange(e.target.value)}
              placeholder="e.g. /usr/local/bin/claude"
              className="flex-1 h-8 rounded-md border border-input bg-background px-3 text-sm font-mono placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button variant="outline" size="sm" onClick={onRecheckPath} disabled={!customPath.trim()}>
              <RefreshCw size={14} className="mr-1.5" />
              Check
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Tab Component
// ---------------------------------------------------------------------------

const SettingsAITab: React.FC<SettingsAITabProps> = ({
  providers,
  addProvider,
  updateProvider,
  removeProvider,
  activeProviderId,
  setActiveProviderId,
  activeModelId: _activeModelId,
  setActiveModelId,
  globalPermissionMode,
  setGlobalPermissionMode,
  externalAgents,
  setExternalAgents,
  defaultAgentId,
  setDefaultAgentId,
  commandTimeout,
  setCommandTimeout,
  maxIterations,
  setMaxIterations,
}) => {
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [codexIntegration, setCodexIntegration] = useState<CodexIntegrationStatus | null>(null);
  const [codexLoginSession, setCodexLoginSession] = useState<CodexLoginSession | null>(null);
  const [isCodexLoading, setIsCodexLoading] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  // Path detection state
  const [codexPathInfo, setCodexPathInfo] = useState<AgentPathInfo | null>(null);
  const [codexCustomPath, setCodexCustomPath] = useState("");
  const [isResolvingCodex, setIsResolvingCodex] = useState(false);

  const [claudePathInfo, setClaudePathInfo] = useState<AgentPathInfo | null>(null);
  const [claudeCustomPath, setClaudeCustomPath] = useState("");
  const [isResolvingClaude, setIsResolvingClaude] = useState(false);

  const {
    discoveredAgents,
    isDiscovering,
    enableAgent,
  } = useAgentDiscovery(externalAgents, setExternalAgents);

  // Derive path info from discovery results
  useEffect(() => {
    if (isDiscovering) return;

    const codex = discoveredAgents.find((a) => a.command === "codex");
    setCodexPathInfo(
      codex
        ? { path: codex.path, version: codex.version, available: true }
        : { path: null, version: null, available: false },
    );

    const claude = discoveredAgents.find((a) => a.command === "claude");
    setClaudePathInfo(
      claude
        ? { path: claude.path, version: claude.version, available: true }
        : { path: null, version: null, available: false },
    );
  }, [isDiscovering, discoveredAgents]);

  // Auto-register discovered agents in externalAgents
  useEffect(() => {
    if (isDiscovering || discoveredAgents.length === 0) return;

    setExternalAgents((prev) => {
      const agentsToRegister: ExternalAgentConfig[] = [];

      for (const da of discoveredAgents) {
        if (da.command !== "codex" && da.command !== "claude") continue;
        const agentId = `discovered_${da.command}`;
        if (prev.some((ea) => ea.id === agentId)) continue;
        agentsToRegister.push(enableAgent(da));
      }

      return agentsToRegister.length > 0 ? [...prev, ...agentsToRegister] : prev;
    });
  }, [isDiscovering, discoveredAgents, enableAgent, setExternalAgents]);

  // Validate a custom path for an agent
  const handleCheckCustomPath = useCallback(async (agentKey: "codex" | "claude") => {
    const bridge = getBridge();
    if (!bridge?.aiResolveCli) return;

    const customPath = agentKey === "codex" ? codexCustomPath : claudeCustomPath;
    const setInfo = agentKey === "codex" ? setCodexPathInfo : setClaudePathInfo;
    const setResolving = agentKey === "codex" ? setIsResolvingCodex : setIsResolvingClaude;

    setResolving(true);
    try {
      const result = await bridge.aiResolveCli({
        command: agentKey,
        customPath: customPath.trim(),
      });
      setInfo(result);

      // Register/update in externalAgents if valid
      if (result.available && result.path) {
        const agentId = `discovered_${agentKey}`;
        const defaults = AGENT_DEFAULTS[agentKey];
        setExternalAgents((prev) => {
          const idx = prev.findIndex((a) => a.id === agentId);
          const config: ExternalAgentConfig = {
            id: agentId,
            command: result.path!,
            enabled: true,
            ...defaults,
          };
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], command: result.path! };
            return updated;
          }
          return [...prev, config];
        });
      }
    } catch (err) {
      console.error("Path resolution failed:", err);
    } finally {
      setResolving(false);
    }
  }, [codexCustomPath, claudeCustomPath, setExternalAgents]);

  // Add a new provider from preset
  const handleAddProvider = useCallback(
    (providerId: AIProviderId) => {
      const preset = PROVIDER_PRESETS[providerId];
      const id = `provider_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      addProvider({
        id,
        providerId,
        name: preset.name,
        baseURL: preset.defaultBaseURL,
        enabled: true,
      });
      // Auto-open config form
      setEditingProviderId(id);
    },
    [addProvider],
  );

  // Remove provider with confirmation
  const handleRemoveProvider = useCallback(
    (id: string) => {
      removeProvider(id);
      if (editingProviderId === id) {
        setEditingProviderId(null);
      }
    },
    [removeProvider, editingProviderId],
  );

  // Permission mode options
  const permissionModeOptions = [
    { value: "observer", label: "Observer - Read only, no actions" },
    { value: "confirm", label: "Confirm - Ask before actions" },
    { value: "autonomous", label: "Autonomous - Execute freely" },
  ];

  // Agent options for default agent
  const agentOptions = useMemo(() => [
    { value: "catty", label: "Catty (Built-in)" },
    ...externalAgents
      .filter((a) => a.enabled)
      .map((a) => ({ value: a.id, label: a.name })),
  ], [externalAgents]);

  const hasOpenAiProviderKey = providers.some(
    (provider) => provider.providerId === "openai" && provider.enabled && !!provider.apiKey,
  );

  const refreshCodexIntegration = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexGetIntegration) return;

    setIsCodexLoading(true);
    setCodexError(null);
    try {
      const integration = await bridge.aiCodexGetIntegration();
      setCodexIntegration(integration);
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshCodexIntegration();
  }, [refreshCodexIntegration]);

  useEffect(() => {
    if (!codexLoginSession || codexLoginSession.state !== "running") {
      return;
    }

    const bridge = getBridge();
    if (!bridge?.aiCodexGetLoginSession) {
      return;
    }

    let cancelled = false;
    const intervalId = window.setInterval(() => {
      void bridge.aiCodexGetLoginSession?.(codexLoginSession.sessionId).then((result) => {
        if (cancelled || !result?.ok || !result.session) return;

        setCodexLoginSession(result.session);
        if (result.session.state !== "running") {
          if (result.session.state === "success") {
            void refreshCodexIntegration();
          }
        }
      }).catch((err) => {
        if (!cancelled) {
          setCodexError(normalizeCodexBridgeError(err));
        }
      });
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [codexLoginSession, refreshCodexIntegration]);

  const handleStartCodexLogin = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexStartLogin) return;

    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexStartLogin();
      if (!result.ok || !result.session) {
        throw new Error(result.error || "Failed to start Codex login");
      }
      setCodexLoginSession(result.session);
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, []);

  const handleCancelCodexLogin = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexCancelLogin || !codexLoginSession) return;

    setCodexError(null);
    try {
      const result = await bridge.aiCodexCancelLogin(codexLoginSession.sessionId);
      if (result.session) {
        setCodexLoginSession(result.session);
      }
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    }
  }, [codexLoginSession]);

  const handleOpenCodexLoginUrl = useCallback(() => {
    const bridge = getBridge();
    const url = codexLoginSession?.url;
    if (!bridge?.openExternal || !url) return;
    void bridge.openExternal(url);
  }, [codexLoginSession]);

  const handleCodexLogout = useCallback(async () => {
    const bridge = getBridge();
    if (!bridge?.aiCodexLogout) return;

    setCodexError(null);
    setIsCodexLoading(true);
    try {
      const result = await bridge.aiCodexLogout();
      if (!result.ok) {
        throw new Error(result.error || "Failed to log out from Codex");
      }
      setCodexLoginSession(null);
      await refreshCodexIntegration();
    } catch (err) {
      setCodexError(normalizeCodexBridgeError(err));
    } finally {
      setIsCodexLoading(false);
    }
  }, [refreshCodexIntegration]);

  return (
    <TabsContent
      value="ai"
      className="data-[state=inactive]:hidden h-full flex flex-col"
    >
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-8 py-6">
        <div className="max-w-2xl space-y-8">
          {/* Header */}
          <div>
            <h2 className="text-xl font-semibold">AI</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Configure AI providers, agents, and safety settings
            </p>
          </div>

          {/* ── Providers Section ── */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe size={18} className="text-muted-foreground" />
                <h3 className="text-base font-medium">Providers</h3>
              </div>
              <AddProviderDropdown onAdd={handleAddProvider} />
            </div>

            {providers.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 p-6 text-center">
                <Bot size={24} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">
                  No providers configured. Add a provider to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    isActive={provider.id === activeProviderId}
                    onToggleEnabled={(enabled) => {
                      if (enabled) {
                        // Activate this provider, deactivate others
                        setActiveProviderId(provider.id);
                        if (provider.defaultModel) {
                          setActiveModelId(provider.defaultModel);
                        }
                        // Ensure it's enabled
                        if (!provider.enabled) {
                          updateProvider(provider.id, { enabled: true });
                        }
                      } else {
                        // Deactivate: clear active provider if this was it
                        if (activeProviderId === provider.id) {
                          setActiveProviderId("");
                          setActiveModelId("");
                        }
                        updateProvider(provider.id, { enabled: false });
                      }
                    }}
                    onEdit={() =>
                      setEditingProviderId(
                        editingProviderId === provider.id ? null : provider.id,
                      )
                    }
                    onRemove={() => handleRemoveProvider(provider.id)}
                    onUpdate={(updates) => {
                      updateProvider(provider.id, updates);
                      // If this is the active provider and model changed, update activeModelId
                      if (provider.id === activeProviderId && updates.defaultModel !== undefined) {
                        setActiveModelId(updates.defaultModel || "");
                      }
                    }}
                    isEditing={editingProviderId === provider.id}
                    onCancelEdit={() => setEditingProviderId(null)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* ── Codex Section ── */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ProviderIconBadge providerId="openai" size="sm" />
              <h3 className="text-base font-medium">Codex</h3>
            </div>

            <CodexConnectionCard
              pathInfo={codexPathInfo}
              isResolvingPath={isDiscovering || isResolvingCodex}
              customPath={codexCustomPath}
              onCustomPathChange={setCodexCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("codex")}
              integration={codexIntegration}
              loginSession={codexLoginSession}
              isLoading={isCodexLoading}
              hasOpenAiProviderKey={hasOpenAiProviderKey}
              error={codexError}
              onRefresh={() => void refreshCodexIntegration()}
              onConnect={() => void handleStartCodexLogin()}
              onCancel={() => void handleCancelCodexLogin()}
              onOpenUrl={handleOpenCodexLoginUrl}
              onLogout={() => void handleCodexLogout()}
            />
          </div>

          {/* ── Claude Code Section ── */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <ProviderIconBadge providerId="claude" size="sm" />
              <h3 className="text-base font-medium">Claude Code</h3>
            </div>

            <ClaudeCodeCard
              pathInfo={claudePathInfo}
              isResolvingPath={isDiscovering || isResolvingClaude}
              customPath={claudeCustomPath}
              onCustomPathChange={setClaudeCustomPath}
              onRecheckPath={() => void handleCheckCustomPath("claude")}
            />
          </div>

          {/* ── Default Agent Section ── */}
          {agentOptions.length > 1 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Bot size={18} className="text-muted-foreground" />
                <h3 className="text-base font-medium">Default Agent</h3>
              </div>

              <div className="bg-muted/30 rounded-lg p-4">
                <SettingRow
                  label="Default Agent"
                  description="Agent to use when starting a new AI session"
                >
                  <Select
                    value={defaultAgentId}
                    options={agentOptions}
                    onChange={setDefaultAgentId}
                    className="w-48"
                  />
                </SettingRow>
              </div>
            </div>
          )}

          {/* ── Safety Section ── */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Shield size={18} className="text-muted-foreground" />
              <h3 className="text-base font-medium">Safety</h3>
            </div>

            <div className="bg-muted/30 rounded-lg p-4 space-y-1">
              <SettingRow
                label="Permission Mode"
                description="Controls how the AI interacts with your terminals"
              >
                <Select
                  value={globalPermissionMode}
                  options={permissionModeOptions}
                  onChange={(val) => setGlobalPermissionMode(val as AIPermissionMode)}
                  className="w-64"
                />
              </SettingRow>

              <SettingRow
                label="Command Timeout"
                description="Maximum seconds a command can run before being terminated"
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={commandTimeout}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val) && val > 0) setCommandTimeout(val);
                    }}
                    min={1}
                    max={3600}
                    className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  />
                  <span className="text-xs text-muted-foreground">sec</span>
                </div>
              </SettingRow>

              <SettingRow
                label="Max Iterations"
                description="Maximum number of AI tool-use loops to prevent runaway execution"
              >
                <input
                  type="number"
                  value={maxIterations}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10);
                    if (!isNaN(val) && val > 0) setMaxIterations(val);
                  }}
                  min={1}
                  max={100}
                  className="w-20 h-9 rounded-md border border-input bg-background px-3 text-sm text-right focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </SettingRow>
            </div>

            <p className="text-xs text-muted-foreground">
              Safety settings apply globally. Per-host overrides can be configured in the connection settings.
            </p>
          </div>
        </div>
      </div>
    </TabsContent>
  );
};

export default SettingsAITab;
