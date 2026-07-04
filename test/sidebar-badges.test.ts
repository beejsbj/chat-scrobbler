import { expect, test } from "bun:test";
import { ensureBadgeStyles, setBadge } from "../packages/extension/src/sidebar/badges";

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  contains(name: string): boolean {
    return this.element.className.split(/\s+/).includes(name);
  }

  add(name: string): void {
    if (this.contains(name)) return;
    this.element.className = [this.element.className, name].filter(Boolean).join(" ");
  }

  remove(name: string): void {
    this.element.className = this.element.className
      .split(/\s+/)
      .filter((part) => part && part !== name)
      .join(" ");
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList(this);
  readonly listeners: Record<string, Array<() => void>> = {};
  className = "";
  id = "";
  innerHTML = "";
  title = "";
  onclick: unknown;
  onkeydown: unknown;
  parent: FakeElement | null = null;
  textContent = "";
  private readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string) {}

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    if (name.startsWith("data-")) {
      const dataKey = name
        .slice(5)
        .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      this.dataset[dataKey] = value;
    }
  }

  getAttribute(name: string): string | null {
    if (name === "id") return this.id || null;
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  querySelector(selector: string): FakeElement | null {
    const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
    if (!attr) throw new Error(`unsupported selector: ${selector}`);
    return this.walk().find((child) => child.getAttribute(attr) !== null) ?? null;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] ??= [];
    this.listeners[type].push(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners[type] ?? []) listener();
  }

  private walk(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.walk()]);
  }
}

function withFakeDocument(run: (root: FakeElement) => void): void {
  const originalDocument = (globalThis as { document?: unknown }).document;
  const root = new FakeElement("html");
  const fakeDocument = {
    documentElement: root,
    createElement: (tagName: string) => new FakeElement(tagName),
    getElementById: (id: string) => root.children.find((child) => child.getAttribute("id") === id) ?? null,
  };
  (globalThis as { document?: unknown }).document = fakeDocument;
  try {
    run(root);
  } finally {
    (globalThis as { document?: unknown }).document = originalDocument;
  }
}

test("badge styles hide actions until the row is revealed or focused", () => {
  withFakeDocument((root) => {
    ensureBadgeStyles();

    const style = root.querySelector("[id]");
    expect(style?.textContent).toContain(".scrobbler-action{display:none;");
    expect(style?.textContent).toContain(".scrobbler-actions.scrobbler-actions--revealed .scrobbler-action");
    expect(style?.textContent).toContain(".scrobbler-actions:focus-within .scrobbler-action");
  });
});

test("setBadge reveals row actions on hover without stacking listeners", () => {
  withFakeDocument(() => {
    const anchor = new FakeElement("a");

    setBadge(anchor as unknown as Element, "synced");
    const container = anchor.querySelector("[data-scrobbler-actions]");

    expect(container?.classList.contains("scrobbler-actions--revealed")).toBe(false);
    expect(anchor.listeners.mouseenter).toHaveLength(1);
    expect(anchor.listeners.mouseleave).toHaveLength(1);

    setBadge(anchor as unknown as Element, "stale");
    expect(anchor.listeners.mouseenter).toHaveLength(1);
    expect(anchor.listeners.mouseleave).toHaveLength(1);

    anchor.dispatch("mouseenter");
    expect(container?.classList.contains("scrobbler-actions--revealed")).toBe(true);

    anchor.dispatch("mouseleave");
    expect(container?.classList.contains("scrobbler-actions--revealed")).toBe(false);
  });
});
