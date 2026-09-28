import {expect,test} from 'bun:test';
import {ScrollView,TuiAltScreen,VStack} from '@earendil-works/pi-tui';
import {terminalFixture} from './terminal-fixture';

test('terminal copy reports the same grapheme bounds in scroll-content coordinates after scrolling',async()=>{
  const {terminal,input}=terminalFixture(30,8);
  const lines=['offscreen','A界é B',...Array.from({length:12},(_,i)=>`line ${i}`)];
  const scroll=new ScrollView({render:()=>lines,invalidate(){}},{primary:true,follow:'none',scrollbar:'hidden'});
  let received:unknown[]|undefined;
  const tui=new TuiAltScreen(terminal,false,undefined,{
    mouse:true,async copySelection(...args){received=args;return true;},
  });
  tui.setLayoutRoot(new VStack([
    {component:{render:()=>['Header'],invalidate(){}},basis:1,shrink:0},
    {component:scroll,grow:1,minSize:1},
  ]));
  try {
    tui.start();tui.renderNow();
    scroll.scrollTo(1);tui.renderNow();
    expect(scroll.scrollTop).toBe(1);
    // Start on the second visible column of 界, end on the combining grapheme.
    input('\x1b[<0;3;2M');
    input('\x1b[<32;4;2M');
    input('\x1b[<0;4;2m');
    expect(received?.[0]).toBe('界é');
    expect(received?.[1]).toEqual(['界é']);
    const selection=received?.[2] as {scrollView?:ScrollView;ranges:unknown[];sourceLines:readonly string[]}|undefined;
    expect(selection?.scrollView).toBe(scroll);
    expect(selection?.ranges).toEqual([{row:1,start:1,end:4}]);
    expect(selection?.sourceLines[1]).toBe('A界é B');
  } finally {tui.stop();}
});
