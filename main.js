/*
 * EinkCursor - Static cursor for e-ink displays.
 * No settings, no animations, useTransform=false.
 */
'use strict';

var p = Object.defineProperty;
var R = Object.getOwnPropertyDescriptor;
var x = Object.getOwnPropertyNames;
var D = Object.prototype.hasOwnProperty;
var F = (t, e, r, n) => {
	if (e && typeof e == "object" || typeof e == "function")
		for (let s of x(e))
			!D.call(t, s) && s !== r && p(t, s, { get: () => e[s], enumerable: !(n = R(e, s)) || n.enumerable });
	return t;
};
var N = t => F(p({}, "__esModule", { value: !0 }), t);
var a = (t, e, r) => e in t ? p(t, e, { enumerable: !0, configurable: !0, writable: !0, value: r }) : t[e] = r;

var J = {};
(function (t, e) { for (var r in e) p(t, r, { get: e[r], enumerable: !0 }); })(J, { default: () => EinkCursorPlugin });
module.exports = N(J);

var obsidian = require("obsidian");
var codemirrorState = require("@codemirror/state");
var codemirrorView = require("@codemirror/view");

// ---------------------------------------------------------------------------
// Method patching utility (monkey-patch with restore)
// ---------------------------------------------------------------------------

function patchObject(obj, methods) {
	let restores = Object.keys(methods).map(key => patchMethod(obj, key, methods[key]));
	return restores.length === 1 ? restores[0] : function () { restores.forEach(r => r()); };
}

function patchMethod(obj, key, patcher) {
	let orig = obj[key];
	let hadOwn = obj.hasOwnProperty(key);
	let origFn = hadOwn ? orig : function () {
		return Object.getPrototypeOf(obj)[key].apply(this, arguments);
	};
	let patched = patcher(origFn);
	if (orig) Object.setPrototypeOf(patched, orig);
	Object.setPrototypeOf(wrapper, patched);
	obj[key] = wrapper;
	return restore;

	function wrapper(...args) {
		if (patched === origFn && obj[key] === wrapper) restore();
		return patched.apply(this, args);
	}
	function restore() {
		if (obj[key] === wrapper) { hadOwn ? obj[key] = orig : delete obj[key]; }
		if (patched !== origFn) { patched = origFn; Object.setPrototypeOf(wrapper, orig || Function); }
	}
}

// ---------------------------------------------------------------------------
// Table cell focus tracking (ViewPlugin)
// ---------------------------------------------------------------------------

var focusAnnotation = codemirrorState.Annotation.define();

var tableTrackingPlugin = codemirrorView.ViewPlugin.define(view => {
	let { editor } = view.state.field(obsidian.editorInfoField);
	let handlers = {};
	let controller = new AbortController();

	if (editor != null && editor.inTableCell && editor.activeCM === view) {
		handlers.update = update => {
			if (update.focusChanged)
				editor.cm.dispatch({ annotations: focusAnnotation.of(view.hasFocus) });
		};
	}

	if ((editor == null ? void 0 : editor.cm) === view) {
		view.dom.addEventListener("pointerdown", makePointerDownHandler(view), {
			capture: true,
			signal: controller.signal
		});
		handlers.destroy = () => controller.abort();
	}

	return handlers;
});

function makePointerDownHandler(view) {
	return function (event) {
		if (event.button !== 0) return;
		if (event.composedPath().some(el => el instanceof HTMLElement && el.hasClass("table-wrapper"))) {
			let { scrollDOM } = view;
			scrollDOM.addClass("cm-hasTablePointed");
			scrollDOM.win.addEventListener("pointerup", () => {
				scrollDOM.removeClass("cm-hasTablePointed");
			}, { once: true });
		}
	};
}

// ---------------------------------------------------------------------------
// Cursor marker (WidgetType-compatible)
// ---------------------------------------------------------------------------

function getScrollOrigin(view) {
	let rect = view.scrollDOM.getBoundingClientRect();
	let left = view.textDirection === codemirrorView.Direction.LTR
		? rect.left
		: rect.right - view.scrollDOM.clientWidth * view.scaleX;
	return {
		top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
		left: left - view.scrollDOM.scrollLeft * view.scaleX
	};
}

var CursorMarker = class {
	constructor(className, left, top, height) {
		a(this, "className");
		a(this, "left");
		a(this, "top");
		a(this, "height");
		a(this, "adjust", el => {
			requestAnimationFrame(() => {
				el.setCssStyles({ left: this.left + "px", top: this.top + "px" });
				el.setCssStyles({ height: this.height + "px" });
			});
		});
		a(this, "requestAdjust", (0, obsidian.debounce)((fn, el) => { fn(el); }, 10, false));
		this.className = className;
		this.left = Math.round(left);
		this.top = Math.round(top);
		this.height = Math.round(height);
	}

	draw() {
		let el = createDiv(this.className);
		this.adjust(el);
		return el;
	}

	update(el, prev) {
		var n;
		if (prev.className !== this.className) return false;
		this.requestAdjust = (n = prev.requestAdjust) != null ? n : this.requestAdjust;
		this.requestAdjust(this.adjust, el);
		return true;
	}

	eq(other) {
		return this.left === other.left &&
			this.top === other.top &&
			this.height === other.height &&
			this.className === other.className;
	}

	static forRange(view, className, range) {
		let coords = view.coordsAtPos(range.head, range.assoc || 1);
		if (!coords) return null;
		let origin = getScrollOrigin(view);
		return new CursorMarker(className, coords.left - origin.left, coords.top - origin.top, coords.bottom - coords.top);
	}

	static forTableCellRange(scrollView, editorView, className, range) {
		let coords = editorView.coordsAtPos(range.head, range.assoc || 1);
		if (!coords) return null;
		let origin = getScrollOrigin(scrollView);
		return new CursorMarker(className, coords.left - origin.left, coords.top - origin.top, coords.bottom - coords.top);
	}
};

// ---------------------------------------------------------------------------
// Cursor layer update & markers
// ---------------------------------------------------------------------------

function getTableActiveCM(state) {
	let editor = state.field(obsidian.editorInfoField).editor;
	let { activeCM } = editor != null ? editor : {};
	if (editor != null && editor.inTableCell) return activeCM;
}

function cursorLayerUpdate(update, dom) {
	var activeCM;
	// Ignore transactions that are only focus annotations (no visual change needed)
	if (!update.docChanged && !update.selectionSet &&
		update.transactions.some(tr => !!tr.annotation(focusAnnotation)))
		return false;
	let tableCM = getTableActiveCM(update.state);
	if (tableCM === update.view) return false;
	let overTable = !update.view.hasFocus &&
		((activeCM = tableCM == null ? void 0 : tableCM.hasFocus) != null ? activeCM : false);
	dom.toggleClass("cm-overTableCell", overTable);
	return (update.docChanged || update.selectionSet) && (update.view.hasFocus || overTable);
}

function cursorLayerMarkers(view) {
	let state = view.state;
	let tableCM;
	let markers = [];

	// If this view lost focus, check if a table cell CM has focus instead
	if (!view.hasFocus) tableCM = getTableActiveCM(state);
	// Use the table cell's selection for cursor rendering
	if (tableCM) ({ state } = tableCM);
	// The table cell view itself doesn't render its own cursor (CSS hides it)
	if (view === tableCM) return markers;

	for (let range of state.selection.ranges) {
		let isPrimary = range === state.selection.main;
		let className = "cm-cursor " + (isPrimary ? "cm-cursor-primary" : "cm-cursor-secondary");
		let marker = tableCM
			? CursorMarker.forTableCellRange(view, tableCM, className, range)
			: CursorMarker.forRange(view, className, range);
		if (marker) markers.push(marker);
	}
	return markers;
}

function patchCursorLayer(layerValue) {
	return patchObject(layerValue.layer, {
		update: () => cursorLayerUpdate,
		markers: () => cursorLayerMarkers
	});
}

// ---------------------------------------------------------------------------
// Find cursor layer plugin in CodeMirror plugins list
// ---------------------------------------------------------------------------

function isValidLayerSpec(spec) {
	return "above" in spec && typeof spec.above === "boolean" &&
		(!("class" in spec) || typeof spec.class === "string") &&
		(!("updateOnDocViewUpdate" in spec) || typeof spec.updateOnDocViewUpdate === "boolean") &&
		"update" in spec && typeof spec.update === "function" &&
		"markers" in spec && typeof spec.markers === "function" &&
		(!("mount" in spec) || typeof spec.mount === "function") &&
		(!("destroy" in spec) || typeof spec.destroy === "function");
}

function isValidMeasureReq(req) {
	return "read" in req && typeof req.read === "function" &&
		(!("write" in req) || typeof req.write === "function");
}

function isCursorLayerPlugin(pluginInstance) {
	let val = pluginInstance.value;
	return !!val &&
		"view" in val && val.view instanceof codemirrorView.EditorView &&
		"layer" in val && !!val.layer && isValidLayerSpec(val.layer) &&
		"measureReq" in val && !!val.measureReq && isValidMeasureReq(val.measureReq) &&
		"drawn" in val && val.drawn instanceof Array &&
		"dom" in val && val.dom instanceof HTMLElement &&
		"scaleX" in val && typeof val.scaleX === "number" &&
		"scaleY" in val && typeof val.scaleY === "number" &&
		"setOrder" in val && typeof val.setOrder === "function" &&
		"measure" in val && typeof val.measure === "function" &&
		"scale" in val && typeof val.scale === "function" &&
		"draw" in val && typeof val.draw === "function" &&
		val.layer.class === "cm-cursorLayer";
}

function findCursorLayerPlugin(editorView) {
	return editorView.plugins.find(p => !!p.value && isCursorLayerPlugin(p));
}

// ---------------------------------------------------------------------------
// Main plugin
// ---------------------------------------------------------------------------

function forEachMarkdownView(app, callback) {
	app.workspace.getLeavesOfType("markdown").forEach(leaf => {
		if (leaf.view instanceof obsidian.MarkdownView) callback(leaf.view);
	});
}

var EinkCursorPlugin = class extends obsidian.Plugin {
	constructor() {
		super(...arguments);
		a(this, "alreadyPatched");
		a(this, "tryPatchRef");
		a(this, "cursorPlugin");
	}

	async onload() {
		var activeEditor;
		this.alreadyPatched = false;
		this.registerEditorExtension(tableTrackingPlugin);
		let editor = (activeEditor = this.app.workspace.activeEditor) == null
			? void 0
			: activeEditor.editor;
		editor
			? this.tryPatch(editor)
			: this.tryPatchRef = this.app.workspace.on("editor-selection-change", this.tryPatch.bind(this));
		console.log("Load EinkCursor plugin");
	}

	onunload() {
		this.cancelPatchAttempt();
		forEachMarkdownView(this.app, view => {
			var cursorPlugin;
			if (!((cursorPlugin = this.cursorPlugin) != null && cursorPlugin.spec)) return;
			let instance = view.editor.cm.plugin(this.cursorPlugin.spec);
			if (instance != null) instance.dom.removeClass("cm-blinkLayer");
		});
		console.log("Unload EinkCursor plugin");
	}

	tryPatch(editor) {
		if (this.alreadyPatched) { this.cancelPatchAttempt(); return; }
		let cm = editor.cm;
		let cursorPlugin = findCursorLayerPlugin(cm);
		if (cursorPlugin != null && cursorPlugin.value) {
			this.register(patchCursorLayer(cursorPlugin.value));
			this.alreadyPatched = true;
			this.cursorPlugin = cursorPlugin;
			this.cancelPatchAttempt();
		}
	}

	cancelPatchAttempt() {
		if (this.tryPatchRef) {
			this.app.workspace.offref(this.tryPatchRef);
			delete this.tryPatchRef;
		}
	}
};
