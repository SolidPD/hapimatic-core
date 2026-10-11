// SPDX-License-Identifier: AGPL-3.0-only
// Minimal ambient types for @novnc/novnc (issue #2693). The package ships plain
// ES modules with no .d.ts, so we declare the small surface DesktopView uses.
// Its package.json `exports` is the STRING "./core/rfb.js", so the bare specifier
// `@novnc/novnc` IS the RFB entry point (no `/core/rfb` subpath). RFB extends
// EventTarget, so addEventListener / removeEventListener are inherited.
declare module "@novnc/novnc" {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    /** WebSocket subprotocols offered on the upgrade (issue #2693 carries the
     * JWT here as `hapi-desktop-auth.<token>`). */
    wsProtocols?: string[];
  }
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string,
      options?: RFBOptions
    );
    viewOnly: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
