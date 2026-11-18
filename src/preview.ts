/**
 * Fence renderers: a fenced code block whose language has a registered
 * renderer (e.g. ```mermaid) shows a live preview under / instead of its code.
 *
 * The preview is a <tm-preview> element rendering into a SHADOW root, so it
 * adds no text to the block (textContent === markdown source still holds).
 * Renders are debounced and cached by source, so typing stays smooth.
 */

/** Render `code` into `target` (a shadow root). May be async. Throw to show an error. */
export type FenceRenderer = (code: string, target: ShadowRoot, ctx: { dark: boolean }) => void | Promise<void>;

const registry = new Map<string, FenceRenderer>();

export function registerFenceRenderer(lang: string, renderer: FenceRenderer): void {
  registry.set(lang.toLowerCase(), renderer);
  // re-render any preview already on screen for this language
  if (typeof document !== "undefined") {
    for (const el of document.querySelectorAll<TmPreview>(`tm-preview[lang="${lang.toLowerCase()}"]`)) el.refresh(true);
  }
}

export const hasFenceRenderer = (lang: string) => registry.has(lang.toLowerCase());

const cache = new Map<string, string>(); // `${lang}\0${dark}\0${code}` -> rendered HTML

const BASE_CSS = ":host{display:block;text-align:center;cursor:pointer;overflow-x:auto}svg{max-width:100%;height:auto}.err{color:#c33;font:12px ui-monospace,monospace;white-space:pre-wrap;text-align:left}";

class TmPreview extends HTMLElement {
  static get observedAttributes() {
    return ["code", "lang"];
  }
  private timer = 0;
  private seq = 0;
  connectedCallback() {
    this.refresh(true);
  }
  attributeChangedCallback() {
    this.refresh(false);
  }
  refresh(now: boolean) {
    if (!this.isConnected) return;
    clearTimeout(this.timer);
    const lang = (this.getAttribute("lang") ?? "").toLowerCase();
    const code = this.getAttribute("code") ?? "";
    const dark = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
    const key = `${lang}\0${dark}\0${code}`;
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const hit = cache.get(key);
    if (hit !== undefined) {
      root.innerHTML = hit;
      return;
    }
    const run = async () => {
      const mine = ++this.seq;
      const r = registry.get(lang);
      const scratch = document.createElement("div").attachShadow({ mode: "open" });
      let html: string;
      try {
        if (!r) throw new Error(`No renderer registered for "${lang}"`);
        if (!code.trim()) html = "";
        else {
          await r(code, scratch, { dark });
          html = scratch.innerHTML;
          cache.set(key, `<style>${BASE_CSS}</style>${html}`);
          if (cache.size > 200) cache.delete(cache.keys().next().value!);
        }
      } catch (e) {
        html = `<div class="err">${String((e as Error)?.message ?? e).replace(/</g, "&lt;")}</div>`;
      }
      if (mine === this.seq) root.innerHTML = `<style>${BASE_CSS}</style>${html}`;
    };
    if (now) void run();
    else this.timer = window.setTimeout(run, 250);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("tm-preview")) {
  customElements.define("tm-preview", TmPreview);
}

/**
 * Mermaid renderer. Pass a loader so mermaid (~2 MB) stays an optional, lazily
 * loaded dependency of YOUR app:  mermaidRenderer(() => import("mermaid"))
 */
export function mermaidRenderer(load: () => Promise<unknown>): FenceRenderer {
  type Mermaid = { initialize(c: object): void; render(id: string, code: string): Promise<{ svg: string }> };
  let api: Mermaid | null = null;
  let theme = "";
  let n = 0;
  return async (code, target, { dark }) => {
    if (!api) {
      const mod = (await load()) as { default?: unknown };
      api = (mod.default ?? mod) as Mermaid;
    }
    const want = dark ? "dark" : "default";
    if (theme !== want) {
      api!.initialize({ startOnLoad: false, theme: want, securityLevel: "strict" });
      theme = want;
    }
    const { svg } = await api!.render(`tm-mermaid-${++n}`, code);
    target.innerHTML = svg;
  };
}
