import {StdinBuffer} from '@earendil-works/pi-tui';
import {emitKeypressEvents} from 'node:readline';
import {PassThrough,type Readable} from 'node:stream';
import {TerminalInputDecoder,type TerminalInputAction,type TerminalKey} from './terminal';
import {isTreeMouseSequence} from './tree-mouse';

/** Decode UTF-8 before framing terminal sequences, so partial characters survive stdin chunks. */
export function attachCaptureInput(input:Readable,handlers:{
 keypress(text:string,key:TerminalKey,action:TerminalInputAction):void;
 paste(text:string):void;
 mouse(sequence:string):void;
}):()=>void {
 const frames=new StdinBuffer(),keys=new PassThrough();
 const decoder=new TerminalInputDecoder(handlers.paste);
 input.setEncoding('utf8');
 emitKeypressEvents(keys);
 frames.on('data',sequence=>{if(isTreeMouseSequence(sequence))handlers.mouse(sequence);else keys.write(sequence);});
 frames.on('paste',handlers.paste);
 keys.on('keypress',(str:string|undefined,key:TerminalKey)=>{
  const text=str??'';if(!key.sequence&&!text&&!key.name)return;
  handlers.keypress(text,key,decoder.consume(text,key));
 });
 const onData=(data:string)=>frames.process(data);
 input.on('data',onData);
 return ()=>{input.off('data',onData);frames.destroy();keys.destroy();};
}
