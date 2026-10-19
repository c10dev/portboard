// @ts-check
// Why a list is empty, and the next step (#35): one bold line, a short explanation, buttons. Only phrasing content,
// so the box can be the page's existing <p class="empty"> as well as a <div>. Style: .why-empty in palette.css.

import { button, el } from './dom.js';

/** Fill box with { title, text?, actions?: [{ label, onClick }] }; returns box */
export function whyEmpty(box, { title, text, actions = [] }) {
  box.classList.add('why-empty');
  const acts = el('span', 'acts');
  acts.append(...actions.map((a) => button(a.label, a.onClick)));
  box.replaceChildren(el('strong', null, title), ...(text ? [el('span', 'why', text)] : []), ...(actions.length ? [acts] : []));
  return box;
}
