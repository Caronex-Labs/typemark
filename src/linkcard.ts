/**
 * Link cards: a paragraph that is ONLY a bare URL (`https://…` alone on its line)
 * renders as a bookmark card. The engine never fetches anything itself: the host
 * supplies `linkPreview(url)` in EditorOptions. Without it (or while it loads, or
 * when it returns null) the card shows the host and the URL.
 */
import type { Editor } from "./editor";
import type { Extension } from "./extension";

export interface LinkPreview {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}
export type LinkPreviewFn = (url: string) => Promise<LinkPreview | null>;

export const LINK_CARD = /https?:\/\/[^\s<>]+/;

/** Results per hook, per URL (shared by every editor using the same hook). */
const cache = new WeakMap<LinkPreviewFn, Map<string, Promise<LinkPreview | null>>>();

export function fetchPreview(fn: LinkPreviewFn, url: string): Promise<LinkPreview | null> {
  let m = cache.get(fn);
  if (!m) cache.set(fn, (m = new Map()));
  let p = m.get(url);
  if (!p) {
    p = fn(url).catch(() => null);
    m.set(url, p);
  }
  return p;
}

const safeUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    const x = new URL(u);
    return x.protocol === "https:" || x.protocol === "http:" || x.protocol === "data:" ? x.href : null;
  } catch {
    return null;
  }
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function drawCard(mount: HTMLElement, url: string, p: LinkPreview | null, loading: boolean): void {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  mount.replaceChildren();
  mount.classList.add("md-linkcard");
  mount.classList.toggle("md-linkcard-compact", !p);
  mount.classList.toggle("md-linkcard-loading", loading);
  const body = el("div", "md-linkcard-body");
  if (p?.title) body.append(el("div", "md-linkcard-title", p.title));
  if (p?.description) body.append(el("div", "md-linkcard-desc", p.description));
  const meta = el("div", "md-linkcard-meta");
  const fav = safeUrl(p?.favicon);
  if (fav) {
    const img = el("img", "md-linkcard-favicon");
    img.src = fav;
    img.alt = "";
    meta.append(img);
  }
  meta.append(el("span", "md-linkcard-host", p?.siteName || host));
  if (!p) meta.append(el("span", "md-linkcard-url", url));
  body.append(meta);
  mount.append(body);
  const image = safeUrl(p?.image);
  if (image) {
    const img = el("img", "md-linkcard-image");
    img.src = image;
    img.alt = "";
    mount.append(img);
  }
}

export const linkCardExtension: Extension = {
  name: "linkcard",
  blocks: [
    {
      kind: "widget",
      name: "linkcard",
      pattern: LINK_CARD,
      render({ el: mount, src, editor }) {
        const url = src.trim();
        const fn = (editor as Editor).linkPreview;
        drawCard(mount, url, null, !!fn);
        if (!fn) return;
        let live = true;
        // a short delay before asking the host, so typing a URL does not fetch every prefix
        const go = () =>
          void fetchPreview(fn, url).then((p) => {
            if (live) drawCard(mount, url, p, false);
          });
        const timer = cache.get(fn)?.has(url) ? (go(), undefined) : setTimeout(go, 250);
        return () => {
          live = false;
          clearTimeout(timer);
        };
      },
    },
  ],
};
