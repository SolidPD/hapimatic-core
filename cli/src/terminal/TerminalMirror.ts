// SPDX-License-Identifier: AGPL-3.0-only
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

/**
 * A CLI-side headless mirror of a persistent terminal's screen state (#4517).
 *
 * Every byte the PTY emits is fed through an `@xterm/headless` emulator, so on
 * re-attach the CLI can replay a faithful snapshot to a NEW browser — the alt
 * screen of a running full-screen app (vim/htop), the cursor position, DEC
 * private modes (bracketed paste, application cursor) and up to `scrollback`
 * lines of normal-buffer history. A raw byte ring buffer cannot do this: once
 * the `ESC[?1049h` alt-screen switch scrolls out of a raw buffer, the replay
 * garbles. This is VS Code's production approach (`XtermSerializer` in
 * `microsoft/vscode` `src/vs/platform/terminal/node/ptyService.ts`).
 *
 * Only persistent terminals get a mirror — legacy terminals keep the
 * close-on-disconnect path and never allocate one.
 */
export class TerminalMirror {
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly scrollback: number;
  private disposed = false;

  constructor(cols: number, rows: number, scrollback = 1000) {
    this.scrollback = scrollback;
    this.term = new Terminal({
      cols,
      rows,
      scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
  }

  /**
   * Feed PTY output into the emulator. Never throws (#4657): `@xterm/headless`
   * throws `write data discarded` once more than 5e7 characters (~50M UTF-16
   * code units) are queued and not yet parsed. A `false` return means the data was NOT mirrored, so the screen
   * state is now incomplete and the caller should stop relying on this
   * mirror's snapshot.
   */
  write(data: string): boolean {
    if (this.disposed) {
      return false;
    }
    try {
      this.term.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return;
    }
    this.term.resize(cols, rows);
  }

  /**
   * Serialize the current screen + scrollback into a string that, written back
   * into a fresh terminal of the same size, restores the screen, scrollback,
   * cursor position and the DEC modes SerializeAddon carries (not cursor
   * visibility, mouse encoding, scroll regions or character sets).
   *
   * xterm's `write()` is asynchronous (internal WriteBuffer), so calling
   * `serialize()` immediately after a burst of writes can miss the last chunks.
   * We first enqueue an empty write whose callback fires only AFTER every
   * previously-queued chunk is parsed — a barrier that gives a consistent
   * snapshot boundary. The caller (TerminalManager) partitions the live stream
   * at this same boundary so nothing is lost or duplicated for a single attach
   * in flight (overlapping attaches of one shell are not serialized; #4606).
   */
  snapshot(): Promise<string> {
    if (this.disposed) {
      return Promise.resolve("");
    }
    return new Promise<string>(resolve => {
      this.term.write("", () => {
        if (this.disposed) {
          resolve("");
          return;
        }
        resolve(this.serializer.serialize({ scrollback: this.scrollback }));
      });
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.serializer.dispose();
    this.term.dispose();
  }
}
