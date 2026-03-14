/**
 * ChatInput - Zed-style bottom input area for the AI chat panel
 *
 * Thin wrapper around the AI Elements prompt-input components.
 * Bordered textarea with monospace placeholder, expand toggle,
 * and a bottom toolbar with muted controls + subtle send button.
 */

import { AtSign, Check, ChevronDown, ChevronRight, Cpu, Expand, FileText, ImageIcon, Plus, X } from 'lucide-react';
import React, { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FormEvent } from 'react';
import type { UploadedImage } from '../../application/state/useImageUpload';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '../ai-elements/prompt-input';
import type { PromptInputStatus } from '../ai-elements/prompt-input';
import { formatThinkingLabel } from '../../infrastructure/ai/types';
import type { AgentModelPreset } from '../../infrastructure/ai/types';

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  providerName?: string;
  modelName?: string;
  agentName?: string;
  placeholder?: string;
  /** Available model presets for the current agent */
  modelPresets?: AgentModelPreset[];
  /** Currently selected model ID */
  selectedModelId?: string;
  /** Callback when user selects a model */
  onModelSelect?: (modelId: string) => void;
  /** Attached images */
  images?: UploadedImage[];
  /** Callback to add images (paste/drop) */
  onAddImages?: (files: File[]) => void;
  /** Callback to remove an image */
  onRemoveImage?: (id: string) => void;
  /** Available hosts for @ mention */
  hosts?: Array<{ sessionId: string; hostname: string; label: string; connected: boolean }>;
}

const ChatInput: React.FC<ChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
  providerName,
  modelName,
  agentName,
  placeholder,
  modelPresets = [],
  selectedModelId,
  onModelSelect,
  images = [],
  onAddImages,
  onRemoveImage,
  hosts = [],
}) => {
  const [expanded, setExpanded] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number } | null>(null);
  const [hoveredModelId, setHoveredModelId] = useState<string | null>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [attachMenuPos, setAttachMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const [showHostSubmenu, setShowHostSubmenu] = useState(false);
  const [showAtMention, setShowAtMention] = useState(false);
  const [atMentionPos, setAtMentionPos] = useState<{ left: number; bottom: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelBtnRef = useRef<HTMLButtonElement>(null);
  const attachBtnRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleInputChange = useCallback((newValue: string) => {
    onChange(newValue);
    // Detect if user just typed @
    if (
      hosts.length > 0 &&
      newValue.length > value.length &&
      newValue.endsWith('@')
    ) {
      // Position the popover near the textarea
      const el = textareaRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        setAtMentionPos({ left: rect.left + 12, bottom: window.innerHeight - rect.top + 4 });
      }
      setShowAtMention(true);
    } else if (showAtMention && !newValue.includes('@')) {
      setShowAtMention(false);
    }
  }, [onChange, value, hosts.length, showAtMention]);

  const handleSelectAtMention = useCallback((host: { label: string; hostname: string }) => {
    // Replace the trailing @ with @hostname
    const name = host.label || host.hostname;
    const lastAt = value.lastIndexOf('@');
    const newValue = lastAt >= 0
      ? value.slice(0, lastAt) + `@${name} `
      : value + `@${name} `;
    onChange(newValue);
    setShowAtMention(false);
  }, [value, onChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter(Boolean) as File[];
    if (files.length > 0) {
      e.preventDefault();
      onAddImages?.(files);
    }
  }, [onAddImages]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      onAddImages?.(files);
    }
  }, [onAddImages]);

  const defaultPlaceholder = agentName
    ? `Message ${agentName} — @ to include context, / for commands`
    : 'Message Catty Agent...';

  const handleSubmit = useCallback(
    (_text: string, _event: FormEvent<HTMLFormElement>) => {
      onSend();
    },
    [onSend],
  );

  const status: PromptInputStatus = isStreaming ? 'streaming' : 'idle';

  // Permission mode chip removed — agents run in autonomous mode

  // selectedModelId may be "model/thinking" for codex
  const selectedBaseModelId = selectedModelId?.split('/')[0];
  const selectedThinking = selectedModelId?.includes('/') ? selectedModelId.split('/')[1] : undefined;
  const selectedPreset = modelPresets.find(m => m.id === selectedBaseModelId);
  const modelLabel = selectedPreset
    ? selectedPreset.name + (selectedThinking ? ` / ${formatThinkingLabel(selectedThinking)}` : '')
    : modelName || providerName || 'No model';
  const hasModelPicker = modelPresets.length > 0 && onModelSelect;
  const chipClassName =
    'inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-[10.5px] text-foreground/72';
  const iconButtonClassName =
    'h-6 w-6 rounded-full bg-transparent text-foreground/62 hover:bg-muted/24 hover:text-foreground';

  return (
    <div className="shrink-0 px-4 pb-4">
      <PromptInput onSubmit={handleSubmit}>
        {/* Image attachment chips */}
        {images.length > 0 && (
          <div className="flex gap-1.5 px-3 pt-2 pb-0.5 flex-wrap">
            {images.map((img) => (
              <div
                key={img.id}
                className="inline-flex items-center gap-1 h-6 pl-1.5 pr-1 rounded-md bg-muted/30 border border-border/30 text-[11px] text-foreground/70 group"
              >
                <ImageIcon size={11} className="text-muted-foreground/60 shrink-0" />
                <span className="truncate max-w-[80px]">{img.filename}</span>
                <button
                  type="button"
                  onClick={() => onRemoveImage?.(img.id)}
                  className="h-3.5 w-3.5 rounded-sm flex items-center justify-center opacity-50 hover:opacity-100 hover:bg-muted/50 transition-opacity cursor-pointer"
                >
                  <X size={8} />
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              onAddImages?.(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
        />

        {/* Textarea with expand toggle */}
        <div className="relative" onPaste={handlePaste} onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
          <PromptInputTextarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder={placeholder || defaultPlaceholder}
            disabled={disabled || isStreaming}
            className={expanded ? 'max-h-[220px]' : undefined}
          />
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="absolute top-3.5 right-3 rounded-md p-1 text-muted-foreground/38 hover:text-muted-foreground/72 hover:bg-muted/25 transition-colors cursor-pointer"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <Expand size={12} />
          </button>
        </div>

        {/* @ mention popover */}
        {showAtMention && hosts.length > 0 && atMentionPos && createPortal(
          <>
            <div className="fixed inset-0 z-[999]" onClick={() => setShowAtMention(false)} />
            <div
              className="fixed z-[1000] min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
              style={{ left: atMentionPos.left, bottom: atMentionPos.bottom }}
            >
              <div className="px-3 py-1 text-[10px] text-muted-foreground/40 tracking-wide">Hosts</div>
              {hosts.map(host => (
                <button
                  key={host.sessionId}
                  type="button"
                  onClick={() => handleSelectAtMention(host)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                >
                  <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                  <span className="text-foreground/85 truncate">{host.label || host.hostname}</span>
                  {host.label && host.hostname !== host.label && (
                    <span className="text-[10px] text-muted-foreground/40">{host.hostname}</span>
                  )}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}

        {/* Footer toolbar */}
        <PromptInputFooter className="gap-1.5 border-t-0 bg-transparent px-3 pb-2 pt-0">
          <PromptInputTools className="gap-1 flex-wrap">
            <button
              ref={attachBtnRef}
              type="button"
              onClick={() => {
                if (!showAttachMenu) {
                  const rect = attachBtnRef.current?.getBoundingClientRect();
                  if (rect) setAttachMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
                }
                setShowAttachMenu(v => !v);
              }}
              className={iconButtonClassName}
              title="Attach"
            >
              <Plus size={13} />
            </button>
            {showAttachMenu && attachMenuPos && createPortal(
              <>
                <div className="fixed inset-0 z-[999]" onClick={() => setShowAttachMenu(false)} />
                <div
                  className="fixed z-[1000] min-w-[170px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: attachMenuPos.left, bottom: attachMenuPos.bottom }}
                >
                  <div className="px-3 py-1 text-[10px] text-muted-foreground/40 tracking-wide">Context</div>
                  <button
                    type="button"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', '*/*'); fileInputRef.current?.click(); setShowAttachMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <FileText size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">Files</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => { fileInputRef.current?.setAttribute('accept', 'image/*'); fileInputRef.current?.click(); setShowAttachMenu(false); }}
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                  >
                    <ImageIcon size={13} className="text-muted-foreground/60" />
                    <span className="text-foreground/85">Image</span>
                  </button>
                  <div
                    className="relative"
                    onMouseEnter={() => setShowHostSubmenu(true)}
                    onMouseLeave={() => setShowHostSubmenu(false)}
                  >
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                    >
                      <AtSign size={13} className="text-muted-foreground/60" />
                      <span className="flex-1 text-foreground/85">Mention Host</span>
                      {hosts.length > 0 && <ChevronRight size={10} className="text-muted-foreground/50" />}
                    </button>
                    {showHostSubmenu && hosts.length > 0 && (
                      <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1 z-[1001]">
                        {hosts.map(host => (
                          <button
                            key={host.sessionId}
                            type="button"
                            onClick={() => {
                              const mention = `@${host.label || host.hostname} `;
                              onChange(value + mention);
                              setShowAttachMenu(false);
                              setShowHostSubmenu(false);
                            }}
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                          >
                            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${host.connected ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
                            <span className="text-foreground/85 truncate">{host.label || host.hostname}</span>
                            {host.label && host.hostname !== host.label && (
                              <span className="text-[10px] text-muted-foreground/40">{host.hostname}</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>,
              document.body,
            )}
            <button
              ref={modelBtnRef}
              type="button"
              onClick={() => {
                if (!hasModelPicker) return;
                if (!showModelPicker) {
                  const rect = modelBtnRef.current?.getBoundingClientRect();
                  if (rect) setPickerPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
                }
                setShowModelPicker(v => !v);
              }}
              className={`${chipClassName} ${hasModelPicker ? 'cursor-pointer hover:bg-muted/24 transition-colors' : ''}`}
            >
              <Cpu size={11} className="text-muted-foreground/64" />
              <span className="truncate max-w-[82px]">{modelLabel}</span>
              {hasModelPicker && <ChevronDown size={9} className="text-muted-foreground/50" />}
            </button>
            {showModelPicker && hasModelPicker && pickerPos && createPortal(
              <>
                <div className="fixed inset-0 z-[999]" onClick={() => { setShowModelPicker(false); setHoveredModelId(null); }} />
                <div
                  className="fixed z-[1000] min-w-[160px] rounded-lg border border-border/50 bg-popover shadow-lg py-1"
                  style={{ left: pickerPos.left, bottom: pickerPos.bottom }}
                  onMouseLeave={() => setHoveredModelId(null)}
                >
                  {modelPresets.map(preset => {
                    const isSelected = preset.id === selectedBaseModelId;
                    const hasThinking = preset.thinkingLevels && preset.thinkingLevels.length > 0;
                    return (
                      <div key={preset.id} className="relative" onMouseEnter={() => setHoveredModelId(hasThinking ? preset.id : null)}>
                        <button
                          type="button"
                          onClick={() => {
                            if (!hasThinking) {
                              onModelSelect?.(preset.id);
                              setShowModelPicker(false);
                              setHoveredModelId(null);
                            }
                          }}
                          className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                        >
                          {isSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                          <span className="flex-1 text-foreground/85">{preset.name}</span>
                          {preset.description && <span className="text-[10px] text-muted-foreground/50 mr-1">{preset.description}</span>}
                          {hasThinking && <ChevronRight size={10} className="text-muted-foreground/50" />}
                        </button>
                        {/* Thinking level sub-menu */}
                        {hasThinking && hoveredModelId === preset.id && (
                          <div className="absolute left-full top-0 ml-1 min-w-[120px] rounded-lg border border-border/50 bg-popover shadow-lg py-1 z-[1001]">
                            {preset.thinkingLevels!.map(level => {
                              const fullId = `${preset.id}/${level}`;
                              const isLevelSelected = selectedModelId === fullId;
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  onClick={() => {
                                    onModelSelect?.(fullId);
                                    setShowModelPicker(false);
                                    setHoveredModelId(null);
                                  }}
                                  className="w-full flex items-center gap-1.5 px-3 py-1.5 text-left text-[12px] hover:bg-muted/30 transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  {isLevelSelected ? <Check size={11} className="text-primary shrink-0" /> : <span className="w-[11px] shrink-0" />}
                                  <span className="text-foreground/85">{formatThinkingLabel(level)}</span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>,
              document.body,
            )}
          </PromptInputTools>

          <div className="flex-1 min-w-0" />

          <div className="flex items-center gap-1">
            <PromptInputSubmit
              status={status}
              onStop={onStop}
              disabled={!value.trim() || disabled}
            />
          </div>
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
};

export default React.memo(ChatInput);
