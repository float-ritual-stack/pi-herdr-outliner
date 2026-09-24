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
