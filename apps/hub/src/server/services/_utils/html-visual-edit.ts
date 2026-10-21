import { type DefaultTreeAdapterMap, parse } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type TextNode = DefaultTreeAdapterMap["textNode"];

/** Files above this many bytes are served unannotated, with a script that tells the page's parent. */
export const MAX_ANNOTATED_BYTES = 2 * 1024 * 1024;

/** Query parameter of the preview route that turns on edit mode, holding the page's nonce. */
export const VISUAL_EDIT_PARAM = "band-edit";

const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidVisualEditNonce(nonce: string | null): nonce is string {
  return nonce !== null && NONCE_PATTERN.test(nonce);
}

/**
 * Tags whose text is not page copy: raw text, form values and the document
 * head. `pre` and `listing` are skipped too, because the parser drops a
 * newline right after their start tag and the DOM text then differs from the
 * source slice.
 */
const SKIPPED_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "textarea",
  "title",
  "template",
  "pre",
  "listing",
  "option",
  "iframe",
  "xmp",
  "plaintext",
]);

interface Insertion {
  at: number;
  text: string;
}

function isWhitespaceOnly(value: string): boolean {
  return value.trim() === "";
}

/** The text node an element can be edited through: its only text child, with no element children. */
function editableTextNode(element: Element): TextNode | null {
  let found: TextNode | null = null;
  for (const child of element.childNodes) {
    if (child.nodeName === "#text") {
      const text = child as TextNode;
      if (isWhitespaceOnly(text.value)) continue;
      if (found) return null;
      found = text;
    } else {
      return null;
    }
  }
  return found;
}

function collect(node: Node, source: string, insertions: Insertion[]): void {
  if (!("childNodes" in node)) return;
  const element = node as Element;
  const isHtmlElement = element.namespaceURI === "http://www.w3.org/1999/xhtml";
  if (element.tagName && (!isHtmlElement || SKIPPED_TAGS.has(element.tagName))) return;
  if (element.tagName) {
    const text = editableTextNode(element);
    const startTag = element.sourceCodeLocation?.startTag;
    const range = text?.sourceCodeLocation;
    if (text && startTag && range) {
      const name = /^<([^\s/>]+)/.exec(source.slice(startTag.startOffset, startTag.endOffset));
      if (name) {
        insertions.push({
          at: startTag.startOffset + 1 + name[1].length,
          text: ` data-band-src="${range.startOffset}:${range.endOffset}"`,
        });
      }
    }
  }
  for (const child of element.childNodes) collect(child, source, insertions);
}

/**
 * The page script. It runs inside the sandboxed preview frame (opaque origin),
 * talks to the parent with postMessage only, and checks that each message
 * comes from `window.parent`.
 */
function pageScript(nonce: string, disabled: boolean): string {
  return `(function(){
var NONCE=${JSON.stringify(nonce)};
var DISABLED=${disabled ? "true" : "false"};
function post(m){m.nonce=NONCE;window.parent.postMessage(m,"*");}
if(DISABLED){post({type:"band-visual-edit:unavailable"});return;}
var enabled=false,editing=null,original="",label=null,hovered=null,scrollPending=true;
var style=document.createElement("style");
style.textContent="[data-band-edit-hover]{outline:2px dashed Highlight!important;outline-offset:2px;cursor:text!important}[data-band-edit-hover=no]{outline-color:GrayText!important;cursor:not-allowed!important}[data-band-editing]{outline:2px solid Highlight!important;outline-offset:2px}[data-band-comment-target]{outline:2px solid Highlight!important;outline-offset:2px}#band-edit-label{position:fixed;z-index:2147483647;pointer-events:none;font:12px system-ui,sans-serif;padding:2px 6px;border-radius:4px;background:Canvas;color:CanvasText;border:1px solid GrayText}";
document.head.appendChild(style);
var commentEl=null;
function clip(t,n){t=String(t||"");return t.length>n?t.slice(0,n)+"...":t;}
function shortSel(el){
 var parts=[];
 for(var n=el,i=0;n&&n.nodeType===1&&n!==document.documentElement&&i<5;n=n.parentElement,i++){
  var p=n.tagName.toLowerCase();
  if(n.id){parts.unshift(p+"#"+n.id);break;}
  if(typeof n.className==="string"&&n.className.trim())p+="."+n.className.trim().split(/\\s+/)[0];
  parts.unshift(p);
 }
 return parts.join(" > ");
}
function clearComment(){if(commentEl){commentEl.removeAttribute("data-band-comment-target");commentEl=null;}}
function reportTarget(el,rect,selected){
 clearComment();
 if(!selected){commentEl=el;el.setAttribute("data-band-comment-target","");}
 var src=el;while(src&&src.nodeType===1&&!src.hasAttribute("data-band-src"))src=src.parentElement;
 var attrs=el.cloneNode(false).outerHTML;
 post({type:"band-visual-edit:target",
  rect:{x:rect.left,y:rect.top,w:rect.width,h:rect.height},
  context:{selectedText:clip(selected,500),tag:el.tagName.toLowerCase(),selector:shortSel(el),opening:clip(attrs,300),text:clip(el.textContent.replace(/\\s+/g," ").trim(),300),html:clip(el.outerHTML,800),src:src&&src.nodeType===1?src.getAttribute("data-band-src"):null}});
}
function selectedNow(){var s=window.getSelection();return s&&!s.isCollapsed&&s.toString().trim()!==""?s:null;}
function ownText(el){for(var n=el.firstChild;n;n=n.nextSibling){if(n.nodeType===3&&n.nodeValue.trim()!=="")return true;}return false;}
function target(e){var t=e.target;while(t&&t.nodeType!==1)t=t.parentNode;return t;}
function clearHover(){if(hovered){hovered.removeAttribute("data-band-edit-hover");hovered=null;}if(label){label.remove();label=null;}}
function showHover(el,x,y){
 var ok=el.hasAttribute("data-band-src");
 if(!ok&&!ownText(el)){clearHover();return;}
 if(hovered!==el){clearHover();hovered=el;el.setAttribute("data-band-edit-hover",ok?"yes":"no");}
 if(!ok){
  if(!label){label=document.createElement("div");label.id="band-edit-label";label.textContent="Not editable: this text comes from a script";document.body.appendChild(label);}
  label.style.left=Math.min(x+12,window.innerWidth-260)+"px";label.style.top=(y+16)+"px";
 }else if(label){label.remove();label=null;}
}
function endEdit(){
 if(!editing)return;
 var el=editing;editing=null;
 el.removeAttribute("contenteditable");el.removeAttribute("data-band-editing");
}
function commit(){
 if(!editing)return;
 var el=editing,newText=el.textContent;
 endEdit();
 if(newText===original){post({type:"band-visual-edit:editing",active:false});return;}
 var r=el.getAttribute("data-band-src").split(":");
 post({type:"band-visual-edit:commit",start:Number(r[0]),end:Number(r[1]),oldText:original,newText:newText});
}
function cancel(){
 if(!editing)return;
 var el=editing;
 endEdit();
 el.textContent=original;
 post({type:"band-visual-edit:editing",active:false});
}
function startEdit(el){
 original=el.textContent;
 editing=el;
 el.setAttribute("contenteditable","plaintext-only");
 if(el.contentEditable!=="plaintext-only")el.setAttribute("contenteditable","true");
 el.setAttribute("data-band-editing","");
 post({type:"band-visual-edit:editing",active:true});
 clearHover();
 el.focus();
}
document.addEventListener("mousemove",function(e){
 if(!enabled||editing)return;
 var el=target(e);if(el)showHover(el,e.clientX,e.clientY);
},true);
document.addEventListener("mouseleave",clearHover,true);
document.addEventListener("mouseup",function(e){
 if(editing)return;
 var s=selectedNow();
 if(!s)return;
 var r=s.getRangeAt(0),n=r.commonAncestorContainer;
 while(n&&n.nodeType!==1)n=n.parentNode;
 if(n&&!(n.closest&&n.closest("#band-edit-label")))reportTarget(n,r.getBoundingClientRect(),s.toString());
},true);
document.addEventListener("click",function(e){
 if(e.altKey&&!editing){
  var t=target(e);
  if(t){e.preventDefault();e.stopPropagation();reportTarget(t,t.getBoundingClientRect(),"");}
  return;
 }
 if(!enabled)return;
 if(!editing&&selectedNow())return;
 var el=target(e);
 if(editing&&el&&editing.contains(el))return;
 e.preventDefault();e.stopPropagation();
 if(editing)commit();
 if(el&&el.hasAttribute("data-band-src")){startEdit(el);
  var sel=window.getSelection();
  if(sel&&document.caretRangeFromPoint){var rg=document.caretRangeFromPoint(e.clientX,e.clientY);if(rg&&el.contains(rg.startContainer)){sel.removeAllRanges();sel.addRange(rg);}}
 }
},true);
document.addEventListener("keydown",function(e){
 if(!editing)return;
 if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();commit();}
 else if(e.key==="Escape"){e.preventDefault();cancel();}
},true);
document.addEventListener("focusout",function(e){if(editing&&e.target===editing)commit();},true);
document.addEventListener("paste",function(e){
 if(!editing)return;
 e.preventDefault();
 var t=(e.clipboardData&&e.clipboardData.getData("text/plain"))||"";
 document.execCommand("insertText",false,t);
},true);
document.addEventListener("submit",function(e){if(enabled)e.preventDefault();},true);
var raf=0;
window.addEventListener("scroll",function(){
 if(raf)return;
 raf=requestAnimationFrame(function(){raf=0;post({type:"band-visual-edit:scroll",x:window.scrollX,y:window.scrollY});});
},{passive:true});
function applied(d){
 var els=document.querySelectorAll("[data-band-src]");
 for(var i=0;i<els.length;i++){
  var el=els[i],r=el.getAttribute("data-band-src").split(":"),s=Number(r[0]),e=Number(r[1]);
  if(s===d.start&&e===d.end){if(el!==editing)el.textContent=d.text;el.setAttribute("data-band-src",s+":"+(e+d.delta));}
  else if(s>=d.end)el.setAttribute("data-band-src",(s+d.delta)+":"+(e+d.delta));
 }
}
window.addEventListener("message",function(e){
 if(e.source!==window.parent)return;
 var d=e.data;
 if(d&&d.nonce===NONCE&&d.type==="band-visual-edit:clear-target"){clearComment();return;}
 if(d&&d.nonce===NONCE&&d.type==="band-visual-edit:applied"){applied(d);return;}
 if(!d||d.nonce!==NONCE||d.type!=="band-visual-edit:mode")return;
 enabled=d.enabled===true;
 if(!enabled){cancel();clearHover();}
 if(scrollPending&&d.scroll){scrollPending=false;window.scrollTo(Number(d.scroll.x)||0,Number(d.scroll.y)||0);}
});
post({type:"band-visual-edit:ready"});
})();`;
}

function scriptTag(nonce: string, disabled: boolean): string {
  // A "</script" inside the code would end the tag early. The script has none, and the nonce is [A-Za-z0-9_-].
  return `<script data-band-visual-edit>${pageScript(nonce, disabled)}</script>`;
}

/**
 * The previewed page with edit hooks. Every element whose only text is a
 * single text node from the source gets `data-band-src="<start>:<end>"`, the
 * UTF-16 range of that text node in `source`. The attributes are inserted
 * after the offsets are measured, from the end of the file backwards, so the
 * recorded offsets refer to the original file. One script is appended after
 * everything, which browsers place at the end of the body.
 */
export function annotateHtmlForEdit(source: string, nonce: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const insertions: Insertion[] = [];
  collect(document as unknown as Node, source, insertions);
  insertions.sort((a, b) => b.at - a.at);
  let out = source;
  for (const { at, text } of insertions) out = out.slice(0, at) + text + out.slice(at);
  return `${out}\n${scriptTag(nonce, false)}`;
}

/** A page too large to annotate: served as it is, plus a script that tells the parent. */
export function markHtmlUnavailable(source: string, nonce: string): string {
  return `${source}\n${scriptTag(nonce, true)}`;
}
