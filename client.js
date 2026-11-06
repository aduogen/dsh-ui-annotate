/*!
 * dsh-ui-annotate — client half.
 *
 * Point at a UI element and turn it into a precise change request.
 *
 * Two targets:
 *   - the built-in sidebar browser (Electron <webview>) — injects a picker into the
 *     guest page, so the element is real guest DOM;
 *   - the Harness UI itself — picks against this document, and reads the closest
 *     React component name to name the owner of the element.
 *
 * Two delivery modes: one element straight into the composer, or a numbered batch
 * collected first and submitted as one message.
 *
 * Wiring:
 *   - `conversation.input.overlay` (session) — a zero-size occupant captures the
 *     composer's `inputActions` ({ setDraft, submit, insertText }) per session.
 *   - `shell.overlay` (root) — the frame-wide floating launcher, panel, and batch
 *     pins. That layer is click-through; entries opt back into pointer events.
 *
 * Bundle format: the official client-bundle shape — a lazy-CJS closure registered
 * with window.__ModuleLoader__.load({ id, factory }).
 */
window.__ModuleLoader__.load({
  id: "dsh-ui-annotate",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    "use strict";

    var react = require("react");

    var NS = "uiAnnotate";
    var ACCENT = "#e8892b";
    var MARK = "data-dsh-annotate";

    /* ────────────────────────── locale ────────────────────────── */

    var zh = {
      "panel.title": "批注改 UI",
      "panel.mode": "投递方式",
      "panel.mode.single": "单条直发",
      "panel.mode.batch": "批量清单",
      "panel.mode.single.hint": "点一个元素就写进输入框",
      "panel.mode.batch.hint": "连续点多个，最后一并发送",
      "panel.autoSend": "拾取后立即发送",
      "panel.start": "开始拾取",
      "panel.stop": "结束拾取",
      "panel.send.count": "发送 {n} 条",
      "panel.clear": "清空",
      "panel.close": "关闭",
      "panel.empty": "点「开始拾取」，然后点你想改的那块界面。",
      "hint.picking": "点击要改的元素 · Esc 取消",
      "pin.requirement": "要改成什么（可留空）",
      "pin.remove": "删除这条批注",
      "toast.drafted": "已写进输入框，补一句要求再回车",
      "toast.sent": "已发送",
      "toast.noComposer": "还没打开会话输入框，先随便开一个会话",
      "toast.pickFailed": "没取到元素，重试一次",
      "toast.needsPage": "浏览器标签里还没加载网页：先在地址栏输入网址并点「前往」，再回来拾取",
      "btn.open": "批注改 UI",
      "kind.dsh": "这个界面（DSH 自身）",
      "kind.browser": "内置浏览器页面"
    };

    var en = {
      "panel.title": "Annotate UI",
      "panel.mode": "Delivery",
      "panel.mode.single": "One at a time",
      "panel.mode.batch": "Batch list",
      "panel.mode.single.hint": "A click drops it into the composer",
      "panel.mode.batch.hint": "Collect several, then send together",
      "panel.autoSend": "Send right after picking",
      "panel.start": "Start picking",
      "panel.stop": "Stop picking",
      "panel.send.count": "Send {n}",
      "panel.clear": "Clear",
      "panel.close": "Close",
      "panel.empty": "Press Start picking, then click the part you want changed.",
      "hint.picking": "Click the element to change · Esc to cancel",
      "pin.requirement": "What should it become (optional)",
      "pin.remove": "Remove this annotation",
      "toast.drafted": "Written into the composer — add your request and press Enter",
      "toast.sent": "Sent",
      "toast.noComposer": "Open a session composer first",
      "toast.pickFailed": "No element captured — try again",
      "toast.needsPage": "The browser tab has no page yet — enter an address and press Go, then pick again",
      "btn.open": "Annotate UI",
      "kind.dsh": "This interface (DSH itself)",
      "kind.browser": "Browser pane"
    };

    /* ─────────────────────── composer bridge ─────────────────────── */

    /** SessionId -> composer inputActions ({ setDraft, submit, insertText, ... }). */
    var composers = new Map();
    /** SessionId -> the draft text the composer last published. */
    var drafts = new Map();
    /** Session whose composer rendered most recently. */
    var activeSession = null;
    /** Increments on every pick attempt, so a cancelled attempt's late result is ignored. */
    var pickToken = 0;

    /**
     * Read the composer handle out of the slot props. `inputActions` is a standard
     * session-scoped prop, but the shape is defensive on purpose: a host change must
     * degrade to "no composer" rather than crash the slot entry.
     */
    function readInputActions(props) {
      if (props === null || typeof props !== "object") return null;
      var candidates = [
        props.inputActions,
        props.actions,
        props.input && props.input.actions
      ];
      for (var i = 0; i < candidates.length; i += 1) {
        var candidate = candidates[i];
        if (
          candidate !== null &&
          typeof candidate === "object" &&
          typeof candidate.setDraft === "function"
        ) {
          return candidate;
        }
      }
      return null;
    }

    /** Resolve the composer for a session, falling back to the most recent one. */
    function composerFor(sessionId) {
      if (sessionId !== undefined && composers.has(sessionId)) {
        return composers.get(sessionId);
      }
      if (activeSession !== null && composers.has(activeSession)) {
        return composers.get(activeSession);
      }
      var first = null;
      composers.forEach(function (value) {
        if (first === null) first = value;
      });
      return first;
    }

    /**
     * Write the body into the session's composer without destroying typed words.
     * `captureInsertion()` + `insertText()` is the supported insertion path: it only
     * lands while the captured draft revision is still current. A separator is added
     * when the user already typed something, so the annotation never runs into their
     * sentence. A whole-draft `setDraft()` is the fallback for hosts without insertion.
     */
    function writeDraft(composer, sessionId, body) {
      var existing = sessionId !== undefined && drafts.has(sessionId) ? drafts.get(sessionId) : "";
      var needsGap = typeof existing === "string" && existing.trim() !== "";
      if (
        typeof composer.captureInsertion === "function" &&
        typeof composer.insertText === "function"
      ) {
        try {
          var span = composer.captureInsertion();
          var text = needsGap ? "\n\n" + body : body;
          if (composer.insertText(text, span) === true) return true;
        } catch (_error) {
          /* fall through to setDraft */
        }
      }
      composer.setDraft(needsGap ? existing.replace(/\s+$/u, "") + "\n\n" + body : body);
      return true;
    }

    /* ─────────────────────── element description ─────────────────────── */

    /**
     * The picker. Runs inside the target document — either the guest page of the
     * sidebar browser (serialized through <webview>.executeJavaScript, hence
     * self-contained: no closure references) or this Harness document (called
     * directly). Resolves with the picked element, or { cancelled: true }.
     */
    function pickerMain(opts) {
      return new Promise(function (resolve) {
        var doc = document;
        var win = window;
        var accent = (opts && opts.accent) || "#e8892b";
        var skipSelector = (opts && opts.skipSelector) || "";
        var done = false;

        function isOurNode(node) {
          if (skipSelector === "") return false;
          var el = node && node.nodeType === 1 ? node : node && node.parentElement;
          if (!el || typeof el.closest !== "function") return false;
          try {
            return el.closest(skipSelector) !== null;
          } catch (_error) {
            return false;
          }
        }

        var host = doc.createElement("div");
        host.setAttribute("data-dsh-annotate", "picker");
        host.style.cssText =
          "position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;";
        var box = doc.createElement("div");
        box.style.cssText =
          "position:fixed;pointer-events:none;border:2px solid " +
          accent +
          ";background:rgba(232,137,43,0.13);border-radius:4px;box-sizing:border-box;display:none;";
        var tag = doc.createElement("div");
        tag.style.cssText =
          "position:fixed;pointer-events:none;font:600 11px/1.45 ui-monospace,Menlo,Consolas,monospace;" +
          "color:#fff;background:" +
          accent +
          ";padding:1px 6px;border-radius:4px;white-space:nowrap;display:none;" +
          "box-shadow:0 2px 8px rgba(0,0,0,0.35);";
        host.appendChild(box);
        host.appendChild(tag);
        var parent = doc.body || doc.documentElement;
        parent.appendChild(host);

        var previousCursor = doc.documentElement.style.cursor;
        doc.documentElement.style.cursor = "crosshair";

        /**
         * Cancel channel for the host. The picker resolves only on a pick or Escape,
         * so a control in the host UI could never end it otherwise: this hook lets the
         * host settle the promise without touching the page. Bound per invocation, so
         * a later picker never removes a newer hook.
         */
        var myCancel = function () {
          finish({ cancelled: true });
        };
        win.__dshAnnotateCancel = myCancel;

        function cleanup() {
          done = true;
          doc.removeEventListener("mousemove", onMove, true);
          doc.removeEventListener("mousedown", onDown, true);
          doc.removeEventListener("click", onClick, true);
          doc.removeEventListener("keydown", onKey, true);
          doc.documentElement.style.cursor = previousCursor;
          if (host.parentNode) host.parentNode.removeChild(host);
          if (win.__dshAnnotateCancel === myCancel) {
            try {
              delete win.__dshAnnotateCancel;
            } catch (_error) {
              win.__dshAnnotateCancel = void 0;
            }
          }
        }

        function finish(payload) {
          if (done) return;
          cleanup();
          resolve(payload);
        }

        /** A short, human-facing label for the hovered element. */
        function labelOf(el) {
          var name = el.tagName ? el.tagName.toLowerCase() : "?";
          var id = el.id ? "#" + el.id : "";
          var cls =
            el.classList && el.classList.length
              ? "." + Array.prototype.slice.call(el.classList, 0, 2).join(".")
              : "";
          return name + id + cls;
        }

        /** A CSS selector that resolves back to this element, or as close as we get. */
        function cssPath(el) {
          var parts = [];
          var node = el;
          var guard = 0;
          while (node && node.nodeType === 1 && guard < 8) {
            guard += 1;
            var part = node.tagName.toLowerCase();
            if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
              parts.unshift("#" + node.id);
              break;
            }
            var classes = [];
            var list = node.classList ? node.classList : [];
            for (var i = 0; i < list.length && classes.length < 2; i += 1) {
              if (/^[A-Za-z_][\w-]*$/.test(list[i])) classes.push(list[i]);
            }
            if (classes.length > 0) part += "." + classes.join(".");
            var parentEl = node.parentElement;
            if (parentEl) {
              var same = [];
              for (var j = 0; j < parentEl.children.length; j += 1) {
                if (parentEl.children[j].tagName === node.tagName) same.push(parentEl.children[j]);
              }
              if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
            }
            parts.unshift(part);
            node = parentEl;
          }
          return parts.join(" > ");
        }

        /** Closest owning React component name, if the node is React-rendered. */
        function componentOf(el) {
          var keys = Object.keys(el);
          for (var i = 0; i < keys.length; i += 1) {
            var key = keys[i];
            if (key.indexOf("__reactFiber$") !== 0 && key.indexOf("__reactInternalInstance$") !== 0) {
              continue;
            }
            var fiber = el[key];
            var depth = 0;
            while (fiber && depth < 60) {
              depth += 1;
              var type = fiber.type;
              var name = null;
              if (typeof type === "function") name = type.displayName || type.name;
              else if (type && typeof type === "object") name = type.displayName || type.name || null;
              if (name && typeof name === "string" && /^[A-Za-z]/.test(name)) {
                return { name: name, source: sourceOf(fiber) };
              }
              fiber = fiber.return;
            }
          }
          return { name: null, source: null };
        }

        /** Dev-build source coordinates, when the bundle carries them. */
        function sourceOf(fiber) {
          var source = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
          if (!source) return null;
          var file = source.fileName || null;
          if (!file) return null;
          return { file: file, line: source.lineNumber || null };
        }

        /** Everything worth telling the model about one element. */
        function describe(el) {
          var rect = el.getBoundingClientRect();
          var cs = win.getComputedStyle(el);
          var wanted = [
            "display",
            "position",
            "width",
            "height",
            "margin",
            "padding",
            "border",
            "border-radius",
            "box-shadow",
            "background-color",
            "color",
            "font-family",
            "font-size",
            "font-weight",
            "line-height",
            "text-align",
            "gap",
            "flex-direction",
            "justify-content",
            "align-items"
          ];
          var styles = {};
          for (var i = 0; i < wanted.length; i += 1) {
            var value = cs.getPropertyValue(wanted[i]);
            if (value && value !== "none" && value !== "normal" && value !== "auto" && value !== "0px") {
              styles[wanted[i]] = value;
            }
          }

          var selector = cssPath(el);
          var matches = 0;
          try {
            matches = doc.querySelectorAll(selector).length;
          } catch (_error) {
            matches = 0;
          }

          var component = componentOf(el);

          var attrs = {};
          for (var a = 0; a < el.attributes.length && a < 24; a += 1) {
            var attr = el.attributes[a];
            if (!attr.name || attr.name === "class" || attr.name === "style") continue;
            if (/^on/i.test(attr.name)) continue;
            attrs[attr.name] = String(attr.value).slice(0, 160);
          }

          var text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
          var html = String(el.outerHTML || "").replace(/\s+/g, " ").trim();
          if (html.length > 1200) html = html.slice(0, 1200) + " …";

          var chain = [];
          var up = el.parentElement;
          var hops = 0;
          while (up && hops < 5) {
            chain.push(labelOf(up));
            up = up.parentElement;
            hops += 1;
          }

          return {
            tag: el.tagName ? el.tagName.toLowerCase() : "?",
            selector: selector,
            selectorMatches: matches,
            rect: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            },
            page: {
              width: win.innerWidth,
              height: win.innerHeight,
              scrollX: Math.round(win.scrollX),
              scrollY: Math.round(win.scrollY)
            },
            text: text,
            styles: styles,
            attributes: attrs,
            component: component.name,
            componentSource: component.source,
            ancestors: chain,
            html: html,
            url: String(win.location ? win.location.href : ""),
            title: String(doc.title || "")
          };
        }

        function paint(el) {
          var rect = el.getBoundingClientRect();
          box.style.display = "block";
          box.style.left = rect.left + "px";
          box.style.top = rect.top + "px";
          box.style.width = rect.width + "px";
          box.style.height = rect.height + "px";
          tag.style.display = "block";
          tag.textContent = labelOf(el);
          var top = rect.top - 20;
          if (top < 2) top = Math.min(rect.bottom + 4, win.innerHeight - 20);
          tag.style.left = Math.max(2, rect.left) + "px";
          tag.style.top = Math.max(2, top) + "px";
        }

        function targetOf(event) {
          var el = event.target;
          if (!el || el.nodeType !== 1) return null;
          if (isOurNode(el)) return null;
          return el;
        }

        function onMove(event) {
          if (done) return;
          var el = targetOf(event);
          if (el === null) {
            box.style.display = "none";
            tag.style.display = "none";
            return;
          }
          paint(el);
        }

        /**
         * Swallow a press so the page underneath cannot react to picking, but never
         * swallow one aimed at our own host controls: the panel's Stop button lives in
         * this document when picking the Harness UI, and it must stay clickable.
         */
        function onDown(event) {
          if (done) return;
          if (isOurNode(event.target)) return;
          event.preventDefault();
          event.stopPropagation();
        }

        function onClick(event) {
          if (done) return;
          var el = targetOf(event);
          if (el === null) return;
          event.preventDefault();
          event.stopPropagation();
          finish({ ok: true, element: describe(el) });
        }

        function onKey(event) {
          if (done) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            finish({ cancelled: true });
          }
        }

        doc.addEventListener("mousemove", onMove, true);
        doc.addEventListener("mousedown", onDown, true);
        doc.addEventListener("click", onClick, true);
        doc.addEventListener("keydown", onKey, true);
      });
    }

    /* ─────────────────────── message composition ─────────────────────── */

    /** "rgb(1, 2, 3)" as a hex value the model can reason about. */
    function toHex(color) {
      if (typeof color !== "string") return color;
      var match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color.trim());
      if (!match) return color;
      function part(value) {
        var n = Math.max(0, Math.min(255, Math.round(Number(value))));
        return (n < 16 ? "0" : "") + n.toString(16);
      }
      return "#" + part(match[1]) + part(match[2]) + part(match[3]);
    }

    /** One annotated element as an indented block. */
    function describeBlock(pin, t) {
      var element = pin.element;
      var lines = [];
      var where =
        (pin.kind === "browser" ? t("kind.browser") : t("kind.dsh")) +
        (element.url ? " · " + element.url : "");
      lines.push("- 目标：" + where);
      lines.push("- 选择器：" + element.selector);
      if (element.selectorMatches > 1) {
        lines.push("- 注意：这个选择器在页面上匹配 " + element.selectorMatches + " 个元素");
      }
      lines.push(
        "- 位置：" +
          element.rect.width +
          "×" +
          element.rect.height +
          " @ (" +
          element.rect.x +
          ", " +
          element.rect.y +
          ")"
      );
      if (element.component) {
        var source =
          element.componentSource && element.componentSource.file
            ? "（源码 " +
              element.componentSource.file +
              (element.componentSource.line ? ":" + element.componentSource.line : "") +
              "）"
            : "";
        lines.push("- 所属组件：" + element.component + source);
      }
      var stylePairs = [];
      for (var key in element.styles) {
        if (!Object.prototype.hasOwnProperty.call(element.styles, key)) continue;
        var value = element.styles[key];
        if (key === "color" || key === "background-color") value = toHex(value);
        stylePairs.push(key + ": " + value);
      }
      if (stylePairs.length > 0) lines.push("- 计算样式：" + stylePairs.join("; "));
      if (element.text) lines.push("- 文本：「" + element.text + "」");
      var attrPairs = [];
      for (var attr in element.attributes) {
        if (!Object.prototype.hasOwnProperty.call(element.attributes, attr)) continue;
        attrPairs.push(attr + '="' + element.attributes[attr] + '"');
      }
      if (attrPairs.length > 0) lines.push("- 属性：" + attrPairs.join(" "));
      if (element.ancestors.length > 0) lines.push("- 祖先：" + element.ancestors.join(" < "));
      lines.push("- HTML：" + element.html);
      if (pin.requirement && pin.requirement.trim() !== "") {
        lines.push("- 要求：" + pin.requirement.trim());
      }
      return lines.join("\n");
    }

    /** A single pinned element as one message body. */
    function singleMessage(pin, t) {
      var hasRequirement = pin.requirement !== undefined && pin.requirement.trim() !== "";
      return (
        "我要改这个 UI 元素，请按选择器定位到它再改。\n\n" +
        describeBlock(pin, t) +
        (hasRequirement ? "" : "\n\n要求：")
      );
    }

    /** Several pins as one numbered change request. */
    function batchMessage(pins, t) {
      var blocks = [];
      for (var i = 0; i < pins.length; i += 1) {
        blocks.push("### " + (i + 1) + "\n" + describeBlock(pins[i], t));
      }
      return (
        "我要改下面 " +
        pins.length +
        " 处 UI，请按选择器逐个定位再改，一次改完。\n\n" +
        blocks.join("\n\n")
      );
    }

    /* ─────────────────────── target resolution ─────────────────────── */

    /** The mounted desktop browser guest, if one is live. */
    function liveWebview() {
      var view = document.querySelector('webview[data-sidebar-browser-frame="webview"]');
      if (view !== null && view !== undefined) return view;
      return null;
    }

    /**
     * Arm the picker inside a browser guest document.
     *
     * Guest clicks never reach this document — an Electron <webview> is its own
     * frame — so a single host-side picker could only ever select the guest's
     * container. Arming both at once is what makes "click anywhere" true.
     */
    function armGuestPicker(view) {
      var source =
        "(" + pickerMain.toString() + ")(" + JSON.stringify({ accent: ACCENT, skipSelector: "" }) + ")";
      return view.executeJavaScript(source, true);
    }

    /**
     * Resolve with the first outcome that actually happened.
     *
     * Either side may fail (a guest mid-navigation rejects, a host teardown throws);
     * a failure must not win the race against a healthy picker, so failures map to
     * null and are simply not taken.
     */
    function firstSettled(primary, secondary) {
      return new Promise(function (resolve) {
        var settled = false;
        function take(value) {
          if (settled || value === null || value === undefined) return;
          settled = true;
          resolve(value);
        }
        primary.then(take, function () {});
        if (secondary !== null) secondary.then(take, function () {});
      });
    }

    /**
     * Settle whatever picker is currently armed, in either carrier.
     *
     * The Harness-document picker is cancelled through the hook it published on this
     * window. A browser guest is a separate document, so it exposes the same hookname
     * inside its own window and we reach it over the guest's executeJavaScript.
     */
    function cancelActivePicker() {
      try {
        if (typeof globalThis.__dshAnnotateCancel === "function") {
          globalThis.__dshAnnotateCancel();
        }
      } catch (_error) {
        /* the picker may already be gone */
      }
      var view = liveWebview();
      if (view !== null && typeof view.executeJavaScript === "function") {
        view
          .executeJavaScript(
            "(() => { try { if (typeof window.__dshAnnotateCancel === 'function') { window.__dshAnnotateCancel(); } } catch (e) {} return true; })()",
            true
          )
          .catch(function () {
            /* the guest may be mid-navigation */
          });
      }
    }

    /**
     * Run the picker against the sidebar browser's guest page.
     * The guest viewport offset is folded in so batch pins land where the user sees them.
     */
    async function pickInBrowser(t) {
      var view = liveWebview();
      if (view === null) return { needsPage: true };
      var offset = view.getBoundingClientRect();
      var result;
      try {
        result = await armGuestPicker(view);
      } catch (error) {
        /* A guest mid-navigation rejects; the host picker still covers the frame. */
        return { failed: null };
      }
      if (result === undefined || result === null) return { failed: null };
      if (result.cancelled) return { cancelled: true };
      if (!result.ok || !result.element) return { failed: null };
      var element = result.element;
      /* Guest coordinates are viewport-relative; the host draws pins fixed-positioned. */
      element.anchor = {
        x: offset.left + element.rect.x,
        y: offset.top + element.rect.y,
        width: element.rect.width,
        height: element.rect.height
      };
      element.kind = "browser";
      return { element: element };
    }

    /**
     * Arm the picker once, over the whole window.
     *
     * Two pickers run concurrently: one inside the browser guest (if any) and one in
     * this document. Which one the user is aiming at is decided by where the click
     * lands, not by a switch they have to get right first. When no guest exists this
     * degrades to the single host picker, which is exactly the plain-web case.
     */
    async function pickAnywhere(t) {
      var view = liveWebview();
      var host = pickInHarness(t);
      var guest = view === null ? null : pickInBrowser(t);

      var outcome = await firstSettled(host, guest);
      if (outcome === null) return { failed: t("toast.pickFailed") };
      if (outcome.cancelled) {
        /* A pick in either carrier ends the session for both. */
        cancelActivePicker();
        return { cancelled: true };
      }
      if (outcome.needsPage) return { needsPage: true };
      if (outcome.failed) return { failed: t("toast.pickFailed") };
      return { element: outcome.element };
    }

    /** Run the picker against the Harness document itself. */
    async function pickInHarness(t) {
      var result;
      try {
        result = await pickerMain({ accent: ACCENT, skipSelector: "[" + MARK + "]" });
      } catch (error) {
        return { failed: t("toast.pickFailed") };
      }
      if (result === null || result === undefined) return { failed: t("toast.pickFailed") };
      if (result.cancelled) return { cancelled: true };
      if (!result.ok || !result.element) return { failed: t("toast.pickFailed") };
      var element = result.element;
      element.anchor = {
        x: element.rect.x,
        y: element.rect.y,
        width: element.rect.width,
        height: element.rect.height
      };
      element.kind = "dsh";
      return { element: element };
    }

    /* ─────────────────────── panel state ─────────────────────── */

    var panelState = {
      open: false,
      mode: "single",
      autoSend: false,
      picking: false,
      pins: [],
      notice: null
    };
    var listeners = new Set();

    function setPanel(patch) {
      panelState = Object.assign({}, panelState, patch);
      listeners.forEach(function (notify) {
        notify();
      });
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
      };
    }

    var pinSeq = 0;

    /* ─────────────────────── components ─────────────────────── */

    /** Invisible occupant: remembers each session's composer handle and published draft. */
    function ComposerCapture(props) {
      var actions = readInputActions(props);
      var sessionId = props.sessionId;
      var useInput = props.useInput;
      /* Hooks are called unconditionally: a conditional hook would break the slot. */
      var draft =
        typeof useInput === "function"
          ? useInput(function (state) {
              return state === null || state === undefined ? "" : state.draft || "";
            })
          : "";
      if (sessionId !== undefined) {
        drafts.set(sessionId, typeof draft === "string" ? draft : "");
      }
      if (actions === null) return null;
      if (sessionId !== undefined) composers.set(sessionId, actions);
      activeSession = sessionId === undefined ? activeSession : sessionId;
      return null;
    }
    ComposerCapture.displayName = "UiAnnotateComposerCapture";

    function styles() {
      return (
        ".ua-root{position:fixed;right:18px;bottom:76px;z-index:64;pointer-events:auto;" +
        "display:flex;flex-direction:column;align-items:flex-end;gap:10px;}" +
        ".ua-fab{display:flex;align-items:center;gap:7px;height:34px;padding:0 12px;" +
        "border-radius:17px;border:1px solid var(--dsw-alias-border-l2);" +
        "background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);" +
        "font:500 12px/1 system-ui,sans-serif;cursor:pointer;" +
        "box-shadow:0 4px 14px rgba(0,0,0,.28);transition:transform .12s ease;}" +
        ".ua-fab:hover{transform:translateY(-1px);}" +
        ".ua-fab[data-active=true]{border-color:" + ACCENT + ";color:" + ACCENT + ";}" +
        ".ua-panel{width:308px;max-height:70vh;overflow:auto;box-sizing:border-box;" +
        "border-radius:12px;border:1px solid var(--dsw-alias-border-l2);" +
        "background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);" +
        "box-shadow:0 10px 34px rgba(0,0,0,.4);padding:12px;font:400 12px/1.5 system-ui,sans-serif;}" +
        ".ua-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}" +
        ".ua-title{font-weight:600;font-size:13px;}" +
        ".ua-x{border:0;background:transparent;color:var(--dsw-alias-label-secondary);" +
        "cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:4px;}" +
        ".ua-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}" +
        ".ua-label{color:var(--dsw-alias-label-secondary);font-size:11px;margin:10px 0 5px;}" +
        ".ua-seg{display:flex;gap:6px;}" +
        ".ua-seg button{flex:1;padding:6px 4px;border-radius:8px;cursor:pointer;" +
        "font:500 11px/1.3 system-ui,sans-serif;border:1px solid var(--dsw-alias-border-l1);" +
        "background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);}" +
        ".ua-seg button[data-on=true]{border-color:" + ACCENT + ";color:" + ACCENT + ";}" +
        ".ua-seg button:disabled{opacity:.4;cursor:default;}" +
        ".ua-hint{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:4px;}" +
        ".ua-row{display:flex;align-items:center;gap:8px;margin-top:10px;}" +
        ".ua-check{display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;" +
        "color:var(--dsw-alias-label-secondary);}" +
        ".ua-primary{margin-top:12px;width:100%;height:32px;border-radius:8px;cursor:pointer;" +
        "border:1px solid " + ACCENT + ";background:" + ACCENT + ";color:#fff;" +
        "font:600 12px/1 system-ui,sans-serif;}" +
        ".ua-primary:disabled{opacity:.45;cursor:default;}" +
        ".ua-primary[data-stop=true]{background:transparent;color:" + ACCENT + ";}" +
        ".ua-pins{margin-top:12px;display:flex;flex-direction:column;gap:8px;}" +
        ".ua-pin{display:flex;gap:7px;align-items:flex-start;padding:8px;border-radius:8px;" +
        "border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}" +
        ".ua-pin-no{flex:0 0 18px;height:18px;border-radius:9px;background:" + ACCENT + ";" +
        "color:#fff;font:600 10px/18px system-ui,sans-serif;text-align:center;}" +
        ".ua-pin-body{flex:1;min-width:0;}" +
        ".ua-pin-sel{font:500 11px/1.4 ui-monospace,Menlo,Consolas,monospace;" +
        "word-break:break-all;color:var(--dsw-alias-label-primary);}" +
        ".ua-pin input{width:100%;box-sizing:border-box;margin-top:5px;padding:4px 6px;" +
        "border-radius:6px;border:1px solid var(--dsw-alias-border-l1);" +
        "background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);" +
        "font:400 11px/1.4 system-ui,sans-serif;}" +
        ".ua-pin-del{border:0;background:transparent;color:var(--dsw-alias-label-secondary);" +
        "cursor:pointer;font-size:14px;line-height:1;padding:0 2px;}" +
        ".ua-pin-del:hover{color:var(--dsw-alias-state-error-primary);}" +
        ".ua-empty{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11px;}" +
        ".ua-banner{position:fixed;left:50%;transform:translateX(-50%);top:14px;z-index:66;" +
        "pointer-events:none;padding:7px 16px;border-radius:9px;background:" + ACCENT + ";" +
        "color:#fff;font:600 12px/1.4 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.34);}" +
        ".ua-pinmark{position:fixed;z-index:63;pointer-events:none;border:2px solid " + ACCENT + ";" +
        "border-radius:4px;box-sizing:border-box;background:rgba(232,137,43,.10);}" +
        ".ua-pinmark span{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:9px;" +
        "background:" + ACCENT + ";color:#fff;font:600 10px/18px system-ui,sans-serif;text-align:center;}"
      );
    }

    /** Floating launcher, panel, batch pins and the picking banner. */
    function Overlay(props) {
      var t = props.t;
      var state = react.useState(panelState);
      react.useEffect(function () {
        var unsubscribe = subscribe(function () {
          state[1](Object.assign({}, panelState));
        });
        return function () {
          unsubscribe();
          /* Never leave an armed picker behind when this surface unmounts. */
          cancelActivePicker();
        };
      }, []);
      var current = state[0];

      function pick() {
        return pickAnywhere(t);
      }

      /**
       * End the current pick for real: settle the picker's promise so its overlay,
       * cursor and capture listeners are torn down, then clear the panel state.
       */
      function stopPicking() {
        pickToken += 1;
        setPanel({ picking: false });
        cancelActivePicker();
      }

      async function beginPicking() {
        var mine = ++pickToken;
        setPanel({ picking: true, notice: null });
        var result = await pick();
        if (mine !== pickToken) return;
        setPanel({ picking: false });
        if (result.cancelled) return;
        if (result.needsPage) {
          setPanel({ notice: t("toast.needsPage") });
          return;
        }
        if (result.failed) {
          setPanel({ notice: result.failed });
          return;
        }
        accept(result.element);
      }

      function accept(element) {
        var pin = {
          id: ++pinSeq,
          kind: element.kind === "browser" ? "browser" : "dsh",
          element: element,
          requirement: ""
        };
        if (panelState.mode === "batch") {
          setPanel({ pins: panelState.pins.concat([pin]) });
          return;
        }
        deliver([pin], true);
      }

      function deliver(pins, closeAfter) {
        var sessionId = activeSession === null ? undefined : activeSession;
        var composer = composerFor(sessionId);
        if (composer === null) {
          setPanel({ notice: t("toast.noComposer") });
          return;
        }
        var body = pins.length === 1 ? singleMessage(pins[0], t) : batchMessage(pins, t);
        writeDraft(composer, sessionId, body);
        var send = panelState.autoSend || pins.length > 1;
        if (closeAfter) setPanel({ pins: [], open: send ? false : panelState.open });
        else setPanel({ pins: [] });
        if (send) {
          /* setDraft commits through the editor; submit reads the published draft. */
          setTimeout(function () {
            var live = composerFor(sessionId);
            if (live === null) return;
            live.submit();
            setPanel({ notice: t("toast.sent") });
          }, 90);
        } else {
          setPanel({ notice: t("toast.drafted") });
        }
      }

      function setRequirement(id, value) {
        setPanel({
          pins: panelState.pins.map(function (pin) {
            return pin.id === id ? Object.assign({}, pin, { requirement: value }) : pin;
          })
        });
      }

      function removePin(id) {
        setPanel({
          pins: panelState.pins.filter(function (pin) {
            return pin.id !== id;
          })
        });
      }

      var panel = null;
      if (current.open) {
        var pinRows = current.pins.map(function (pin, index) {
          return react.createElement(
            "div",
            { className: "ua-pin", key: pin.id },
            react.createElement("div", { className: "ua-pin-no" }, String(index + 1)),
            react.createElement(
              "div",
              { className: "ua-pin-body" },
              react.createElement("div", { className: "ua-pin-sel" }, pin.element.selector),
              react.createElement("input", {
                value: pin.requirement,
                placeholder: t("pin.requirement"),
                onChange: function (event) {
                  setRequirement(pin.id, event.target.value);
                }
              })
            ),
            react.createElement(
              "button",
              {
                className: "ua-pin-del",
                title: t("pin.remove"),
                onClick: function () {
                  removePin(pin.id);
                }
              },
              "×"
            )
          );
        });

        panel = react.createElement(
          "div",
          { className: "ua-panel", "data-dsh-annotate": "panel" },
          react.createElement(
            "div",
            { className: "ua-head" },
            react.createElement("div", { className: "ua-title" }, t("panel.title")),
            react.createElement(
              "button",
              {
                className: "ua-x",
                title: t("panel.close"),
                onClick: function () {
                  cancelActivePicker();
                  setPanel({ open: false, picking: false, pins: [], notice: null });
                }
              },
              "×"
            )
          ),
          react.createElement("div", { className: "ua-label" }, t("panel.mode")),
          react.createElement(
            "div",
            { className: "ua-seg" },
            react.createElement(
              "button",
              {
                "data-on": current.mode === "single",
                onClick: function () {
                  setPanel({ mode: "single" });
                }
              },
              t("panel.mode.single")
            ),
            react.createElement(
              "button",
              {
                "data-on": current.mode === "batch",
                onClick: function () {
                  setPanel({ mode: "batch" });
                }
              },
              t("panel.mode.batch")
            )
          ),
          react.createElement(
            "div",
            { className: "ua-hint" },
            current.mode === "single" ? t("panel.mode.single.hint") : t("panel.mode.batch.hint")
          ),
          current.mode === "single"
            ? react.createElement(
                "label",
                { className: "ua-check ua-row" },
                react.createElement("input", {
                  type: "checkbox",
                  checked: current.autoSend,
                  onChange: function (event) {
                    setPanel({ autoSend: event.target.checked });
                  }
                }),
                t("panel.autoSend")
              )
            : null,
          react.createElement(
            "button",
            {
              className: "ua-primary",
              "data-stop": current.picking,
              onClick: function () {
                if (current.picking) stopPicking();
                else void beginPicking();
              }
            },
            current.picking ? t("panel.stop") : t("panel.start")
          ),
          current.mode === "batch"
            ? react.createElement(
                "div",
                { className: "ua-pins" },
                current.pins.length === 0
                  ? react.createElement("div", { className: "ua-empty" }, t("panel.empty"))
                  : pinRows,
                current.pins.length > 0
                  ? react.createElement(
                      "div",
                      { className: "ua-row" },
                      react.createElement(
                        "button",
                        {
                          className: "ua-primary",
                          style: { marginTop: "0" },
                          onClick: function () {
                            deliver(current.pins.slice(), true);
                          }
                        },
                        t("panel.send.count").replace("{n}", String(current.pins.length))
                      ),
                      react.createElement(
                        "button",
                        {
                          className: "ua-x",
                          title: t("panel.clear"),
                          onClick: function () {
                            setPanel({ pins: [] });
                          }
                        },
                        t("panel.clear")
                      )
                    )
                  : null
              )
            : null,
          current.notice
            ? react.createElement(
                "div",
                { className: "ua-hint", style: { marginTop: "8px" } },
                current.notice
              )
            : null
        );
      }

      var pinMarks = current.pins.map(function (pin, index) {
        var anchor = pin.element.anchor || { x: 0, y: 0, width: 0, height: 0 };
        return react.createElement(
          "div",
          {
            className: "ua-pinmark",
            key: "mark-" + pin.id,
            style: {
              left: anchor.x + "px",
              top: anchor.y + "px",
              width: anchor.width + "px",
              height: anchor.height + "px"
            }
          },
          react.createElement("span", null, String(index + 1))
        );
      });

      var banner = current.picking
        ? react.createElement(
            "div",
            { className: "ua-banner", "data-dsh-annotate": "banner" },
            t("hint.picking")
          )
        : null;

      return react.createElement(
        react.Fragment,
        null,
        react.createElement("style", null, styles()),
        react.createElement(
          "div",
          { className: "ua-root", "data-dsh-annotate": "root" },
          panel,
          react.createElement(
            "button",
            {
              className: "ua-fab",
              "data-active": current.open || current.picking ? "true" : "false",
              title: t("btn.open"),
              onClick: function () {
                if (current.picking) {
                  /* Collapsing the panel must not strand an armed picker: no visible
                     Stop button would remain to end it. */
                  stopPicking();
                  setPanel({ open: true });
                  return;
                }
                setPanel({ open: !current.open });
              }
            },
            "⌖ ",
            t("btn.open")
          )
        ),
        banner,
        pinMarks
      );
    }
    Overlay.displayName = "UiAnnotateOverlay";

    /* ─────────────────────── plugin body ─────────────────────── */

    var inject = ["slots", "locale"];

    function apply(ctx) {
      var t = ctx.locale.bind(NS);

      ctx.effect(
        function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        },
        "ui-annotate.copy"
      );

      /* Composer capture: session-scoped, one zero-size occupant per session. */
      ctx.effect(
        function () {
          return ctx.slots.inject("conversation.input.overlay", function () {
            return ctx.slots.register(
              {
                name: "conversation.input.overlay",
                id: "ui-annotate.capture",
                order: 901
              },
              ComposerCapture
            );
          });
        },
        "ui-annotate.composer"
      );

      /* The frame-wide launcher, panel and pins. */
      ctx.effect(
        function () {
          return ctx.slots.inject("shell.overlay", function () {
            return ctx.slots.register(
              {
                name: "shell.overlay",
                id: "ui-annotate",
                order: 30
              },
              function OverlayEntry() {
                return react.createElement(Overlay, { t: t });
              }
            );
          });
        },
        "ui-annotate.overlay"
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__internals = {
      pickerMain: pickerMain,
      singleMessage: singleMessage,
      batchMessage: batchMessage,
      toHex: toHex
    };
    return module.exports;
  }
});