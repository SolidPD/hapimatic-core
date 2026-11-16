// SPDX-License-Identifier: AGPL-3.0-only
/**
 * jsdom has no layout engine, so every element's `scrollWidth` and
 * `clientWidth` read 0. `stubOverflow` makes the elements whose text is exactly
 * `text` read as `scrollWidth` wide inside a `clientWidth` box, which drives
 * `FadeTruncate` and the pin row's title measurement (#6458, TITLE-D); every
 * other element keeps reading 0, so the action row's own fit measurement is
 * left alone. Always call `restoreOverflow` in `afterEach`, because the web
 * suite shares one module registry (`isolate: false`, #2445) and a stub left
 * in place would change other files' layouts.
 */
export function stubOverflow(
  text: string,
  scrollWidth: number,
  clientWidth = 200
): void {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === text ? scrollWidth : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent === text ? clientWidth : 0;
    },
  });
}

/** Back to jsdom's own getters (0), defined on `Element.prototype`. */
export function restoreOverflow(): void {
  Reflect.deleteProperty(HTMLElement.prototype, "scrollWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
}
