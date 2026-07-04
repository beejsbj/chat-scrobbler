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
  readonly style: Record<string, string> = {};
  className = "";
  id = "";
  innerHTML = "";
  title = "";
  onclick: ((event: FakeEvent) => void) | null = null;
  onkeydown: ((event: FakeKeyEvent) => void) | null = null;
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
    if (name === "id") this.id = value;
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
  const originalGetComputedStyle = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  const root = new FakeElement("html");
  const fakeDocument = {
    documentElement: root,
    createElement: (tagName: string) => new FakeElement(tagName),
    getElementById: (id: string) => root.children.find((child) => child.getAttribute("id") === id) ?? null,
  };
  (globalThis as { document?: unknown }).document = fakeDocument;
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle = (element: FakeElement) => ({
    position: element.style.position || "static",
  });
  try {
    run(root);
  } finally {
    (globalThis as { document?: unknown }).document = originalDocument;
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = originalGetComputedStyle;
  }
}

interface FakeEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface FakeKeyEvent extends FakeEvent {
  key: string;
}

function click(element: FakeElement): void {
  element.onclick?.({
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

test("badge styles position a single corner-dot button", () => {
  withFakeDocument((root) => {
    ensureBadgeStyles();

    const style = root.querySelector("[id]");
    expect(style?.textContent).toContain(".scrobbler-badge-container{position:absolute;top:3px;left:3px;");
    expect(style?.textContent).toContain(".scrobbler-badge{width:14px;height:14px;");
    expect(style?.textContent).not.toContain(".scrobbler-action");
  });
});

test("captured-state dot click invokes onDelete, not onToggle", () => {
  withFakeDocument(() => {
    const anchor = new FakeElement("a");
    let deleteCalls = 0;
    let toggleCalls = 0;

    setBadge(anchor as unknown as Element, "synced", {
      onDelete: () => { deleteCalls += 1; },
      onToggle: () => { toggleCalls += 1; },
    });

    const dot = anchor.querySelector("[data-scrobbler-badge]");
    expect(dot?.tagName).toBe("button");
    expect(dot?.title).toBe("Captured. Click to delete and stop syncing");
    expect(dot?.getAttribute("aria-label")).toBe("Captured. Click to delete and stop syncing");

    click(dot!);

    expect(deleteCalls).toBe(1);
    expect(toggleCalls).toBe(0);
  });
});

test("ignored-state dot click invokes onToggle, not onDelete", () => {
  withFakeDocument(() => {
    const anchor = new FakeElement("a");
    let deleteCalls = 0;
    let toggleCalls = 0;

    setBadge(anchor as unknown as Element, "ignored", {
      onDelete: () => { deleteCalls += 1; },
      onToggle: () => { toggleCalls += 1; },
    });

    const dot = anchor.querySelector("[data-scrobbler-badge]");
    expect(dot?.title).toBe("Not syncing. Click to re-enable");

    click(dot!);

    expect(deleteCalls).toBe(0);
    expect(toggleCalls).toBe(1);
  });
});

test("missing-state dot click invokes onToggle, not onDelete", () => {
  withFakeDocument(() => {
    const anchor = new FakeElement("a");
    let deleteCalls = 0;
    let toggleCalls = 0;

    setBadge(anchor as unknown as Element, "missing", {
      onDelete: () => { deleteCalls += 1; },
      onToggle: () => { toggleCalls += 1; },
    });

    const dot = anchor.querySelector("[data-scrobbler-badge]");
    expect(dot?.title).toBe("Not captured. Click to stop syncing");

    click(dot!);

    expect(deleteCalls).toBe(0);
    expect(toggleCalls).toBe(1);
  });
});

test("setBadge positions one reusable dot without duplicate listeners", () => {
  withFakeDocument(() => {
    const anchor = new FakeElement("a");
    let firstDeleteCalls = 0;
    let secondDeleteCalls = 0;

    setBadge(anchor as unknown as Element, "synced", {
      onDelete: () => { firstDeleteCalls += 1; },
    });

    const container = anchor.querySelector("[data-scrobbler-badge-container]");
    const dot = anchor.querySelector("[data-scrobbler-badge]");
    expect(anchor.style.position).toBe("relative");
    expect(container?.style.position).toBe("absolute");
    expect(container?.style.top).toBe("3px");
    expect(container?.style.left).toBe("3px");
    expect(anchor.children).toHaveLength(1);
    expect(container?.children).toHaveLength(1);

    setBadge(anchor as unknown as Element, "error", {
      onDelete: () => { secondDeleteCalls += 1; },
    });

    expect(anchor.children).toHaveLength(1);
    expect(container?.children).toHaveLength(1);
    expect(anchor.listeners.mouseenter ?? []).toHaveLength(0);
    expect(anchor.listeners.mouseleave ?? []).toHaveLength(0);

    click(dot!);
    expect(firstDeleteCalls).toBe(0);
    expect(secondDeleteCalls).toBe(1);
  });
});
