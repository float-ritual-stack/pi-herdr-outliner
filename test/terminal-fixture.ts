import type {Terminal} from '@earendil-works/pi-tui';

/** Drive the real TUI input listener without borrowing a user's terminal. */
export function terminalFixture(columns=60,rows=12) {
  let receive:(data:string)=>void=()=>{throw Error('Terminal not started');};
  const terminal:Terminal={
    columns,rows,kittyProtocolActive:false,
    start(onInput){receive=onInput;},stop(){},async drainInput(){},write(){},
    moveBy(){},hideCursor(){},showCursor(){},clearLine(){},clearFromCursor(){},
    clearScreen(){},setTitle(){},setProgress(){},
  };
  return {terminal,input:(data:string)=>receive(data)};
}
