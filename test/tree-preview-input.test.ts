import {expect, test} from "bun:test";
import {DocumentPreviewInput} from "../src/document-preview-input";
import type {PreviewInputActions} from "../src/document-preview-input";
import type {TreePreviewFrame} from "../src/tree-preview";

const pointer = (column: number, row: number, phase: "down" | "drag" | "up" = "down") => `\x1b[<${phase === "drag" ? 32 : 0};${column + 1};${row + 1}${phase === "up" ? "m" : "M"}`;
function fixture(placement: "beside" | "below") {
  const rect = placement === "beside" ? {x: 10, y: 0, width: 10, height: 10} : {x: 0, y: 10, width: 20, height: 10};
  const frame: TreePreviewFrame = {rect, content: {...rect, y: rect.y + 2, height: rect.height - 3}, lines: [], totalRows: 50, offset: 0, treeWidth: rect.x || rect.width, treeHeight: rect.y || rect.height, placement};
  let focused = false;
  const focusCalls: boolean[] = [];
  const controller = {focus(value = true) {focused = value; focusCalls.push(value);}, scroll() {}} as unknown as PreviewInputActions;
  const input = new DocumentPreviewInput();
  input.render(Array.from({length: 20}, () => "tree text preview text"), frame, undefined);
  return {input, controller, frame, focusCalls, focused: () => focused, send: (sequence: string) => input.handle(sequence, controller, () => {}, () => {})};
}

for (const placement of ["beside", "below"] as const) {
  test(`clicking Tree restores keyboard focus after clicking ${placement} Preview`, () => {
    const h = fixture(placement);
    const {x, y} = h.frame.content;
    expect(h.send(pointer(x + 1, y))).toBe(true);
    h.send(pointer(x + 1, y, "up"));
    expect(h.focused()).toBe(true);
    expect(h.send(pointer(2, 3))).toBe(false); // Tree adapter must still receive the click.
    expect(h.focused()).toBe(false);
    expect(h.focusCalls.at(-1)).toBe(false);
  });

  test(`a drag from ${placement} Preview stays focused until released outside`, () => {
    const h = fixture(placement);
    h.send(pointer(h.frame.content.x + 1, h.frame.content.y));
    expect(h.send(pointer(2, 3, "drag"))).toBe(true);
    expect(h.send(pointer(2, 3, "up"))).toBe(true);
    expect(h.focused()).toBe(true);
    expect(h.focusCalls).not.toContain(false);
  });
}

test('Preview toolbar and divider consume pointer input before selection',()=>{
 const h=fixture('beside');const actions:string[]=[];const sizes:number[]=[];
 h.controller.invoke=async id=>{actions.push(id);};h.controller.resize=f=>sizes.push(f);
 h.frame.controls=[{rect:{x:10,y:1,width:3,height:1},action:'tree.preview.bottom'}];
 h.frame.divider={x:9,y:0,width:1,height:10};
 expect(h.send(pointer(11,1))).toBe(true);expect(actions).toEqual(['tree.preview.bottom']);
 expect(h.send(pointer(9,4))).toBe(true);expect(h.send(pointer(5,4,'drag'))).toBe(true);expect(h.send(pointer(5,4,'up'))).toBe(true);
 expect(sizes.at(-1)).toBeCloseTo(1-5/19);expect(h.focusCalls).toEqual([]);
});

test('releasing a content selection over a toolbar completes copy instead of invoking a button',()=>{
 const h=fixture('beside');h.frame.controls=[{rect:{x:10,y:1,width:3,height:1},action:'tree.preview.bottom'}];
 const copies:string[]=[];const actions:string[]=[];h.controller.invoke=async id=>{actions.push(id);};
 const send=(s:string)=>h.input.handle(s,h.controller,text=>copies.push(text),()=>{});
 send(pointer(14,4));send(pointer(11,1,'drag'));send(pointer(11,1,'up'));
 expect(copies.length).toBe(1);expect(actions).toEqual([]);
 expect(send(pointer(2,3))).toBe(false);
});

test('links follow on click release, while dragging links copies and never navigates',()=>{
 const h=fixture('below');const actions:string[]=[];const copies:string[]=[];
 h.controller.invoke=async action=>{actions.push(action);};
 h.frame.links=[{rect:{x:1,y:12,width:8,height:1},uri:'pi-outliner://block/abcdefgh'}];
 const send=(s:string)=>h.input.handle(s,h.controller,text=>copies.push(text),()=>{});
 send(pointer(2,12));expect(actions).toEqual([]);send(pointer(2,12,'up'));
 expect(actions).toEqual(['preview.link:pi-outliner%3A%2F%2Fblock%2Fabcdefgh']);
 actions.length=0;
 send(pointer(2,12));send(pointer(6,12,'drag'));send(pointer(6,12,'up'));
 expect(actions).toEqual([]);expect(copies.length).toBe(1);
 // Returning to the initial cell after a drag is still not a click.
 send(pointer(2,12));send(pointer(6,12,'drag'));send(pointer(2,12,'up'));expect(actions).toEqual([]);
 // A redraw with a different document invalidates a pending link.
 send(pointer(2,12));h.input.render([],undefined,undefined);send(pointer(2,12,'up'));expect(actions).toEqual([]);
});
