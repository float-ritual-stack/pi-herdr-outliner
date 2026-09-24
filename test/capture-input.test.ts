import {expect,test} from 'bun:test';
import {PassThrough} from 'node:stream';
import {attachCaptureInput} from '../src/capture-input';
import {TextBuffer} from '../src/text-buffer';
import {applyTextBufferEditorCommand,textBufferEditorCommand} from '../src/text-buffer-editor';
test('capture input preserves split UTF-8 typing and bracketed paste beside mouse frames',()=>{
 const input=new PassThrough(),buffer=new TextBuffer(),clicks:string[]=[];
 const detach=attachCaptureInput(input,{
  keypress:(str,key,action)=>{if(action==='pass')applyTextBufferEditorCommand(buffer,textBufferEditorCommand(str,key,false));},
  paste:text=>buffer.insert(text),mouse:sequence=>clicks.push(sequence),
 });
 for(const byte of Buffer.from('é日😀👩‍💻é'))input.write(Buffer.from([byte]));
 input.write('\x1b[200~');for(const byte of Buffer.from(' café\n日本'))input.write(Buffer.from([byte]));input.write('\x1b[201~');
 input.write('\x1b[<0;4;5M');
 expect(buffer.text).toBe('é日😀👩‍💻é café\n日本');expect(clicks).toEqual(['\x1b[<0;4;5M']);
 detach();input.write('ignored');expect(buffer.text).toBe('é日😀👩‍💻é café\n日本');input.destroy();
});
