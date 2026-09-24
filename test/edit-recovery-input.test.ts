import {expect,test} from "bun:test";
import {EditRecoveryInput} from "../src/edit-recovery-input";

test("review ignores Kitty releases and commands inside fragmented bracketed paste",()=>{
  const input=new EditRecoveryInput();
  expect(input.push("\x1b[13;1:3u")).toEqual([]);
  expect(input.push("\x1b[20")).toEqual([]);
  expect(input.push("0~\t\r")).toEqual([]);
  expect(input.push("discard\r\x1b[201")).toEqual([]);
  expect(input.push("~")).toEqual([]);
  expect(input.push("\r")[0]?.key.name).toBe("return");
});

test("bare Escape flushes while fragmented paste remains inert",async()=>{
  const input=new EditRecoveryInput(),keys:string[]=[];
  const emit=(value:{key:{name?:string}})=>keys.push(value.key.name??"");
  input.accept("\x1b",emit);
  await Bun.sleep(60);expect(keys).toEqual(["escape"]);
  input.accept("\x1b[20",emit);input.accept("0~\r",emit);
  await Bun.sleep(60);expect(keys).toEqual(["escape"]);
  input.accept("\x1b[201~",emit);input.accept("\t",emit);
  expect(keys).toEqual(["escape","tab"]);input.dispose();
});
