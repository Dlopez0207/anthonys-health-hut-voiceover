// Anthony's Health Hut - Duda editor simulation (Phase 2, SPEC.md change matrix E1-E6 + the editor part of C9,
// + E7 from battery fix 2, + E8 from the human review of v1.2.0).
// (Replaces the pass-through stub that fixed/staging/server.mjs creates when this file is missing.)
//
// Each CHANGES entry reproduces, as targeted string edits on the raw HTML that Duda serves, the markup that the Duda
// editor writes when the change is made by hand (Spanish steps in `dudaSteps` and in fixed/CAMBIOS-ADA.md, section 3).
// Only the edited elements change. Everything else stays byte-identical (no DOM parse/re-serialization), so
// BASELINE (4174) and FIXED (4173) differ only where the editor would make them differ.
//
// Contract used by fixed/staging/server.mjs (FIXED mode):
//   transform(html, { path, device, mode }) -> html          mode !== "fixed" returns the input unchanged
// Extra exports for tests and reports:
//   CHANGES, transformWithReport(html, opts) -> { html, report }, LOGO_ALT, OWNER_ALT, MENU_PDF_URL, MENU_SECTION_FILE,
//   SIM_IDS (ids of the widgets this file inserts), FOOTER_LEVELS.
// Optional: opts.only = ['E1', ...] (or env EDITOR_SIM_ONLY="E1,E5") applies a subset, e.g. for per-change screenshots.
//
// Markup evidence (raw HTML saved on Oct 6, 2026 + phone snapshots): Duda keeps the block classes (text-align-*,
// size-NN, m-size-NN) and the inner <span>/<strong> with its classes (font-size-NN, m-font-size-NN) and inline style
// when a text block changes format; font sizes set in the mobile view add m-size-NN / m-font-size-NN; site palette
// colors are written as `color: var(--color_N)` (--color_1 = black); fonts as `font-family:Poppins, 'Poppins Fallback'`;
// an HTML widget is <div data-element-type="html" class="u_ID dmCustomHtml" id="ID">...</div> (contact-us map).
//
// Not doable in the editor (documented, handled by Head HTML JS, C9-H): Duda's runtime adds target="_blank" to every
// tel: / mailto: link at page load (duda-runtime.js, addTargetBlankToExternalLinks:
// $('[href^="tel:"], .dmCall, [href^="mailto:"], .dmEmail').attr("target","_blank")). In the raw HTML of the pages
// (desktop and phone) one tel: link carries target="_blank" from its link setting ("Open in new tab"): the bold
// "(863) 644-5330" in the "Our Location" text block of /contact-us (review fix RF-9, 2026-10-13: grep of the 21 x 2
// cached pages). The editor part of C9 removes that setting (C9e); the Head HTML script removes the runtime target.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXED_DIR = path.resolve(HERE, '..');
export const MENU_SECTION_FILE = path.join(FIXED_DIR, 'menu', 'menu-section.html');

// Staging URL of the remediated menu PDF (served by the FIXED server from fixed/menu/). In Duda the link points to the
// uploaded file instead (suggested name Anthonys-Health-Hut-Restaurant-Menu.pdf, CAMBIOS-ADA.md section 4).
export const MENU_PDF_URL = '/ada-files/menu-accessible.pdf';
export const MENU_PDF_LINK_TEXT = 'Download the menu (PDF, 2 pages)';
export const MENU_H1_TEXT = 'Restaurant Menu';

// A6. Logo: the image reads "Anthony's Health Hut & Restaurant" (checked on the logo file, Oct 12, 2026) and every
// instance links to "/", so the alt names the logo text and the destination.
export const LOGO_ALT = "Anthony's Health Hut & Restaurant – Home";
export const LOGO_ALT_UNLINKED = "Anthony's Health Hut & Restaurant";
// A6. Owner photo: the only source available is the page itself (user, Oct 12, 2026: "solo tenemos lo que esta en la
// pagina web"). The "About the Owner" text next to the photo says "Anthony has owned and operated Anthony's Health Hut
// for 47 years", so the name comes from there. Resolved 2026-10-13 (source: page text): no other information about the
// owner is available, so this alt is final.
export const OWNER_NAME = 'Anthony';
export const OWNER_ALT = `${OWNER_NAME}, owner of Anthony's Health Hut`;
const OWNER_PHOTO_KEY = '480645906_2972936306206269_2198493783520532259_n';
const LOGO_KEY = 'Anthonys_logo';
const MENU_IMAGE_KEY = 'Anthony-s+Health+Hut+Menu+2024';

// Footer heading levels (global footer, every page). The SPEC proposed H4 under the existing H3 "Need More Info? Get In
// Touch!". That leaves H1 -> H3 on /information-faqs (axe heading-order today, outside the exhibit) and on /thank-you
// once E4 adds its H1, so the footer section heading becomes H2 and its sub-headings H3 (same look in both cases).
export const FOOTER_LEVELS = { section: 2, sub: 3 };

// Ids of the widgets this simulation inserts (10 digits like Duda's; never present on the live pages).
export const SIM_IDS = { menuText: '1990000101', menuLink: '1990000102', menuHtml: '1990000103' };

// ------------------------------------------------------------------------------------------------- string helpers
const decode = s => s
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const textOf = inner => decode(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const escAttr = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// <tag attrs>inner</tag> blocks that contain no nested element of the same tag(s) (paragraphs, headings).
const blockRe = tags => new RegExp(`<(${tags.join('|')})\\b([^>]*)>((?:(?!<\\/?(?:${tags.join('|')})\\b)[\\s\\S])*?)<\\/\\1\\s*>`, 'gi');

// Edits the attribute string of a start tag (the part between the tag name and ">"), keeping everything else as is.
function editAttrs(attrs, { addClass = [], style = null, set = null, remove = [] } = {}) {
  let a = attrs;
  for (const name of remove) a = a.replace(new RegExp(`\\s+${escRe(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=[\\s/>]|$)`, 'gi'), '');
  if (addClass.length) {
    const m = /\sclass\s*=\s*"([^"]*)"/i.exec(a);
    if (m) {
      const have = m[1].split(/\s+/).filter(Boolean);
      const add = addClass.filter(c => !have.includes(c));
      if (add.length) a = a.slice(0, m.index) + ` class="${[...have, ...add].join(' ')}"` + a.slice(m.index + m[0].length);
    } else a = a.replace(/(\s*\/?)$/, ` class="${addClass.join(' ')}"$1`);
  }
  if (style && Object.keys(style).length) {
    const m = /\sstyle\s*=\s*"([^"]*)"/i.exec(a);
    let decls = m ? m[1].trim() : '';
    for (const [prop, val] of Object.entries(style)) {
      const re = new RegExp(`(^|;)(\\s*)${escRe(prop)}\\s*:[^;]*`, 'i');
      if (re.test(decls)) decls = decls.replace(re, `$1$2${prop}: ${val}`);
      else decls = (decls ? (/;$/.test(decls) ? decls + ' ' : decls + '; ') : '') + `${prop}: ${val};`;
    }
    if (m) a = a.slice(0, m.index) + ` style="${decls}"` + a.slice(m.index + m[0].length);
    else a = a.replace(/(\s*\/?)$/, ` style="${decls}"$1`);
  }
  for (const [name, val] of Object.entries(set || {})) {
    const re = new RegExp(`(\\s${escRe(name)}\\s*=\\s*)("[^"]*"|'[^']*'|[^\\s>]+)`, 'i');
    const v = `"${escAttr(val)}"`;
    if (re.test(a)) a = a.replace(re, (mm, pre) => `${pre}${v}`);
    else a = a.replace(/(\s*\/?)$/, ` ${name}=${v}$1`);
  }
  return a;
}

// Edits the first inline child element (<span>, <strong>, ...) of a block's inner HTML.
function editFirstChild(inner, edit) {
  if (!edit || !Object.keys(edit).length) return inner;
  return inner.replace(/^(\s*)<(span|strong|b|em|i|font)\b([^>]*)>/i, (m, ws, tag, attrs) => `${ws}<${tag}${editAttrs(attrs, edit)}>`);
}

// Changes the tag (and optionally block/inner attributes) of every block whose text matches `text`.
function retagBlocks(html, { tags, text, to = null, block = {}, inner = {}, limit = Infinity }) {
  let n = 0;
  const out = html.replace(blockRe(tags), (m, tag, attrs, content) => {
    if (n >= limit || !text.test(textOf(content))) return m;
    n++;
    const t = to || tag;
    return `<${t}${editAttrs(attrs, block)}>${editFirstChild(content, inner)}</${t}>`;
  });
  return { html: out, n };
}

// Index right after the end of the element whose start tag begins at `start` (balanced on its own tag name).
function elementEnd(html, start) {
  const tag = /^<([a-z0-9-]+)/i.exec(html.slice(start, start + 40))[1];
  const re = new RegExp(`<(\\/?)${escRe(tag)}\\b[^>]*>`, 'gi');
  re.lastIndex = start;
  let depth = 0, m;
  while ((m = re.exec(html))) {
    if (!m[1] && /\/>$/.test(m[0])) continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

// Innermost element of tag `tag` that encloses index `idx` and whose start tag passes `test`.
function enclosing(html, idx, tag, test) {
  const re = new RegExp(`<${escRe(tag)}\\b[^>]*>`, 'gi');
  const starts = [];
  let m;
  while ((m = re.exec(html)) && m.index < idx) if (test(m[0])) starts.push(m.index);
  for (let i = starts.length - 1; i >= 0; i--) {
    const end = elementEnd(html, starts[i]);
    if (end > idx) return { start: starts[i], end, startTag: html.slice(starts[i], html.indexOf('>', starts[i]) + 1) };
  }
  return null;
}

// Sets the alt of every <img> whose tag contains `key`; `pick(tag, offset, html)` returns the alt, or null to skip.
function editImages(html, key, pick) {
  let n = 0;
  const out = html.replace(/<img\b([^>]*?)(\s*\/?)>/gi, (m, attrs, close, offset) => {
    if (!attrs.includes(key)) return m;
    const alt = pick(m, offset, html);
    if (alt == null) return m;
    n++;
    return `<img${editAttrs(attrs, { set: { alt } })}${close}>`;
  });
  return { html: out, n };
}

// Duda writes one rule per font size in use into <style id="globalFontSizeStyle"> (desktop sizes in both layouts,
// `.dmMobileBody .m-...` sizes only in the phone HTML). Picking a size that no text uses yet adds its rule there.
function ensureFontSizes(html, device, { desktop = [], mobile = [] }, notes) {
  const m = /(<style\b[^>]*\bid="globalFontSizeStyle"[^>]*>)([\s\S]*?)(<\/style>)/i.exec(html);
  const css = m ? m[2] : '';
  const add = [];
  for (const n of desktop) if (!new RegExp(`\\.font-size-${n}\\b`).test(css)) add.push(`.font-size-${n}, .size-${n}, .size-${n} > font { font-size: ${n}px !important; }`);
  if (device === 'mobile') for (const n of mobile) if (!new RegExp(`\\.m-font-size-${n}\\b`).test(css)) add.push(`.dmMobileBody .m-font-size-${n}, .dmMobileBody .m-size-${n}, .dmMobileBody .m-size-${n} > font { font-size: ${n}px !important; }`);
  if (!add.length) return html;
  notes.push(`font-size rules added to globalFontSizeStyle: ${add.map(r => r.split(',')[0].trim()).join(', ')}`);
  if (m) return html.slice(0, m.index) + m[1] + m[2].replace(/\s*$/, '') + add.join('') + '\n' + m[3] + html.slice(m.index + m[0].length);
  const h = html.search(/<\/head\s*>/i);
  return html.slice(0, h) + `<style id="globalFontSizeStyle" type="text/css">\n    ${add.join('')}\n</style>` + html.slice(h);
}

// href of the link that encloses `idx` ('' when the link has no href), or null when not inside a link.
function enclosingLinkHref(html, idx) {
  const open = Math.max(html.lastIndexOf('<a ', idx), html.lastIndexOf('<a\n', idx));
  if (open < 0 || html.lastIndexOf('</a>', idx) > open) return null;
  const tag = html.slice(open, html.indexOf('>', open) + 1);
  const m = /\shref\s*=\s*"([^"]*)"/i.exec(tag);
  return m ? m[1] : '';
}

// ---------------------------------------------------------------------------------------------- inserted widgets
// Duda text widget (classic layout: inside a dmRespCol; flex layout: wrapped in a flex widget-wrapper).
function textWidget(id, innerHtml, flex) {
  const w = `<div class="dmNewParagraph" data-element-type="paragraph" data-version="5" id="${id}" style="">${innerHtml}</div>`;
  return flex ? `<div id="widget_sim${id.slice(-3)}" class="flex-element widget-wrapper" data-auto="flex-element-widget-wrapper" data-widget-type="paragraph" data-external-id="${id}">${w}</div>` : w;
}
// Duda HTML widget ("HTML" / custom code widget), same markup as the map widget on /contact-us.
function htmlWidget(id, innerHtml, flex) {
  const w = `<div data-element-type="html" class="u_${id} dmCustomHtml" id="${id}">${innerHtml}</div>`;
  return flex ? `<div id="widget_sim${id.slice(-3)}" class="flex-element widget-wrapper" data-auto="flex-element-widget-wrapper" data-widget-type="html" data-external-id="${id}">${w}</div>` : w;
}

// Content of fixed/menu/menu-section.html (read at transform time; another agent writes it).
export function readMenuSection() {
  if (!existsSync(MENU_SECTION_FILE)) return null;
  let s = readFileSync(MENU_SECTION_FILE, 'utf8').replace(/^﻿/, '');
  // Defensive: a Duda HTML widget takes a fragment, so drop any document wrapper.
  s = s.replace(/<!doctype[^>]*>/gi, '').replace(/<head\b[\s\S]*?<\/head>/gi, '').replace(/<\/?(html|body)\b[^>]*>/gi, '');
  return s.trim();
}
const menuFacts = section => ({ hasH1: !!section && /<h1\b/i.test(section), hasPdfLink: !!section && /<a\b[^>]*href\s*=\s*"[^"]*\.pdf/i.test(section) });

// Ranges of the two menu image widgets on /menu (flex wrapper if present, else the classic image widget).
function menuImageWidgets(html) {
  const ranges = [];
  const re = new RegExp(`<img\\b[^>]*${escRe(MENU_IMAGE_KEY)}[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const at = m.index;
    if (ranges.some(r => at >= r.start && at < r.end)) continue;
    const wrap = enclosing(html, at, 'div', t => /data-widget-type="image"/.test(t) && /widget-wrapper/.test(t));
    const widget = wrap || enclosing(html, at, 'div', t => /data-element-type="image"/.test(t));
    if (widget) ranges.push({ ...widget, flex: !!wrap });
  }
  return ranges;
}

// ------------------------------------------------------------------------------------------------------ changes
const ALL = '*';
const POPPINS = "Poppins, 'Poppins Fallback'";

export const CHANGES = [
  {
    id: 'E1', findings: ['F3'], pages: ['/'],
    description: 'Home: the hero title "47 Years of Service & Care" (a paragraph) becomes Heading 1 with the same look; the current H1 "Reach Your Health Goals with Our Supplements & Wellness Products" becomes Heading 2 with the same look (50 px desktop, 40 px phone).',
    dudaSteps: [
      'Abrir la página Home en el editor (vista Desktop).',
      'Hacer clic en el texto "Reach Your Health Goals with Our Supplements & Wellness Products" (es el H1 actual). Seleccionar toda la línea y, en la barra de texto, cambiar el formato de "Heading 1" a "Heading 2".',
      'Con el texto todavía seleccionado, poner el tamaño de letra en 50 (Desktop). Cambiar a la vista Mobile, seleccionar el mismo texto y poner el tamaño en 40 (en Mobile el Heading 2 del tema es más pequeño: 28 px). Volver a Desktop.',
      'Hacer clic en "47 Years of Service & Care" (el texto grande del banner). Seleccionar la línea y cambiar el formato de "Paragraph" (texto normal) a "Heading 1". No tocar color, fuente ni tamaño: Duda conserva el estilo del texto (blanco, Caprasimo, 80 px / 64 px en Mobile).',
      'Verificar en la vista previa que ambos textos se ven igual que antes (verificar en el panel: el nombre exacto del menú de formato puede ser "Paragraph style" / "Text style").',
    ],
    apply(html, ctx) {
      // Order matters: demote the existing H1 first, then promote the hero paragraph.
      const a = retagBlocks(html, { tags: ['h1'], text: /^Reach Your Health Goals\b/, to: 'h2', limit: 1,
        block: { addClass: ['size-50', 'm-size-40'] }, inner: { addClass: ['font-size-50', 'm-font-size-40'] } });
      ctx.notes.push(`H1 "Reach Your Health Goals..." -> H2: ${a.n}`);
      const b = retagBlocks(a.html, { tags: ['p'], text: /^47 Years of Service & Care$/, to: 'h1', limit: 1 });
      ctx.notes.push(`"47 Years of Service & Care" p -> H1: ${b.n}`);
      if (!a.n || !b.n) ctx.notes.push('WARNING: expected target not found');
      return a.n ? ensureFontSizes(b.html, ctx.device, { desktop: [50], mobile: [40] }, ctx.notes) : b.html;
    },
  },
  {
    id: 'E2', findings: ['F3'], pages: [ALL],
    description: `Global footer: "STORE" and "RESTAURANT" (bold text in paragraphs) become Heading ${FOOTER_LEVELS.sub} with the same look (16 px desktop / 15 px phone, black, Poppins bold).`,
    dudaSteps: [
      'Abrir cualquier página (el footer es global: el cambio se aplica a todas).',
      'En el footer, hacer clic en el bloque de horarios y seleccionar solo la línea "STORE".',
      `Cambiar el formato de "Paragraph" a "Heading ${FOOTER_LEVELS.sub}".`,
      'Con la línea seleccionada: fuente "Poppins", tamaño 16 (Desktop), color "Color 1" de la paleta del sitio (negro) e interlineado ("Line height") 1.5. Cambiar a la vista Mobile y poner el tamaño en 15. Volver a Desktop.',
      'Repetir con la línea "RESTAURANT".',
      'Verificar que las dos palabras se ven exactamente como antes (verificar en el panel: si la fuente ya aparece como Poppins, no hace falta cambiarla; si no hay opción de interlineado, omitirla: la diferencia es de 1 a 2 píxeles).',
    ],
    apply(html, ctx) {
      // Same look as today: 16 px desktop / 15 px phone, line height 1.5 (24 / 22.5 px), black (--color_1), Poppins
      // bold. Without these settings the theme's heading style makes the text larger and brown.
      const r = retagBlocks(html, { tags: ['p'], text: /^(STORE|RESTAURANT)$/, to: `h${FOOTER_LEVELS.sub}`,
        block: { addClass: ['size-16', 'm-size-15'], style: { 'line-height': '1.5' } },
        inner: { addClass: ['font-size-16', 'm-font-size-15'], style: { color: 'var(--color_1)', 'font-family': POPPINS } } });
      ctx.notes.push(`STORE/RESTAURANT p -> h${FOOTER_LEVELS.sub}: ${r.n}`);
      if (r.n !== 2) ctx.notes.push(`WARNING: expected 2 targets, found ${r.n}`);
      return r.n ? ensureFontSizes(r.html, ctx.device, { desktop: [16], mobile: [15] }, ctx.notes) : r.html;
    },
  },
  {
    id: 'E3', findings: ['A9'], pages: [ALL],
    description: `Global footer heading levels: "Need More Info? Get In Touch!" H3 -> H${FOOTER_LEVELS.section}; "Company Info" and "Links" H5 -> H${FOOTER_LEVELS.sub}; same look (sizes kept by their classes, black Poppins restored on the sub-headings). No skipped levels on any page, including /information-faqs (H1 -> H3 today) and /thank-you after E4.`,
    dudaSteps: [
      'En el footer (global), hacer clic en el título "Need More Info? Get In Touch!", seleccionarlo y cambiar el formato de "Heading 3" a "Heading 2". No cambiar tamaño ni color (Duda conserva 40 px / 32 px en Mobile).',
      `Hacer clic en "Company Info", seleccionarlo y cambiar el formato de "Heading 5" a "Heading ${FOOTER_LEVELS.sub}". Con el texto seleccionado: fuente "Poppins" y color "Color 1" (negro). El tamaño (16 / 13 en Mobile) se conserva.`,
      'Repetir con "Links".',
      'Verificar en la vista previa que los tres títulos se ven igual que antes.',
    ],
    apply(html, ctx) {
      const a = retagBlocks(html, { tags: ['h3'], text: /^Need More Info\? Get In Touch!$/, to: `h${FOOTER_LEVELS.section}` });
      ctx.notes.push(`"Need More Info? Get In Touch!" h3 -> h${FOOTER_LEVELS.section}: ${a.n}`);
      const b = retagBlocks(a.html, { tags: ['h5'], text: /^(Company Info|Links)$/, to: `h${FOOTER_LEVELS.sub}`,
        inner: { style: { color: 'var(--color_1)', 'font-family': POPPINS } } });
      ctx.notes.push(`Company Info/Links h5 -> h${FOOTER_LEVELS.sub}: ${b.n}`);
      if (a.n !== 1 || b.n !== 2) ctx.notes.push('WARNING: expected 1 + 2 targets');
      return b.html;
    },
  },
  {
    id: 'E4', findings: ['A8'], pages: ['/thank-you', '/menu'],
    description: '/thank-you: the confirmation message becomes Heading 1 with the same look. /menu: new text widget with the Heading 1 "Restaurant Menu" (theme H1 style, centered) above the menu.',
    dudaSteps: [
      'Página Thank You: hacer clic en "Thank you for contacting us! Your message has been received.", seleccionar la línea y cambiar el formato de "Paragraph" a "Heading 1". El tamaño (25 / 18 px), la negrita y la cursiva se conservan.',
      'Con la línea seleccionada: fuente "Poppins", color "Color 1" (negro) e interlineado 1.5, para que se vea igual que antes (sin esto toma el estilo de título del sitio: Caprasimo marrón).',
      'Página Menu: desde "Widgets", arrastrar un widget de texto ("Text" / "Paragraph") a la parte superior de la columna donde están las imágenes del menú.',
      'Escribir "Restaurant Menu", seleccionarlo, formato "Heading 1" y alineación centrada.',
      '(El enlace al PDF y el menú en texto se añaden en E5.)',
    ],
    apply(html, ctx) {
      if (ctx.path === '/thank-you') {
        // Same look as today (Poppins bold italic, black, 25 / 18 px, line height 1.5): the theme's H1 style would turn
        // it into a synthetic bold/italic Caprasimo in brown (checked in verify-look.mjs, Oct 12, 2026).
        const r = retagBlocks(html, { tags: ['p'], text: /^Thank you for contacting us!/, to: 'h1', limit: 1,
          block: { style: { 'line-height': '1.5' } }, inner: { style: { color: 'var(--color_1)', 'font-family': POPPINS } } });
        ctx.notes.push(`thank-you message p -> h1: ${r.n}`);
        if (!r.n) ctx.notes.push('WARNING: confirmation message not found');
        return r.html;
      }
      // /menu
      if (html.includes(`id="${SIM_IDS.menuText}"`)) { ctx.notes.push('menu H1 widget already present'); return html; }
      if (isActive('E5', ctx) && menuFacts(readMenuSection()).hasH1) { ctx.notes.push('menu-section.html provides the H1: no separate H1 widget'); return html; }
      const h1 = `<h1 class="text-align-center"><span style="display: unset;">${escText(MENU_H1_TEXT)}</span></h1>`;
      const imgs = menuImageWidgets(html);
      let at = imgs.length ? imgs[0].start : -1;
      let flex = imgs.length ? imgs[0].flex : false;
      if (at < 0) { // images already replaced (E5 ran first) or missing: before the HTML widget, else the first content column
        const hw = html.indexOf(`id="${SIM_IDS.menuHtml}"`);
        if (hw >= 0) {
          const wrap = enclosing(html, hw, 'div', t => /widget-wrapper/.test(t) && t.includes(SIM_IDS.menuHtml));
          const w = wrap || enclosing(html, hw, 'div', t => t.includes(`id="${SIM_IDS.menuHtml}"`));
          if (w) { at = w.start; flex = !!wrap; }
        } else {
          const c = html.indexOf('id="dm_content"');
          const m = c >= 0 ? /<div\b[^>]*class="(?![^"]*empty-column)[^"]*\bdmRespCol\b[^"]*"[^>]*>/i.exec(html.slice(c)) : null;
          if (m) at = c + m.index + m[0].length;
        }
      }
      if (at < 0) { ctx.notes.push('WARNING: no place found for the menu H1'); return html; }
      ctx.notes.push(`menu H1 "${MENU_H1_TEXT}" inserted (${flex ? 'flex' : 'classic'} layout)`);
      return html.slice(0, at) + `<!-- editor-sim E4 (A8): new text widget -->${textWidget(SIM_IDS.menuText, h1, flex)} ` + html.slice(at);
    },
  },
  {
    id: 'E5', findings: ['F2', 'A3'], pages: ['/menu'],
    description: `/menu: the two menu images (image links to the untagged PDF, new window) are removed; in their place a text link "${MENU_PDF_LINK_TEXT}" to the tagged PDF (same window) and an HTML widget with the menu as real text (fixed/menu/menu-section.html).`,
    dudaSteps: [
      'Antes: subir el PDF accesible y copiar su dirección (CAMBIOS-ADA.md, sección 4).',
      'Página Menu: seleccionar la primera imagen del menú y eliminarla (icono de papelera). Hacer lo mismo con la segunda imagen.',
      'Desde "Widgets", arrastrar un widget "HTML" (código personalizado / "Embed HTML", el mismo tipo que el mapa de Contact Us) justo debajo del título "Restaurant Menu" (E4).',
      `En menu/menu-section.html, reemplazar ${MENU_PDF_URL} (enlace "${MENU_PDF_LINK_TEXT}", misma ventana) por la dirección del PDF subido; luego "Edit HTML" del widget → pegar todo el contenido → Guardar.`,
      `Si se usa una versión de menu-section.html sin enlace al PDF: en el widget de texto de E4, debajo del título, escribir "${MENU_PDF_LINK_TEXT}" → "Link" → tipo "File" → el PDF subido → sin "Open in a new tab" (verificar en el panel). La simulación detecta el caso y crea ese enlace.`,
      'Verificar en la vista previa (Desktop y Mobile) que el menú se lee como texto, con títulos por sección, y que el enlace abre el PDF nuevo en la misma pestaña.',
      'Alternativa documentada (no recomendada): conservar las imágenes debajo del menú en texto como decorativas: en cada imagen, texto alternativo vacío y sin enlace.',
    ],
    apply(html, ctx) {
      const imgs = menuImageWidgets(html);
      if (!imgs.length) { ctx.notes.push(html.includes(`id="${SIM_IDS.menuHtml}"`) ? 'already applied' : 'WARNING: menu image widgets not found'); return html; }
      const section = readMenuSection();
      const facts = menuFacts(section);
      const flex = imgs[0].flex;
      const content = section ?? '<!-- editor-sim E5: fixed/menu/menu-section.html does not exist yet; the menu as text goes here -->';
      const linkP = `<p class="text-align-center"><a href="${MENU_PDF_URL}" runtime_url="${MENU_PDF_URL}">${escText(MENU_PDF_LINK_TEXT)}</a></p>`;
      const MARK = '\u0000E5LINK\u0000';
      let out = html;
      // Remove the image widgets, last first so earlier offsets stay valid; the replacement goes where the first was.
      for (const r of [...imgs].sort((x, y) => y.start - x.start)) {
        const repl = r === imgs[0]
          ? `<!-- editor-sim E5 (F2, A3): menu images removed; menu as text -->${facts.hasPdfLink ? '' : MARK}${htmlWidget(SIM_IDS.menuHtml, content, flex)}`
          : '';
        out = out.slice(0, r.start) + repl + out.slice(r.end);
      }
      // PDF link: inside the E4 text widget when it exists (one text widget: H1 + link), else in its own text widget.
      if (out.includes(MARK)) {
        const tw = out.indexOf(`id="${SIM_IDS.menuText}"`);
        const w = tw >= 0 ? enclosing(out, tw, 'div', t => t.includes(`id="${SIM_IDS.menuText}"`)) : null;
        if (w) {
          const closeAt = w.end - '</div>'.length;
          out = (out.slice(0, closeAt) + linkP + out.slice(closeAt)).replace(MARK, '');
          ctx.notes.push('PDF link added to the E4 text widget');
        } else {
          out = out.replace(MARK, textWidget(SIM_IDS.menuLink, linkP, flex) + ' ');
          ctx.notes.push('PDF link added in its own text widget');
        }
      } else ctx.notes.push('menu-section.html already links the PDF: no separate link');
      ctx.notes.push(`menu image widgets removed: ${imgs.length}; menu-section.html ${section ? 'inserted' : 'MISSING (placeholder comment)'}`);
      return out;
    },
  },
  {
    id: 'E6', findings: ['A6'], pages: [ALL],
    description: `Image alt text: owner photo (/about-us) alt "${OWNER_ALT}" (name and role from the page text; resolved 2026-10-13); every logo that links to the home page alt "${LOGO_ALT}" (desktop header, phone header, footer).`,
    dudaSteps: [
      'Página About Us: hacer clic en la foto de la sección "About the Owner" → configuración de la imagen (icono de engranaje / "Image settings") → campo "Alt text" (texto alternativo / SEO).',
      `Reemplazar "Staff member" por: ${OWNER_ALT}  (nombre tomado del texto de la página; si la foto no es de Anthony, poner el nombre de la persona y su función).`,
      `Logo del encabezado (vista Desktop): hacer clic en el logo → "Alt text": ${LOGO_ALT}`,
      'Cambiar a la vista Mobile y repetir en el logo del encabezado móvil (en este sitio el encabezado móvil es otro widget).',
      'Footer (global): repetir en el logo del footer.',
      'Verificar en el panel: en Duda el campo puede llamarse "Alt text", "Image description" o estar en la pestaña "SEO" de la imagen.',
    ],
    apply(html, ctx) {
      const owner = editImages(html, OWNER_PHOTO_KEY, () => OWNER_ALT);
      if (owner.n) ctx.notes.push(`owner photo alt set: ${owner.n}`);
      const logo = editImages(owner.html, LOGO_KEY, (tag, offset, src) => {
        const href = enclosingLinkHref(src, offset);
        if (href == null) return LOGO_ALT_UNLINKED;
        return href === '/' || /^(https?:)?\/\/(www\.anthonyshealthhutlakeland\.com|localhost(:\d+)?|127\.0\.0\.1(:\d+)?)\/?$/i.test(href) ? LOGO_ALT : null;
      });
      ctx.notes.push(`logo alt set: ${logo.n}`);
      if (!logo.n) ctx.notes.push('WARNING: no logo image found');
      if (ctx.path === '/about-us' && !owner.n) ctx.notes.push('WARNING: owner photo not found');
      return logo.html;
    },
  },
  {
    // Battery fix 2 N3 (Alfa sia-r78, best practice; found by the test battery, not an Exhibit B item). After E3 the
    // footer section heading is an H2, so the page's H2 "Coming Soon!" became an empty section (H2 followed directly by
    // H2). The page has no other content to put under it (user, Oct 12, 2026: "solo tenemos lo que esta en la pagina
    // web"), and "Coming Soon!" is a status note, not the title of a section, so it becomes a paragraph with the same
    // look (Caprasimo, 50 px desktop / 28 px phone, palette color 9, centered; line height 1.14 = the H2's "normal"
    // line height: 57 px / 31.9 px tall, as before; results/battery-fix-2/probes/n3-lineheight.json).
    id: 'E7', findings: ['N3'], pages: ['/daily-specials'],
    description: '/daily-specials: the note "Coming Soon!" (Heading 2 with no content under it) becomes a paragraph with the same look (Caprasimo, 50 px desktop / 28 px phone, color 9 of the palette, centered). No text is added or removed.',
    dudaSteps: [
      'Abrir la página Daily Specials en el editor (vista Desktop).',
      'Hacer clic en el texto "Coming Soon!", seleccionar toda la línea y cambiar el formato de "Heading 2" a "Paragraph" (texto normal).',
      'Con la línea todavía seleccionada: fuente "Caprasimo", tamaño 50, color "Color 9" de la paleta del sitio (marrón oscuro) e interlineado ("Line height") 1.14 (la altura de línea del título actual; si el panel solo admite un decimal, 1.1). Cambiar a la vista Mobile, seleccionar el mismo texto y poner el tamaño en 28. Volver a Desktop.',
      'Verificar en la vista previa (Desktop y Mobile) que "Coming Soon!" se ve igual que antes (verificar en el panel: si no hay opción de interlineado, omitirla: la diferencia es de unos pocos píxeles de alto).',
      'Si más adelante la página tiene ofertas reales, se puede volver a usar un título encima de ellas.',
    ],
    apply(html, ctx) {
      const r = retagBlocks(html, { tags: ['h2'], text: /^Coming Soon!$/, to: 'p', limit: 1,
        block: { addClass: ['size-50', 'm-size-28'], style: { 'line-height': '1.14' } },
        inner: { addClass: ['font-size-50', 'm-font-size-28'], style: { 'font-family': 'Caprasimo', color: 'var(--color_9)' } } });
      ctx.notes.push(`"Coming Soon!" h2 -> p: ${r.n}`);
      if (!r.n) ctx.notes.push('WARNING: "Coming Soon!" heading not found');
      return r.n ? ensureFontSizes(r.html, ctx.device, { desktop: [50], mobile: [28] }, ctx.notes) : r.html;
    },
  },
  {
    // v1.2.0, human review of the headings outline (results/manual/human-review-verdicts.md, HD-4 home): on Home the two
    // product sections "Optimize Your Nutrition & Performance" (H2) and "Lifestyle & Personal Care Products" (H3) sit
    // side by side with the same look (Caprasimo 50 px desktop / 40 px phone, same classes); the H3 made "Lifestyle &
    // Personal Care Products" a subsection of "Optimize Your Nutrition & Performance" (WCAG 1.3.1 info and
    // relationships). It becomes Heading 2, like its sibling; only the tag changes (same classes and inline style).
    id: 'E8', findings: ['HD-4 (1.3.1, human review)'], pages: ['/'],
    description: 'Home: "Lifestyle & Personal Care Products" (Heading 3 next to the Heading 2 "Optimize Your Nutrition & Performance", a parallel section with the same look) becomes Heading 2. Same classes and inline style, so the look does not change.',
    dudaSteps: [
      'Abrir la página Home en el editor (vista Desktop).',
      'Hacer clic en el título "Lifestyle & Personal Care Products" (a la derecha de "Optimize Your Nutrition & Performance"), seleccionar toda la línea y cambiar el formato de "Heading 3" a "Heading 2".',
      'Comprobar que el tamaño sigue en 50 (Desktop) y, en la vista Mobile, en 40; si Duda los cambia al aplicar el estilo del Heading 2, volver a ponerlos (igual que "Optimize Your Nutrition & Performance", que ya es Heading 2).',
      'Verificar en la vista previa (Desktop y Mobile) que el título se ve igual que antes.',
    ],
    apply(html, ctx) {
      const r = retagBlocks(html, { tags: ['h3'], text: /^Lifestyle & Personal Care Products$/, to: 'h2', limit: 1 });
      ctx.notes.push(`"Lifestyle & Personal Care Products" h3 -> h2: ${r.n}`);
      if (!r.n) ctx.notes.push('WARNING: "Lifestyle & Personal Care Products" heading not found');
      return r.html;
    },
  },
  {
    id: 'C9e', findings: ['A4'], pages: [ALL],
    description: 'Editor part of C9: phone (tel:) links must not open a new window. One tel: link has target="_blank" in the saved markup (link setting "Open in new tab"): the bold "(863) 644-5330" in the "Our Location" text block of /contact-us, desktop and phone (1 instance; review fix RF-9). This transform removes it, as the editor step does. Duda\'s runtime also adds target="_blank" to every tel: link at page load; the Head HTML script removes that (C9-H).',
    dudaSteps: [
      'Página Contact Us, bloque de texto "Our Location" (dirección y horarios): clic en el enlace "(863) 644-5330" (en negrita) -> configuración del enlace (Link) -> desmarcar "Open in new tab" / "Open in a new window" -> Guardar (verificar en el panel). Es el único enlace de teléfono con esa opción marcada en el código guardado (escritorio y móvil comparten el texto; comprobar en la vista Mobile que también quedó desmarcado).',
      'Los demás enlaces de teléfono (botón "(863) 644-5330" del encabezado, ícono de llamada del encabezado móvil, "(863) 644-5330" del footer y el botón "Call Us") no tienen la opción marcada: Duda añade target="_blank" al cargar la página y lo corrige el script del Head HTML (C9).',
      'Si en el futuro se edita uno de esos enlaces: dejar desmarcada la opción "Open in a new tab/window" (verificar en el panel).',
    ],
    apply(html, ctx) {
      let n = 0;
      const out = html.replace(/<a\b([^>]*\shref\s*=\s*"tel:[^"]*"[^>]*)>/gi, (m, attrs) => {
        if (!/\starget\s*=\s*"_blank"/i.test(attrs)) return m;
        n++;
        return `<a${editAttrs(attrs, { remove: ['target'] })}>`;
      });
      ctx.notes.push(`tel: links with target="_blank" in the editor markup: ${n}`);
      return out;
    },
  },
];

// ------------------------------------------------------------------------- publish step: per-page critical CSS
// Not an editor step (nothing for the client to do): staging fidelity, battery fix V2/V3.
// On pages that load the theme CSS deferred (rel=preload + loadCSS: /, /menu, /contact-us), Duda writes an inline
// <style id="criticalCss"> at publish time with the theme rules of the elements at the top of THAT page. The snapshots
// show it (Oct 2026): / and /contact-us carry the H1 theme rules, /contact-us also the H2 rules, /menu has none (no
// heading on the live /menu). After E4 (new H1 on /menu) and E1 (new H2 in the home hero) the real publish would add
// those rules; without them the staging page painted the new headings in Poppins 32px for ~2 s and then jumped to
// Caprasimo 50px (CLS 0.03-0.04, V2) and the home hero H2 switched font late at 320px (V3).
// The rules below are copied verbatim from the site's own critical CSS in the snapshots (desktop and phone differ only in
// the font size: H1 50/40px, H2 50/28px - the same values as the theme CSS loaded later).
const CRITICAL_THEME = {
  common: {
    h1: ['.dmNewParagraph[data-version] h1{margin-top:0;margin-bottom:0}', 'h1{margin-left:0;margin-right:0}',
      '#dm div.dmInner h1{font-family:Montserrat,"Montserrat Fallback"}',
      '#dm div.dmContent h1{color:#000;color:var(--color_9);font-family:Caprasimo;direction:ltr;font-weight:400;font-style:normal}',
      '#dm div.dmContent h1{text-decoration:#000;letter-spacing:0}', '#dm div.dmContent .dmNewParagraph[data-version] h1{text-decoration:inherit}',
      '#dm div.dmContent .dmNewParagraph[data-version] h1 *{text-decoration:#000}'],
    h2: ['.dmNewParagraph[data-version] h2{margin-top:0;margin-bottom:0}', 'h2{margin-left:0;margin-right:0}',
      '#dm div.dmInner h2{font-family:Montserrat,"Montserrat Fallback"}',
      '#dm div.dmContent h2{color:#000;color:var(--color_9);font-family:Caprasimo;direction:ltr;font-weight:400;font-style:normal}',
      '#dm div.dmContent h2{text-decoration:#000}', '#dm div.dmContent .dmNewParagraph[data-version] h2{text-decoration:inherit}',
      '#dm div.dmContent .dmNewParagraph[data-version] h2 *{text-decoration:#000}'],
    align: ['.dmNewParagraph[data-version] .text-align-center{text-align:center!important}', '.text-align-center{text-align:center}'],
    // Duda runtime rules of the widget types inserted at the top of /menu (text widget E4, HTML widget E5), as in the
    // critical CSS of / and /contact-us, which have such widgets above the fold.
    widgets: ['.dmNewParagraph{text-align:left;margin:8px 0;padding:2px 0}', '.dmCustomHtml{margin:10px 0}'],
  },
  desktop: { h1: ['#dm div.dmContent h1{line-height:initial}', '#dm div.dmContent h1{font-size:50px;line-height:normal}'], h2: ['#dm div.dmContent h2{line-height:initial}', '#dm div.dmContent h2{font-size:50px}'] },
  mobile: { h1: ['#dm div.dmContent h1{line-height:initial;font-size:40px}'], h2: ['#dm div.dmContent h2{line-height:initial;font-size:28px}'] },
};

// Adds the theme rules of `tags` (h1 / h2) to the page's criticalCss when they are missing (pages without deferred CSS
// have no criticalCss block: the theme CSS is render-blocking there, nothing to do).
function refreshCriticalCss(html, device, tags, notes, widgets = false) {
  const m = /(<style\b[^>]*\bid="criticalCss"[^>]*>)([\s\S]*?)(<\/style>)/i.exec(html);
  if (!m) return html;
  const css = m[2];
  const add = [];
  for (const tag of tags) {
    if (new RegExp(`#dm div\\.dmContent ${tag}\\{[^}]*font-size`).test(css)) continue; // Duda already has them
    add.push(...CRITICAL_THEME.common[tag], ...(CRITICAL_THEME[device] || CRITICAL_THEME.desktop)[tag]);
  }
  if (widgets) for (const r of CRITICAL_THEME.common.widgets) if (!css.includes(r.split('{')[0] + '{')) add.push(r);
  if (!add.length) return html;
  for (const r of CRITICAL_THEME.common.align) if (!css.includes(r)) add.push(r);
  notes.push(`criticalCss: theme rules for ${tags.join(', ')}${widgets ? ' + text/HTML widget rules' : ''} added (${add.length} rules), as Duda does on publish`);
  return html.slice(0, m.index) + m[1] + css + add.join('') + m[3] + html.slice(m.index + m[0].length);
}

// ------------------------------------------------------------------------------------------------------ driver
const normPath = p => {
  let s = String(p || '/');
  try { s = new URL(s, 'http://x').pathname; } catch { /* keep */ }
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.toLowerCase().replace(/\/+$/, '');
  return s === '' || s === '/index' || s === '/index.html' ? '/' : s;
};
const pageMatches = (pages, p) => pages.includes(ALL) || pages.includes(p);
const onlyFromEnv = () => (process.env.EDITOR_SIM_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
function isActive(id, ctx) { return !ctx.only || ctx.only.includes(id); }

export function transformWithReport(html, { path: p = '/', device = 'desktop', mode = 'fixed', only = null } = {}) {
  const report = { path: normPath(p), device, mode, changes: [] };
  if (mode !== 'fixed' || typeof html !== 'string' || !/<\/html\s*>/i.test(html)) return { html, report };
  const envOnly = onlyFromEnv();
  const sel = only && only.length ? only : (envOnly.length ? envOnly : null);
  const ctx = { path: report.path, device, mode, only: sel, notes: [] };
  for (const c of CHANGES) {
    if (sel && !sel.includes(c.id)) continue;
    if (!pageMatches(c.pages, ctx.path)) continue;
    ctx.notes = [];
    const before = html;
    try { html = c.apply(html, ctx); } catch (e) { html = before; ctx.notes.push(`ERROR ${e.message}`); console.warn(`[editor-sim] ${c.id} ${ctx.path} ${device}: ${e.message}`); }
    report.changes.push({ id: c.id, findings: c.findings, changed: html !== before, notes: ctx.notes });
  }
  // Publish step (staging fidelity, battery fix V2/V3): critical CSS for the headings the editor changes added at the
  // top of the page (E1: H2 in the home hero; E4: H1 on /menu).
  const need = [];
  if (report.changes.some(c => c.id === 'E1' && c.changed)) need.push('h1', 'h2');
  if (ctx.path === '/menu' && report.changes.some(c => c.id === 'E4' && c.changed)) need.push('h1');
  if (need.length) {
    const notes = [];
    const before = html;
    try { html = refreshCriticalCss(html, device, [...new Set(need)], notes, ctx.path === '/menu'); } catch (e) { html = before; notes.push(`ERROR ${e.message}`); }
    report.changes.push({ id: 'publish-criticalCss', findings: [], changed: html !== before, notes });
  }
  return { html, report };
}

export function transform(html, opts = {}) {
  return transformWithReport(html, opts).html;
}
