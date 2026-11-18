/** Images and embeds: upload fallback, safe embed construction, provider URL helpers. */

/** Decide whether an embed source may load. Default: https and not this page's origin. */
export type EmbedPolicy = (url: URL) => boolean;

export const defaultEmbedPolicy: EmbedPolicy = (url) =>
  url.protocol === "https:" && (typeof location === "undefined" || url.origin !== location.origin);

const ALLOWED_ATTRS: Record<string, string[]> = {
  iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "loading", "referrerpolicy"],
  video: ["src", "width", "height", "title", "controls", "poster", "loop", "muted", "playsinline", "preload"],
  audio: ["src", "title", "controls", "loop", "muted", "preload"],
};

/**
 * Build a fresh, attribute-whitelisted element from raw embed HTML. Never inserts
 * the user's HTML itself, so event handlers / scripts in the source are dropped.
 */
export function buildEmbed(html: string, policy: EmbedPolicy): HTMLElement {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const src = doc.body.firstElementChild;
  const tag = src?.tagName.toLowerCase() ?? "";
  const note = (msg: string) => {
    const d = document.createElement("div");
    d.className = "md-embed-note";
    d.textContent = msg;
    return d;
  };
  if (!src || !ALLOWED_ATTRS[tag]) return note("Unsupported embed");
  let url: URL;
  try {
    url = new URL(src.getAttribute("src") ?? "", typeof location === "undefined" ? undefined : location.href);
  } catch {
    return note("Embed has no valid src");
  }
  const mediaOk = tag !== "iframe" && /^(https?|blob|data):$/.test(url.protocol);
  if (!(tag === "iframe" ? policy(url) : mediaOk || policy(url))) return note(`Blocked embed: ${url.host || url.protocol}`);
  const el = document.createElement(tag);
  for (const a of ALLOWED_ATTRS[tag]) {
    const v = src.getAttribute(a);
    if (v !== null) el.setAttribute(a, v);
  }
  el.setAttribute("src", url.href);
  if (tag === "iframe") {
    el.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms");
    el.setAttribute("referrerpolicy", el.getAttribute("referrerpolicy") ?? "strict-origin-when-cross-origin");
    el.setAttribute("loading", "lazy");
    if (!el.hasAttribute("title")) el.setAttribute("title", url.host);
  }
  return el;
}

/** Turn a page URL into embed HTML (YouTube, Vimeo, Loom, CodePen, Figma, plain video/audio files, else iframe). */
export function embedHtmlFor(input: string): string {
  const raw = input.trim();
  const q = (s: string) => s.replace(/"/g, "&quot;");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw; // already HTML (or garbage): leave it to the user
  }
  const host = u.hostname.replace(/^www\./, "");
  const frame = (src: string, h = 400) =>
    `<iframe src="${q(src)}" width="100%" height="${h}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`;
  if (host === "youtube.com" || host === "m.youtube.com") {
    const id = u.searchParams.get("v") ?? u.pathname.match(/\/(?:shorts|embed)\/([\w-]+)/)?.[1];
    if (id) return frame(`https://www.youtube.com/embed/${id}`);
  }
  if (host === "youtu.be") return frame(`https://www.youtube.com/embed${u.pathname}`);
  if (host === "vimeo.com" && /^\/\d+/.test(u.pathname)) return frame(`https://player.vimeo.com/video${u.pathname}`);
  if (host === "loom.com" && u.pathname.startsWith("/share/")) return frame(`https://www.loom.com/embed/${u.pathname.slice(7)}`);
  if (host === "codepen.io" && u.pathname.includes("/pen/")) return frame(raw.replace("/pen/", "/embed/"), 360);
  if (host === "figma.com") return frame(`https://www.figma.com/embed?embed_host=typemark&url=${encodeURIComponent(raw)}`, 450);
  if (/\.(mp4|webm|ogv|mov)$/i.test(u.pathname)) return `<video src="${q(raw)}" controls width="100%"></video>`;
  if (/\.(mp3|ogg|wav|m4a|flac)$/i.test(u.pathname)) return `<audio src="${q(raw)}" controls></audio>`;
  return frame(raw);
}

/** Default image "upload": inline the file as a data URL (fine for demos; supply uploadImage in real apps). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Markdown-safe alt text from a file name. */
export const altFromName = (name: string) => name.replace(/\.[^.]+$/, "").replace(/[\[\]\\]/g, " ").trim() || "image";

/** Wrap a URL for markdown: angle brackets when it contains spaces or parens. */
export const mdUrl = (url: string) => (/[\s()<>]/.test(url) ? `<${url.replace(/>/g, "%3E")}>` : url);
