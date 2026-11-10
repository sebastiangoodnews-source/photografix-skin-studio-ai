/**
 * A tiny, strict-enough DOM for headless UI tests.
 *
 * The point is not to reimplement a browser: it is to execute the real panel code
 * (event wiring, schema rendering, report rendering, keyboard-free interactions)
 * and fail loudly on the mistakes that only show up at runtime - a missing element
 * id, a listener bound to null, an innerHTML assignment that silently drops state.
 *
 * Anything the UI needs but this does not implement throws with a clear message, so
 * an unsupported browser API surfaces as a test failure rather than a silent no-op.
 */

class ClassList {
  constructor(node) {
    this.node = node;
    this.set = new Set();
  }
  add(...names) {
    for (const n of names) if (n) this.set.add(n);
  }
  remove(...names) {
    for (const n of names) this.set.delete(n);
  }
  _sync() {
    if (this.node) this.node._className = [...this.set].join(' ');
  }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }
  contains(name) {
    return this.set.has(name);
  }
  get value() {
    return [...this.set].join(' ');
  }
  toString() {
    return this.value;
  }
}

class Style {
  constructor() {
    this._props = {};
  }
  setProperty(k, v) {
    this._props[k] = v;
  }
  getPropertyValue(k) {
    return this._props[k] || '';
  }
  get cssText() {
    return Object.entries(this._props)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
  }
}

export class Node {
  constructor(tagName = 'div', ownerDocument = null) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.classList = new ClassList(this);
    this.style = new Style();
    this._text = '';
    this._value = '';
    this.checked = false;
    this.disabled = false;
    this.id = '';
    this._className = '';
  }

  get className() {
    return this._className;
  }

  set className(value) {
    this._className = String(value ?? '');
    this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
  }

  get children() {
    return this.childNodes;
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get nodeType() {
    return 1;
  }

  appendChild(child) {
    if (!child) throw new Error(`appendChild(${child}) on <${this.tagName.toLowerCase()}>`);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? this.ownerDocument.createTextNode(n) : n);
    }
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  set textContent(value) {
    this.childNodes = [];
    this._text = String(value ?? '');
  }

  get textContent() {
    return this._text + this.childNodes.map((c) => c.textContent).join('');
  }

  set innerHTML(value) {
    this.childNodes = [];
    this._text = '';
    this._html = String(value ?? '');
  }

  get innerHTML() {
    // The UI only ever assigns via innerHTML to clear a container, then appends real
    // nodes - so an assignment must leave nothing but the raw marker behind.
    return this._html || this.childNodes.map((c) => c.outerHTML).join('');
  }

  get outerHTML() {
    const attrs = Object.entries(this.attributes)
      .map(([k, v]) => ` ${k}="${v}"`)
      .join('');
    return `<${this.tagName.toLowerCase()}${attrs}>${this.textContent}</${this.tagName.toLowerCase()}>`;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') {
      this.className = String(value);
      this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean));
    }
    if (name.startsWith('data-')) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = String(value);
    }
    if (name === 'value') this._value = String(value);
    if (name === 'checked') this.checked = value === 'true' || value === true;
    if (name === 'disabled') this.disabled = value === 'true' || value === true;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  hasAttribute(name) {
    return name in this.attributes;
  }

  set value(v) {
    this._value = String(v ?? '');
    this.attributes.value = this._value;
  }

  get value() {
    return this._value;
  }

  set width(v) {
    this.attributes.width = String(v);
  }

  get width() {
    return Number(this.attributes.width || 0);
  }

  set height(v) {
    this.attributes.height = String(v);
  }

  get height() {
    return Number(this.attributes.height || 0);
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') throw new Error(`addEventListener("${type}") needs a function, got ${typeof handler}`);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * Dispatch a real event object. `bubbles` is honoured because the panel relies on
   * delegated listeners in some places.
   */
  dispatchEvent(event) {
    const payload = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event };
    for (const handler of [...(this.listeners.get(payload.type) || [])]) handler.call(this, payload);
    if (payload.bubbles && this.parentNode) this.parentNode.dispatchEvent({ ...payload, target: this });
    return true;
  }

  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: 'click', bubbles: true });
  }

  /** Simulate user input: sets the value first, like a browser does. */
  type(value, eventType = 'input') {
    this.value = value;
    this.checked = value === 'true';
    this.dispatchEvent({ type: eventType, bubbles: true });
  }

  focus() {}
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() {
    return { x: 0, y: 0, width: 320, height: 420, top: 0, left: 0, right: 320, bottom: 420 };
  }

  /** Depth-first search by predicate. */
  find(predicate) {
    for (const child of this.childNodes) {
      if (predicate(child)) return child;
      const found = child.find?.(predicate);
      if (found) return found;
    }
    return null;
  }

  findAll(predicate, acc = []) {
    for (const child of this.childNodes) {
      if (predicate(child)) acc.push(child);
      child.findAll?.(predicate, acc);
    }
    return acc;
  }

  matches(selector) {
    for (const part of selector.split(',')) {
      const sel = part.trim();
      const tagMatch = sel.match(/^([a-zA-Z0-9]+)/);
      const attrMatches = [...sel.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
      const classMatches = [...sel.matchAll(/\.([a-zA-Z0-9_-]+)/g)];
      if (tagMatch && this.tagName !== tagMatch[1].toUpperCase()) continue;
      let ok = true;
      for (const [, name, value] of attrMatches) {
        if (name === 'data-panel') {
          if (this.dataset.panel !== value) ok = false;
        } else if (this.getAttribute(name) !== (value ?? '')) {
          if (value === undefined && !this.hasAttribute(name)) ok = false;
          else if (value !== undefined) ok = false;
        }
      }
      for (const [, cls] of classMatches) if (!this.classList.contains(cls)) ok = false;
      if (ok) return true;
    }
    return false;
  }

  querySelector(selector) {
    return this.find((n) => n.matches?.(selector)) || null;
  }

  querySelectorAll(selector) {
    return this.findAll((n) => n.matches?.(selector));
  }

  getContext(type) {
    if (type !== '2d') throw new Error(`Only 2d canvas contexts are supported, got "${type}"`);
    return createCanvasContext();
  }

  toDataURL() {
    return 'data:image/png;base64,';
  }
}

class TextNode extends Node {
  constructor(text) {
    super('#text');
    this._text = String(text ?? '');
  }

  get nodeType() {
    return 3;
  }

  get textContent() {
    return this._text;
  }

  matches() {
    return false;
  }
}

const createCanvasContext = () => {
  const calls = [];
  return {
    calls,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingQuality: 'high',
    save() {
      calls.push(['save']);
    },
    restore() {
      calls.push(['restore']);
    },
    fillRect(...args) {
      calls.push(['fillRect', ...args]);
    },
    clearRect(...args) {
      calls.push(['clearRect', ...args]);
    },
    drawImage(...args) {
      calls.push(['drawImage', ...args]);
    },
    putImageData(...args) {
      calls.push(['putImageData', ...args]);
    },
    getImageData(x, y, w, h) {
      calls.push(['getImageData', x, y, w, h]);
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    createImageData(w, h) {
      return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h };
    },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    rect() {},
    clip() {},
    fill() {},
    stroke() {},
    setTransform() {},
    scale() {},
    translate() {},
    set globalCompositeOperation(v) {},
    get globalCompositeOperation() {
      return 'source-over';
    },
  };
};

export const createDocument = () => {
  const doc = {
    readyState: 'complete',
    documentElement: null,
    body: null,
    createElement(tag) {
      return new Node(tag, doc);
    },
    createTextNode(text) {
      return new TextNode(text);
    },
    getElementById(id) {
      return doc.body.find((n) => n.id === id);
    },
    querySelector(selector) {
      return doc.body.querySelector(selector);
    },
    querySelectorAll(selector) {
      return doc.body.querySelectorAll(selector);
    },
    addEventListener() {},
    removeEventListener() {},
    _getContextCalls: [],
  };
  const html = doc.createElement('html');
  doc.documentElement = html;
  doc.body = doc.createElement('body');
  html.appendChild(doc.body);
  return doc;
};

/**
 * Build the document structure the panel bootstrap expects, straight from the
 * shipped index.html (so a missing id in the markup is caught here, not in Photoshop).
 */
export const mountIndexHtml = (doc, html) => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const node = doc.createElement('div');
    node.id = id;
    doc.body.appendChild(node);
  }
  return doc;
};

/** Install the globals the UI modules reference directly. */
export const installGlobals = (doc) => {
  globalThis.document = doc;
  globalThis.window = {
    document: doc,
    location: { search: '' },
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    devicePixelRatio: 1,
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.HTMLCanvasElement = Node;
  globalThis.Image = class {
    constructor() {
      this.src = '';
      this.width = 1;
      this.height = 1;
      this.onload = null;
    }
  };
  return doc;
};
