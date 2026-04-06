import type { Terminal as XTerm } from "@xterm/xterm";

const CLEAR_VIEWPORT_SEQUENCE = "\x1b[H\x1b[2J";

type CsiParam = number | number[];
type InternalTerminal = XTerm & {
  _core?: {
    scroll?: (eraseAttr: unknown, isWrapped?: boolean) => void;
    _inputHandler?: {
      _eraseAttrData?: () => unknown;
    };
  };
};

const getVisibleContentRowCount = (term: XTerm): number => {
  const buffer = term.buffer.active;
  if (buffer.type !== "normal") {
    return 0;
  }

  const viewportY = buffer.viewportY;
  for (let row = term.rows - 1; row >= 0; row--) {
    const line = buffer.getLine(viewportY + row);
    if (!line) {
      continue;
    }
    if (line.translateToString(true).length > 0) {
      return row + 1;
    }
  }

  return 0;
};

export const preserveTerminalViewportInScrollback = (term: XTerm): void => {
  const rowsToPreserve = getVisibleContentRowCount(term);
  if (rowsToPreserve <= 0) {
    return;
  }

  const internal = term as InternalTerminal;
  const scroll = internal._core?.scroll;
  const eraseAttr = internal._core?._inputHandler?._eraseAttrData?.();

  if (typeof scroll !== "function" || eraseAttr === undefined) {
    return;
  }

  for (let row = 0; row < rowsToPreserve; row++) {
    scroll.call(internal._core, eraseAttr, false);
  }
};

export const clearTerminalViewport = (term: XTerm): void => {
  term.write(CLEAR_VIEWPORT_SEQUENCE, () => {
    term.scrollToBottom();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        term.scrollToBottom();
      });
    }
  });
};

export const isEraseScrollbackSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 3;

export const isEraseViewportSequence = (params: CsiParam[]): boolean =>
  params.length > 0 && params[0] === 2;
