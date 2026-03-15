/**
 * AIChatSidePanel - Main AI chat interface side panel
 *
 * Zed-style agent panel with agent selector, scoped chat sessions,
 * message list, input area, and session history drawer.
 */

import {
  History,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { streamText, stepCountIs } from 'ai';
import { cn } from '../lib/utils';
import { useI18n } from '../application/i18n/I18nProvider';
import { PermissionDialog } from './ai/PermissionDialog';
import { useWindowControls } from '../application/state/useWindowControls';
import { useImageUpload } from '../application/state/useImageUpload';
import type {
  AIPermissionMode,
  AISession,
  AISessionScope,
  ChatMessage,
  DiscoveredAgent,
  ExternalAgentConfig,
  ProviderConfig,
} from '../infrastructure/ai/types';
import { getAgentModelPresets } from '../infrastructure/ai/types';
import { buildSystemPrompt } from '../infrastructure/ai/cattyAgent/systemPrompt';
import { createModelFromConfig } from '../infrastructure/ai/sdk/providers';
import { createCattyTools } from '../infrastructure/ai/sdk/tools';
import { exportAsMarkdown, exportAsJSON, exportAsPlainText, getExportFilename } from '../infrastructure/ai/conversationExport';
import { runExternalAgentTurn } from '../infrastructure/ai/externalAgentAdapter';
import { runAcpAgentTurn } from '../infrastructure/ai/acpAgentAdapter';
import { useAgentDiscovery } from '../application/state/useAgentDiscovery';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import AgentSelector from './ai/AgentSelector';
import ChatInput from './ai/ChatInput';
import ChatMessageList from './ai/ChatMessageList';
import ConversationExport from './ai/ConversationExport';

// -------------------------------------------------------------------
// Props
// -------------------------------------------------------------------

interface AIChatSidePanelProps {
  // Session state (per-scope)
  sessions: AISession[];
  activeSessionIdMap: Record<string, string | null>;
  setActiveSessionId: (scopeKey: string, id: string | null) => void;
  createSession: (scope: AISessionScope, agentId?: string) => AISession;
  deleteSession: (sessionId: string, scopeKey?: string) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  addMessageToSession: (sessionId: string, message: ChatMessage) => void;
  updateLastMessage: (
    sessionId: string,
    updater: (msg: ChatMessage) => ChatMessage,
  ) => void;
  // Provider config
  providers: ProviderConfig[];
  activeProviderId: string;
  activeModelId: string;

  // Agent info
  defaultAgentId: string;
  externalAgents: ExternalAgentConfig[];
  setExternalAgents?: (value: ExternalAgentConfig[] | ((prev: ExternalAgentConfig[]) => ExternalAgentConfig[])) => void;
  agentModelMap: Record<string, string>;
  setAgentModel: (agentId: string, modelId: string) => void;

  // Safety
  globalPermissionMode: AIPermissionMode;
  commandBlocklist?: string[];
  maxIterations?: number;

  // Context
  scopeType: 'terminal' | 'workspace';
  scopeTargetId?: string;
  scopeHostIds?: string[];
  scopeLabel?: string;

  // Terminal session context (from parent)
  terminalSessions?: Array<{
    sessionId: string;
    hostId: string;
    hostname: string;
    label: string;
    os?: string;
    username?: string;
    connected: boolean;
  }>;

  // Visibility
  isVisible?: boolean;
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// -------------------------------------------------------------------
// Component
// -------------------------------------------------------------------

const AIChatSidePanelInner: React.FC<AIChatSidePanelProps> = ({
  sessions,
  activeSessionIdMap,
  setActiveSessionId: setActiveSessionIdForScope,
  createSession,
  deleteSession,
  updateSessionTitle,
  addMessageToSession,
  updateLastMessage,
  providers,
  activeProviderId,
  activeModelId,
  defaultAgentId,
  externalAgents,
  setExternalAgents,
  agentModelMap,
  setAgentModel,
  globalPermissionMode,
  commandBlocklist,
  maxIterations = 20,
  scopeType,
  scopeTargetId,
  scopeHostIds,
  scopeLabel,
  terminalSessions = [],
  isVisible = true,
}) => {
  const { t } = useI18n();
  // ── Per-scope state ──
  // Derive scope key for per-scope isolation
  const scopeKey = `${scopeType}:${scopeTargetId ?? ''}`;

  // Per-scope input values
  const [inputValueMap, setInputValueMap] = useState<Record<string, string>>({});
  const inputValue = inputValueMap[scopeKey] ?? '';
  const setInputValue = useCallback((val: string) => {
    setInputValueMap(prev => ({ ...prev, [scopeKey]: val }));
  }, [scopeKey]);

  // Per-scope streaming state
  const [streamingScopes, setStreamingScopes] = useState<Set<string>>(new Set());
  const isStreaming = streamingScopes.has(scopeKey);
  const setStreamingForScope = useCallback((key: string, val: boolean) => {
    setStreamingScopes(prev => {
      const next = new Set(prev);
      if (val) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  const [showHistory, setShowHistory] = useState(false);
  const [currentAgentId, setCurrentAgentId] = useState(defaultAgentId);

  // Per-scope abort controllers
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  // Permission dialog state for confirm mode
  const [pendingApproval, setPendingApproval] = useState<{
    toolCall: { name: string; arguments: Record<string, unknown> };
  } | null>(null);
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const { images, addImages, removeImage, clearImages } = useImageUpload();
  const { openSettingsWindow } = useWindowControls();

  // Per-scope active session ID
  const activeSessionId = activeSessionIdMap[scopeKey] ?? null;
  const setActiveSessionId = useCallback((id: string | null) => {
    setActiveSessionIdForScope(scopeKey, id);
  }, [scopeKey, setActiveSessionIdForScope]);

  // Restore agent selector from active session when scope changes
  useEffect(() => {
    if (activeSessionId) {
      const session = sessions.find((s) => s.id === activeSessionId);
      if (session) {
        setCurrentAgentId(session.agentId);
      }
    }
  }, [scopeKey, activeSessionId, sessions]);

  // Proactively sync terminal session metadata to main process whenever scope or sessions change
  useEffect(() => {
    const bridge = (window as unknown as { netcatty?: { aiMcpUpdateSessions?: (sessions: typeof terminalSessions, chatSessionId?: string) => Promise<unknown> } }).netcatty;
    if (bridge?.aiMcpUpdateSessions && terminalSessions.length > 0) {
      console.log('[AIChatPanel] Syncing terminalSessions to MCP:', scopeKey, terminalSessions.length, terminalSessions.map(s => s.sessionId));
      void bridge.aiMcpUpdateSessions(terminalSessions, activeSessionId ?? undefined);
    }
  }, [terminalSessions, scopeKey, activeSessionId]);

  // Agent discovery
  const {
    discoveredAgents,
    isDiscovering,
    rediscover,
    enableAgent,
  } = useAgentDiscovery(externalAgents, setExternalAgents);

  const handleEnableDiscoveredAgent = useCallback(
    (agent: DiscoveredAgent) => {
      const config = enableAgent(agent);
      setExternalAgents?.((prev) => [...prev, config]);
    },
    [enableAgent, setExternalAgents],
  );

  // Active session (scoped)
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const messages = activeSession?.messages ?? [];

  // Active provider info
  const activeProvider = useMemo(
    () => providers.find((p) => p.id === activeProviderId),
    [providers, activeProviderId],
  );

  const providerDisplayName = activeProvider?.name ?? '';
  const modelDisplayName = activeModelId || activeProvider?.defaultModel || '';

  // Agent model presets for the current external agent
  const currentAgentConfig = useMemo(
    () => currentAgentId !== 'catty' ? externalAgents.find(a => a.id === currentAgentId) : undefined,
    [currentAgentId, externalAgents],
  );
  const agentModelPresets = useMemo(
    () => getAgentModelPresets(currentAgentConfig?.command),
    [currentAgentConfig?.command],
  );

  // Per-agent model: recall last selection or use first preset as default
  const selectedAgentModel = useMemo(() => {
    const stored = agentModelMap[currentAgentId];
    if (stored && agentModelPresets.some(p => stored === p.id || stored.startsWith(p.id + '/'))) {
      return stored;
    }
    // Default to first preset if available
    return agentModelPresets.length > 0 ? agentModelPresets[0].id : undefined;
  }, [currentAgentId, agentModelMap, agentModelPresets]);

  const handleAgentModelSelect = useCallback((modelId: string) => {
    setAgentModel(currentAgentId, modelId);
  }, [currentAgentId, setAgentModel]);

  // Filtered sessions for history (matching current scope type)
  const historySessions = useMemo(
    () =>
      sessions
        .filter((s) => s.scope.type === scopeType && s.scope.targetId === scopeTargetId)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, scopeType, scopeTargetId],
  );

  // -------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------

  const handleNewChat = useCallback(() => {
    const scope: AISessionScope = {
      type: scopeType,
      targetId: scopeTargetId,
      hostIds: scopeHostIds,
    };
    const session = createSession(scope, currentAgentId);
    setActiveSessionId(session.id);
    setShowHistory(false);
    setInputValue('');
  }, [
    scopeType,
    scopeTargetId,
    scopeHostIds,
    currentAgentId,
    createSession,
    setActiveSessionId,
    setInputValue,
  ]);

  const handleOpenSettings = useCallback(() => {
    void openSettingsWindow();
  }, [openSettingsWindow]);

  const handleSend = useCallback(async () => {
    const trimmed = inputValue.trim();
    // Capture scope key at send time so async callbacks use the correct scope
    const sendScopeKey = scopeKey;
    console.log('[AIChatPanel] handleSend called, trimmed:', JSON.stringify(trimmed?.slice(0, 50)), 'isStreaming:', isStreaming, 'currentAgentId:', currentAgentId, 'scopeKey:', sendScopeKey);
    if (!trimmed || isStreaming) return;

    const isExternalAgent = currentAgentId !== 'catty';
    console.log('[AIChatPanel] isExternalAgent:', isExternalAgent, 'activeProvider:', activeProvider?.id);

    // For built-in agent, we need a provider configured
    if (!isExternalAgent && !activeProvider) {
      // Create a session so the user message and error are visible in the chat
      let errSessionId = activeSessionId;
      if (!errSessionId) {
        const scope: AISessionScope = { type: scopeType, targetId: scopeTargetId, hostIds: scopeHostIds };
        const session = createSession(scope, currentAgentId);
        errSessionId = session.id;
        setActiveSessionId(errSessionId);
      }
      addMessageToSession(errSessionId, {
        id: generateId(), role: 'user', content: trimmed, timestamp: Date.now(),
      });
      addMessageToSession(errSessionId, {
        id: generateId(), role: 'assistant', content: t('ai.chat.noProvider'), timestamp: Date.now(),
      });
      setInputValue('');
      return;
    }

    // Create session if needed
    let sessionId = activeSessionId;
    if (!sessionId) {
      const scope: AISessionScope = {
        type: scopeType,
        targetId: scopeTargetId,
        hostIds: scopeHostIds,
      };
      const session = createSession(scope, currentAgentId);
      sessionId = session.id;
      setActiveSessionId(sessionId);
    }

    // Capture images before clearing
    const attachedImages = images.map(img => ({ base64Data: img.base64Data, mediaType: img.mediaType, filename: img.filename }));

    // Add user message (with images if any)
    const userMessage: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: trimmed,
      ...(attachedImages.length > 0 ? { images: attachedImages } : {}),
      timestamp: Date.now(),
    };
    addMessageToSession(sessionId, userMessage);
    setInputValue('');
    clearImages();
    setStreamingForScope(sendScopeKey, true);

    // Create assistant message placeholder for streaming
    const agentConfig = isExternalAgent
      ? externalAgents.find(a => a.id === currentAgentId)
      : undefined;
    addMessageToSession(sessionId, {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      model: isExternalAgent ? (agentConfig?.name || 'external') : (activeModelId || activeProvider?.defaultModel || ''),
      providerId: isExternalAgent ? undefined : activeProvider?.providerId,
    });

    // Abort controller for cancellation (per-scope)
    const abortController = new AbortController();
    abortControllersRef.current.set(sendScopeKey, abortController);

    // Get current session for context
    const currentSession = sessions.find((s) => s.id === sessionId);

    console.log('[AIChatPanel] agentConfig:', agentConfig ? { id: agentConfig.id, name: agentConfig.name, sdkType: agentConfig.sdkType, acpCommand: agentConfig.acpCommand } : 'catty');

    if (isExternalAgent) {
      if (!agentConfig) {
        updateLastMessage(sessionId, msg => ({
          ...msg,
          content: 'External agent not found. Please check settings.',
          executionStatus: 'failed',
        }));
        setStreamingForScope(sendScopeKey, false);
        return;
      }

      const bridge = (window as unknown as { netcatty?: Record<string, unknown> }).netcatty as
        Record<string, (...args: unknown[]) => unknown> | undefined;

      console.log('[AIChatPanel] bridge available:', !!bridge, 'sdkType:', agentConfig.sdkType, 'acpCommand:', agentConfig.acpCommand);

      if (agentConfig.acpCommand && bridge) {
        // Use ACP protocol if the agent supports it
        const requestId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        console.log('[AIChatPanel] → ACP path, requestId:', requestId, 'acpCommand:', agentConfig.acpCommand);

        // Push terminal session metadata to MCP bridge before streaming (with chatSessionId for per-scope isolation)
        const mcpBridge = bridge as unknown as { aiMcpUpdateSessions?: (sessions: typeof terminalSessions, chatSessionId?: string) => Promise<unknown> };
        console.log('[AIChatPanel] terminalSessions for MCP update:', terminalSessions.length, terminalSessions.map(s => s.sessionId));
        if (mcpBridge.aiMcpUpdateSessions) {
          await mcpBridge.aiMcpUpdateSessions(terminalSessions, sessionId!);
        }

        // Try to find an API key from configured providers for this agent
        const openaiProvider = providers.find(p => p.providerId === 'openai' && p.enabled && p.apiKey);
        const agentApiKey = openaiProvider?.apiKey;

        try {
          // Mutable flag: set after tool-result, cleared when new assistant msg is created
          let needsNewAssistantMsg = false;

          const maybeCreateAssistantMsg = () => {
            if (needsNewAssistantMsg) {
              needsNewAssistantMsg = false;
              addMessageToSession(sessionId!, {
                id: generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                model: agentConfig?.name || 'external',
              });
            }
          };

          await runAcpAgentTurn(
            bridge,
            requestId,
            sessionId!,
            agentConfig,
            trimmed,
            {
              onTextDelta: (text: string) => {
                maybeCreateAssistantMsg();
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  content: msg.content + text,
                  thinkingDurationMs: msg.thinking && !msg.thinkingDurationMs
                    ? Date.now() - msg.timestamp
                    : msg.thinkingDurationMs,
                }));
              },
              onThinkingDelta: (text: string) => {
                maybeCreateAssistantMsg();
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  thinking: (msg.thinking || '') + text,
                }));
              },
              onThinkingDone: () => {
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  thinkingDurationMs: msg.thinkingDurationMs || (Date.now() - msg.timestamp),
                }));
              },
              onToolCall: (toolName: string, args: Record<string, unknown>) => {
                maybeCreateAssistantMsg();
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  toolCalls: [...(msg.toolCalls || []), {
                    id: `tc_${Date.now()}`,
                    name: toolName,
                    arguments: args,
                  }],
                  executionStatus: 'running',
                }));
              },
              onToolResult: (toolCallId: string, result: string) => {
                // Mark previous assistant message's tool calls as completed
                updateLastMessage(sessionId!, msg => {
                  if (msg.role === 'assistant' && msg.executionStatus === 'running') {
                    return { ...msg, executionStatus: 'completed' };
                  }
                  return msg;
                });
                addMessageToSession(sessionId!, {
                  id: generateId(),
                  role: 'tool',
                  content: '',
                  toolResults: [{ toolCallId, content: result, isError: false }],
                  timestamp: Date.now(),
                  executionStatus: 'completed',
                });
                // Next text/thinking/toolCall should go into a new assistant message
                needsNewAssistantMsg = true;
              },
              onError: (error: string) => {
                maybeCreateAssistantMsg();
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  content: msg.content + '\n\n**Error:** ' + error,
                  executionStatus: 'failed',
                }));
              },
              onDone: () => {},
            },
            abortController.signal,
            agentApiKey,
            selectedAgentModel,
            attachedImages.length > 0 ? attachedImages : undefined,
          );
        } catch (err) {
          if (!abortController.signal.aborted) {
            updateLastMessage(sessionId!, msg => ({
              ...msg,
              content: msg.content + '\n\n**Error:** ' + (err instanceof Error ? err.message : String(err)),
            }));
          }
        }
      } else {
        // Fallback: spawn as raw process
        try {
          await runExternalAgentTurn(
            agentConfig,
            trimmed,
            {
              onTextDelta: (text: string) => {
                updateLastMessage(sessionId!, msg => ({ ...msg, content: msg.content + text }));
              },
              onError: (error: string) => {
                updateLastMessage(sessionId!, msg => ({
                  ...msg,
                  content: msg.content + '\n\n**Error:** ' + error,
                  executionStatus: 'failed',
                }));
              },
              onDone: () => {},
            },
            bridge as Parameters<typeof runExternalAgentTurn>[3],
            abortController.signal,
          );
        } catch (err) {
          if (!abortController.signal.aborted) {
            updateLastMessage(sessionId!, msg => ({
              ...msg,
              content: msg.content + '\n\n**Error:** ' + (err instanceof Error ? err.message : String(err)),
            }));
          }
        }
      }

      setStreamingForScope(sendScopeKey, false);
      abortControllersRef.current.delete(sendScopeKey);
      if (
        currentSession &&
        (!currentSession.title || currentSession.title === 'New Chat')
      ) {
        const title =
          trimmed.length > 50 ? trimmed.slice(0, 50) + '...' : trimmed;
        updateSessionTitle(sessionId!, title);
      }
      return;
    }

    // --- Catty Agent: Vercel AI SDK streamText ---
    const bridge = (window as unknown as { netcatty?: Record<string, unknown> }).netcatty;
    const tools = createCattyTools(bridge, {
      sessions: terminalSessions,
      workspaceId: scopeTargetId,
      workspaceName: scopeLabel,
    }, commandBlocklist, globalPermissionMode);

    const systemPrompt = buildSystemPrompt({
      scopeType,
      scopeLabel,
      hosts: terminalSessions.map(s => ({
        sessionId: s.sessionId,
        hostname: s.hostname,
        label: s.label,
        os: s.os,
        username: s.username,
        connected: s.connected,
      })),
      permissionMode: globalPermissionMode,
    });

    // Decrypt API key before passing to SDK
    let decryptedApiKey = activeProvider.apiKey;
    if (decryptedApiKey && bridge?.credentialsDecrypt) {
      try {
        decryptedApiKey = await (bridge as { credentialsDecrypt: (v: string) => Promise<string> }).credentialsDecrypt(decryptedApiKey) ?? decryptedApiKey;
      } catch (e) {
        console.warn('[Catty] API key decryption failed:', e);
      }
    }

    console.log('[Catty] Creating model:', {
      providerId: activeProvider.providerId,
      baseURL: activeProvider.baseURL,
      hasApiKey: !!decryptedApiKey,
      model: activeModelId || activeProvider.defaultModel || '',
    });

    const model = createModelFromConfig({
      ...activeProvider,
      apiKey: decryptedApiKey,
      defaultModel: activeModelId || activeProvider.defaultModel || '',
    });

    try {
      // Build message array for the SDK.
      // Only include user and assistant TEXT messages — tool call/result
      // history is managed internally by each streamText invocation.
      const sdkMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      for (const m of (currentSession?.messages ?? [])) {
        if (m.role === 'user') {
          sdkMessages.push({ role: 'user', content: m.content });
        } else if (m.role === 'assistant' && m.content) {
          sdkMessages.push({ role: 'assistant', content: m.content });
        }
        // Skip tool messages and empty assistant messages (tool-call-only)
      }
      sdkMessages.push({ role: 'user', content: trimmed });

      console.log('[Catty] streamText request:', {
        modelId: model.modelId,
        messageCount: sdkMessages.length,
        hasTools: Object.keys(tools).length,
        systemPromptLength: systemPrompt.length,
      });

      const result = streamText({
        model,
        messages: sdkMessages,
        system: systemPrompt,
        tools,
        stopWhen: stepCountIs(maxIterations),
        abortSignal: abortController.signal,
      });

      // Stream the response using getReader() to avoid Electron stream hanging issues
      let chunkIndex = 0;
      // Track last message role locally (React state is stale in async closures)
      let lastAddedRole: 'assistant' | 'tool' = 'assistant';
      const reader = result.fullStream.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (chunkIndex < 10) {
          console.log(`[Catty] chunk[${chunkIndex}]:`, JSON.stringify(chunk).slice(0, 200));
        }
        chunkIndex++;
        switch (chunk.type) {
          case 'text':
          case 'text-delta': {
            const text = (chunk as unknown as { text?: string; textDelta?: string }).text
              ?? (chunk as unknown as { textDelta?: string }).textDelta;
            if (text) {
              // If last message was a tool result, create a new assistant message first
              if (lastAddedRole === 'tool') {
                addMessageToSession(sessionId!, {
                  id: generateId(),
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                });
                lastAddedRole = 'assistant';
              }
              updateLastMessage(sessionId!, msg => ({
                ...msg,
                content: msg.content + text,
              }));
            }
            break;
          }
          case 'reasoning':
          case 'reasoning-start':
          case 'reasoning-delta': {
            const rText = (chunk as unknown as { text?: string }).text;
            if (rText) {
              if (lastAddedRole === 'tool') {
                addMessageToSession(sessionId!, {
                  id: generateId(),
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                });
                lastAddedRole = 'assistant';
              }
              updateLastMessage(sessionId!, msg => ({
                ...msg,
                thinking: (msg.thinking || '') + rText,
              }));
            }
            break;
          }
          case 'reasoning-end':
          case 'text-start':
          case 'text-end':
          case 'start':
          case 'finish':
          case 'start-step':
          case 'finish-step':
            // Lifecycle events, no action needed
            break;
          case 'tool-call':
            console.log(`[Catty] tool-call: ${chunk.toolName}`);
            updateLastMessage(sessionId!, msg => ({
              ...msg,
              toolCalls: [...(msg.toolCalls || []), {
                id: chunk.toolCallId,
                name: chunk.toolName,
                arguments: (chunk as unknown as { input?: unknown; args?: unknown }).input ?? (chunk as unknown as { args?: unknown }).args,
              }],
              executionStatus: 'running',
            }));
            break;
          case 'tool-result': {
            const toolOutput = (chunk as unknown as { output?: unknown; result?: unknown }).output ?? (chunk as unknown as { result?: unknown }).result;
            console.log(`[Catty] tool-result: ${chunk.toolCallId}`);
            addMessageToSession(sessionId!, {
              id: generateId(),
              role: 'tool',
              content: '',
              toolResults: [{
                toolCallId: chunk.toolCallId,
                content: typeof toolOutput === 'string'
                  ? toolOutput
                  : JSON.stringify(toolOutput),
                isError: false,
              }],
              timestamp: Date.now(),
              executionStatus: 'completed',
            });
            lastAddedRole = 'tool';
            break;
          }
          case 'tool-approval-request': {
            const approvalChunk = chunk as unknown as {
              approvalId: string;
              toolCallId: string;
              toolCall: { toolName: string; input: Record<string, unknown> };
            };
            console.log(`[Catty] tool-approval-request: ${approvalChunk.toolCall.toolName}`, approvalChunk.approvalId);

            // Show PermissionDialog and wait for user response
            const approved = await new Promise<boolean>((resolve) => {
              approvalResolverRef.current = resolve;
              setPendingApproval({
                toolCall: {
                  name: approvalChunk.toolCall.toolName,
                  arguments: approvalChunk.toolCall.input || {},
                },
              });
            });
            setPendingApproval(null);
            approvalResolverRef.current = null;

            if (!approved) {
              // User rejected — add a denial message and stop
              updateLastMessage(sessionId!, msg => ({
                ...msg,
                content: msg.content + (msg.content ? '\n\n' : '') + t('ai.chat.toolDenied'),
                executionStatus: 'completed',
              }));
            }
            // Note: whether approved or denied, the stream has already ended for this step.
            // The SDK requires a new streamText call with approval response in messages
            // to continue. For now, we show the result — full multi-turn approval loop
            // can be added later.
            break;
          }
          case 'error':
            updateLastMessage(sessionId!, msg => ({
              ...msg,
              content: msg.content + '\n\n**Error:** ' + String(chunk.error),
              executionStatus: 'failed',
            }));
            break;
          default:
            // tool-input-start/delta/end, tool-output-denied, and other types
            break;
        }
      }
      console.log(`[Catty] stream finished, total chunks: ${chunkIndex}`);
    } catch (err) {
      console.error('[Catty] streamText error:', err);
      if (!abortController.signal.aborted) {
        updateLastMessage(sessionId!, msg => ({
          ...msg,
          content: msg.content + '\n\n**Error:** ' + (err instanceof Error ? err.message : String(err)),
        }));
      }
    } finally {
      setStreamingForScope(sendScopeKey, false);
      abortControllersRef.current.delete(sendScopeKey);
      // Auto-title the session from first user message
      const finalSession = sessions.find(s => s.id === sessionId);
      if (
        finalSession &&
        (!finalSession.title || finalSession.title === 'New Chat')
      ) {
        const title =
          trimmed.length > 50 ? trimmed.slice(0, 50) + '...' : trimmed;
        updateSessionTitle(sessionId!, title);
      }
    }
  }, [
    inputValue,
    isStreaming,
    activeProvider,
    activeSessionId,
    scopeKey,
    scopeType,
    scopeTargetId,
    scopeHostIds,
    scopeLabel,
    currentAgentId,
    activeModelId,
    globalPermissionMode,
    commandBlocklist,
    maxIterations,
    providers,
    sessions,
    externalAgents,
    terminalSessions,
    createSession,
    setActiveSessionId,
    setStreamingForScope,
    addMessageToSession,
    updateLastMessage,
    updateSessionTitle,
    selectedAgentModel,
    images,
    clearImages,
    setInputValue,
    t,
  ]);

  const handleStop = useCallback(() => {
    const controller = abortControllersRef.current.get(scopeKey);
    controller?.abort();
    abortControllersRef.current.delete(scopeKey);
    setStreamingForScope(scopeKey, false);
  }, [scopeKey, setStreamingForScope]);

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setActiveSessionId(sessionId);
      // Restore agent selector to match the session's bound agent
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        setCurrentAgentId(session.agentId);
      }
      setShowHistory(false);
    },
    [setActiveSessionId, sessions],
  );

  const handleDeleteSession = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      const bridge = (window as unknown as { netcatty?: { aiAcpCleanup?: (chatSessionId: string) => Promise<{ ok: boolean }> } }).netcatty;
      void bridge?.aiAcpCleanup?.(sessionId).catch(() => {});
      deleteSession(sessionId, scopeKey);
      // Active session clearing is handled by deleteSession with scopeKey
    },
    [deleteSession, scopeKey],
  );

  const handleAgentChange = useCallback((agentId: string) => {
    setCurrentAgentId(agentId);
    // Switching agent deactivates current session; a new one is created on next send
    setActiveSessionId(null);
  }, [setActiveSessionId]);

  const handleExport = useCallback((format: 'md' | 'json' | 'txt') => {
    if (!activeSession) return;
    let content: string;
    switch (format) {
      case 'md': content = exportAsMarkdown(activeSession); break;
      case 'json': content = exportAsJSON(activeSession); break;
      case 'txt': content = exportAsPlainText(activeSession); break;
    }
    const filename = getExportFilename(activeSession, format);
    // Create a download blob
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [activeSession]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  if (!isVisible) return null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Header ── */}
      <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-border/50 shrink-0">
        <AgentSelector
          currentAgentId={currentAgentId}
          externalAgents={externalAgents}
          discoveredAgents={discoveredAgents}
          isDiscovering={isDiscovering}
          onSelectAgent={handleAgentChange}
          onEnableDiscoveredAgent={handleEnableDiscoveredAgent}
          onRediscover={rediscover}
          onManageAgents={handleOpenSettings}
        />
        <div className="flex items-center gap-0.5">
          <ConversationExport
            session={activeSession}
            onExport={handleExport}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground/62 hover:bg-white/[0.05] hover:text-foreground"
            onClick={() => setShowHistory(!showHistory)}
            title="Session history"
          >
            <History size={14} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-primary/82 hover:bg-primary/[0.10] hover:text-primary"
            onClick={handleNewChat}
            title="New chat"
          >
            <Plus size={15} />
          </Button>
        </div>
      </div>

      {/* ── Main content ── */}
      {showHistory ? (
        <SessionHistoryDrawer
          sessions={historySessions}
          activeSessionId={activeSessionId}
          onSelect={handleSelectSession}
          onDelete={handleDeleteSession}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <>
          {/* Chat messages */}
          <ChatMessageList messages={messages} isStreaming={isStreaming} />

          {/* Recent sessions (Zed-style, shown when no messages) */}
          {messages.length === 0 && historySessions.length > 0 && (
            <div className="shrink-0 px-4 pb-1">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-[11px] text-muted-foreground/30 tracking-wide">{t('ai.chat.recent')}</span>
                <button
                  onClick={() => setShowHistory(true)}
                  className="text-[11px] text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors cursor-pointer"
                >
                  {t('ai.chat.viewAll')}
                </button>
              </div>
              {historySessions.slice(0, 3).map((session) => (
                <button
                  key={session.id}
                  onClick={() => handleSelectSession(session.id)}
                  className="w-full flex items-baseline justify-between py-1.5 text-left hover:text-foreground transition-colors cursor-pointer"
                >
                  <span className="text-[13px] text-foreground/60 truncate pr-4">
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <span className="text-[11px] text-muted-foreground/25 shrink-0">
                    {formatRelativeTime(new Date(session.updatedAt), t)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Input area */}
          <ChatInput
            value={inputValue}
            onChange={setInputValue}
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            providerName={providerDisplayName}
            modelName={modelDisplayName}
            agentName={currentAgentId === 'catty' ? 'Catty Agent' : externalAgents.find(a => a.id === currentAgentId)?.name}
            modelPresets={agentModelPresets}
            selectedModelId={selectedAgentModel}
            onModelSelect={handleAgentModelSelect}
            images={images}
            onAddImages={addImages}
            onRemoveImage={removeImage}
            hosts={terminalSessions.map(s => ({ sessionId: s.sessionId, hostname: s.hostname, label: s.label, connected: s.connected }))}
          />
        </>
      )}

      {/* Permission approval dialog for confirm mode */}
      <PermissionDialog
        open={!!pendingApproval}
        toolCall={pendingApproval?.toolCall ?? null}
        recommendation="confirm"
        onApprove={() => approvalResolverRef.current?.(true)}
        onReject={() => approvalResolverRef.current?.(false)}
        onDismiss={() => approvalResolverRef.current?.(false)}
      />
    </div>
  );
};

// -------------------------------------------------------------------
// Session History Drawer
// -------------------------------------------------------------------

interface SessionHistoryDrawerProps {
  sessions: AISession[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (e: React.MouseEvent, sessionId: string) => void;
  onClose: () => void;
}

const SessionHistoryDrawer: React.FC<SessionHistoryDrawerProps> = ({
  sessions,
  activeSessionId,
  onSelect,
  onDelete,
  onClose,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-2.5 flex items-center justify-between shrink-0 border-b border-border/30">
        <span className="text-[13px] font-medium text-foreground/80">{t('ai.chat.allSessions')}</span>
        <button
          onClick={onClose}
          className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      </div>
      <ScrollArea className="flex-1">
        <div className="px-3">
          {sessions.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-[13px] text-muted-foreground/40">
                {t('ai.chat.noSessions')}
              </p>
            </div>
          ) : (
            sessions.map((session) => {
              const isActive = session.id === activeSessionId;
              const time = new Date(session.updatedAt);
              const timeStr = formatRelativeTime(time, t);

              return (
                <button
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  className={cn(
                    'w-full flex items-center justify-between py-2.5 border-b border-border/20 text-left transition-colors cursor-pointer group',
                    isActive ? 'text-foreground' : 'text-foreground/70 hover:text-foreground',
                  )}
                >
                  <span className="text-[13px] truncate pr-3 flex-1 min-w-0">
                    {session.title || t('ai.chat.untitled')}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[12px] text-muted-foreground/50">
                      {timeStr}
                    </span>
                    <button
                      onClick={(e) => onDelete(e, session.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-destructive transition-all cursor-pointer"
                      title="Delete"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function formatRelativeTime(date: Date, t: (key: string) => string): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return t('ai.chat.justNow');
  if (minutes < 60) return t('ai.chat.minutesAgo').replace('{n}', String(minutes));
  if (hours < 24) return t('ai.chat.hoursAgo').replace('{n}', String(hours));
  if (days < 7) return t('ai.chat.daysAgo').replace('{n}', String(days));
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// -------------------------------------------------------------------
// Export
// -------------------------------------------------------------------

const AIChatSidePanel = React.memo(AIChatSidePanelInner);
AIChatSidePanel.displayName = 'AIChatSidePanel';

export default AIChatSidePanel;
export { AIChatSidePanel };
export type { AIChatSidePanelProps };
