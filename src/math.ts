/**
 * <tm-math tex="..." display> renders KaTeX into a SHADOW root.
 * Shadow content is not part of the host's textContent, so a rendered
 * formula adds zero characters to the block and the
 * textContent === markdown-source invariant still holds.
 */
import katex from "katex";
import katexCss from "katex/dist/katex.min.css?raw";

// @font-face is ignored inside shadow roots (fonts come from the document stylesheet), so drop it
const sheetText = katexCss.replace(/@font-face\{[^}]*\}/g, "") + ":host{display:inline-block;cursor:pointer}:host([display]){display:block;text-align:center}.err{color:#c33;font:12px monospace}";

class TmMath extends HTMLElement {
  static get observedAttributes() {
    return ["tex"];
  }
  connectedCallback() {
    this.paint();
  }
  attributeChangedCallback() {
    this.paint();
  }
  private paint() {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    const tex = this.getAttribute("tex") ?? "";
    let html: string;
    try {
      html = tex.trim()
        ? katex.renderToString(tex, { displayMode: this.hasAttribute("display"), throwOnError: true })
        : `<span class="err">${this.hasAttribute("display") ? "(empty math block)" : ""}</span>`;
    } catch (e) {
      html = `<span class="err">${String((e as Error).message).replace(/</g, "&lt;")}</span>`;
    }
    root.innerHTML = `<style>${sheetText}</style>${html}`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("tm-math")) {
  customElements.define("tm-math", TmMath);
}
