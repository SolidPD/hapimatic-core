// SPDX-License-Identifier: MIT
export interface AnsiQueryResponderOpts {
  cols: number;
  rows: number;
  xtversionId: string;
}

export interface AnsiQueryResponder {
  scan(chunk: string): string[];
  setSize(cols: number, rows: number): void;
}

const ESC = "\x1b";
const ST = "\x1b\\";

const DA1_QUERY = `${ESC}[c`;
const DA2_QUERY = `${ESC}[>c`;
const DSR_CURSOR_QUERY = `${ESC}[6n`;
const XTVERSION_QUERY = `${ESC}[>q`;
const WINDOW_SIZE_QUERY = `${ESC}[18t`;

const DA1_RESPONSE = `${ESC}[?1;2c`;
const DA2_RESPONSE = `${ESC}[>0;0;0c`;
const DSR_CURSOR_RESPONSE = `${ESC}[1;1R`;

export function createAnsiQueryResponder(
  opts: AnsiQueryResponderOpts
): AnsiQueryResponder {
  let cols = opts.cols;
  let rows = opts.rows;
  const xtversionId = opts.xtversionId;

  function scan(chunk: string): string[] {
    if (!chunk || chunk.indexOf(ESC) === -1) {
      return [];
    }
    const responses: string[] = [];
    let i = 0;
    while (i < chunk.length) {
      const next = chunk.indexOf(ESC, i);
      if (next === -1) break;
      const tail = chunk.slice(next);
      if (tail.startsWith(DA1_QUERY)) {
        responses.push(DA1_RESPONSE);
        i = next + DA1_QUERY.length;
        continue;
      }
      if (tail.startsWith(DA2_QUERY)) {
        responses.push(DA2_RESPONSE);
        i = next + DA2_QUERY.length;
        continue;
      }
      if (tail.startsWith(DSR_CURSOR_QUERY)) {
        responses.push(DSR_CURSOR_RESPONSE);
        i = next + DSR_CURSOR_QUERY.length;
        continue;
      }
      if (tail.startsWith(XTVERSION_QUERY)) {
        responses.push(`${ESC}P>|${xtversionId}${ST}`);
        i = next + XTVERSION_QUERY.length;
        continue;
      }
      if (tail.startsWith(WINDOW_SIZE_QUERY)) {
        responses.push(`${ESC}[8;${rows};${cols}t`);
        i = next + WINDOW_SIZE_QUERY.length;
        continue;
      }
      i = next + 1;
    }
    return responses;
  }

  function setSize(newCols: number, newRows: number): void {
    cols = newCols;
    rows = newRows;
  }

  return { scan, setSize };
}
