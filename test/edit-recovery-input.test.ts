import {expect,test} from "bun:test";
import {EditRecoveryInput} from "../src/edit-recovery-input";

test("review ignores releases and fragmented paste while splitting combined keys",()=>{
  const input=new EditRecoveryInput(),keys:string[]=[];
  const emit=(value:{key:{name?:string}})=>keys.push(value.key.name??"");
  for(const chunk of ["\x1b[13;1:3u","\x1b[20","0~\t\r","discard\r\x1b[201","~"])input.accept(chunk,emit);
  expect(keys).toEqual([]);
  input.accept("\t\r",emit);expect(keys).toEqual(["tab","return"]);input.dispose();
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
