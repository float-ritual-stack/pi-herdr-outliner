// shadcn/ui for published React artifacts (src/publish-artifacts.ts). claude.ai
// artifacts import these from "@/components/ui/<name>"; every such import
// resolves to this one file. Same names, props and Tailwind look as shadcn's,
// without Radix: enough for what artifacts use, not a full reimplementation.
import {
  Children, cloneElement, createContext, forwardRef, isValidElement,
  useContext, useEffect, useId, useRef, useState,
} from "react";

export function cn(...values) {
  const out = [];
  for (const value of values) {
    if (!value) continue;
    if (typeof value === "string" || typeof value === "number") out.push(String(value));
    else if (Array.isArray(value)) out.push(cn(...value));
    else if (typeof value === "object") for (const [key, on] of Object.entries(value)) if (on) out.push(key);
  }
  return out.join(" ");
}

function useControlled(value, fallback, onChange) {
  const [inner, setInner] = useState(fallback);
  const controlled = value !== undefined;
  const set = (next) => {
    if (!controlled) setInner(next);
    if (onChange) onChange(next);
  };
  return [controlled ? value : inner, set];
}

/** `asChild`: the only child takes the props (and its own handlers still run). */
function Slot({ children, ...props }) {
  const child = Children.only(children);
  if (!isValidElement(child)) return child;
  const merged = { ...props, ...child.props, className: cn(props.className, child.props.className) };
  for (const key of Object.keys(props)) {
    if (/^on[A-Z]/.test(key) && typeof child.props[key] === "function") {
      merged[key] = (event) => { child.props[key](event); props[key](event); };
    }
  }
  return cloneElement(child, merged);
}

function el(tag, base) {
  const Component = forwardRef(({ className, asChild, ...props }, ref) => {
    const Tag = asChild ? Slot : tag;
    return <Tag ref={ref} className={cn(base, className)} {...props} />;
  });
  return Component;
}

// button
const buttonVariantClasses = {
  default: "bg-slate-900 text-white hover:bg-slate-800",
  destructive: "bg-red-600 text-white hover:bg-red-700",
  outline: "border border-slate-200 bg-white hover:bg-slate-100 text-slate-900",
  secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
  ghost: "hover:bg-slate-100 text-slate-900",
  link: "text-slate-900 underline-offset-4 hover:underline",
};
const buttonSizeClasses = { default: "h-10 px-4 py-2", sm: "h-9 rounded-md px-3", lg: "h-11 rounded-md px-8", icon: "h-10 w-10" };
export function buttonVariants({ variant = "default", size = "default", className } = {}) {
  return cn(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:pointer-events-none disabled:opacity-50",
    buttonVariantClasses[variant] ?? buttonVariantClasses.default,
    buttonSizeClasses[size] ?? buttonSizeClasses.default,
    className,
  );
}
export const Button = forwardRef(({ className, variant, size, asChild, ...props }, ref) => {
  const Tag = asChild ? Slot : "button";
  return <Tag ref={ref} className={buttonVariants({ variant, size, className })} {...props} />;
});

// card
export const Card = el("div", "rounded-lg border border-slate-200 bg-white text-slate-950 shadow-sm");
export const CardHeader = el("div", "flex flex-col space-y-1.5 p-6");
export const CardTitle = el("h3", "text-2xl font-semibold leading-none tracking-tight");
export const CardDescription = el("p", "text-sm text-slate-500");
export const CardContent = el("div", "p-6 pt-0");
export const CardFooter = el("div", "flex items-center p-6 pt-0");

// alert
export const Alert = forwardRef(({ className, variant = "default", ...props }, ref) => (
  <div ref={ref} role="alert" className={cn("relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4",
    variant === "destructive" ? "border-red-500/50 text-red-600" : "bg-white text-slate-950", className)} {...props} />
));
export const AlertTitle = el("h5", "mb-1 font-medium leading-none tracking-tight");
export const AlertDescription = el("div", "text-sm [&_p]:leading-relaxed");

// badge
const badgeClasses = {
  default: "border-transparent bg-slate-900 text-white",
  secondary: "border-transparent bg-slate-100 text-slate-900",
  destructive: "border-transparent bg-red-600 text-white",
  outline: "text-slate-950",
};
export function badgeVariants({ variant = "default", className } = {}) {
  return cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors", badgeClasses[variant] ?? badgeClasses.default, className);
}
export function Badge({ className, variant, ...props }) {
  return <div className={badgeVariants({ variant, className })} {...props} />;
}

// input, textarea, label, separator, skeleton, progress
export const Input = forwardRef(({ className, type, ...props }, ref) => (
  <input ref={ref} type={type} className={cn("flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
));
export const Textarea = forwardRef(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn("flex min-h-[80px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />
));
export const Label = el("label", "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70");
export function Separator({ className, orientation = "horizontal", decorative, ...props }) {
  return <div role={decorative ? "none" : "separator"} className={cn("shrink-0 bg-slate-200", orientation === "horizontal" ? "h-[1px] w-full" : "h-full w-[1px]", className)} {...props} />;
}
export function Skeleton({ className, ...props }) {
  return <div className={cn("animate-pulse rounded-md bg-slate-100", className)} {...props} />;
}
export function Progress({ className, value = 0, max = 100, ...props }) {
  const percent = Math.max(0, Math.min(100, ((value ?? 0) / max) * 100));
  return (
    <div role="progressbar" aria-valuenow={value} aria-valuemax={max} className={cn("relative h-4 w-full overflow-hidden rounded-full bg-slate-100", className)} {...props}>
      <div className="h-full bg-slate-900 transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

// checkbox, switch, slider, toggle
export const Checkbox = forwardRef(({ className, checked, defaultChecked, onCheckedChange, disabled, ...props }, ref) => {
  const [on, setOn] = useControlled(checked, defaultChecked ?? false, onCheckedChange);
  return (
    <button ref={ref} type="button" role="checkbox" aria-checked={on} disabled={disabled} onClick={() => setOn(!on)}
      className={cn("peer inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-slate-900 disabled:opacity-50", on && "bg-slate-900 text-white", className)} {...props}>
      {on ? <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg> : null}
    </button>
  );
});
export const Switch = forwardRef(({ className, checked, defaultChecked, onCheckedChange, disabled, ...props }, ref) => {
  const [on, setOn] = useControlled(checked, defaultChecked ?? false, onCheckedChange);
  return (
    <button ref={ref} type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => setOn(!on)}
      className={cn("peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors disabled:opacity-50", on ? "bg-slate-900" : "bg-slate-200", className)} {...props}>
      <span className={cn("pointer-events-none block h-5 w-5 rounded-full bg-white shadow-lg transition-transform", on ? "translate-x-5" : "translate-x-0")} />
    </button>
  );
});
export function Slider({ className, value, defaultValue, onValueChange, onValueCommit, min = 0, max = 100, step = 1, disabled, ...props }) {
  const [values, setValues] = useControlled(value, defaultValue ?? [min], onValueChange);
  return (
    <input type="range" min={min} max={max} step={step} disabled={disabled} value={values?.[0] ?? min}
      onChange={(event) => setValues([Number(event.target.value)])}
      onMouseUp={() => onValueCommit?.(values)} onKeyUp={() => onValueCommit?.(values)}
      className={cn("w-full cursor-pointer accent-slate-900", className)} {...props} />
  );
}
export function Toggle({ className, pressed, defaultPressed, onPressedChange, variant, size, ...props }) {
  const [on, setOn] = useControlled(pressed, defaultPressed ?? false, onPressedChange);
  return <button type="button" aria-pressed={on} onClick={() => setOn(!on)}
    className={cn("inline-flex h-10 items-center justify-center rounded-md px-3 text-sm font-medium hover:bg-slate-100", variant === "outline" && "border border-slate-200", on && "bg-slate-100", className)} {...props} />;
}

// tabs
const TabsContext = createContext(null);
export function Tabs({ value, defaultValue, onValueChange, className, children, ...props }) {
  const [current, setCurrent] = useControlled(value, defaultValue, onValueChange);
  return <TabsContext.Provider value={{ current, setCurrent }}><div className={className} {...props}>{children}</div></TabsContext.Provider>;
}
export const TabsList = el("div", "inline-flex h-10 items-center justify-center rounded-md bg-slate-100 p-1 text-slate-500");
export function TabsTrigger({ value, className, disabled, ...props }) {
  const tabs = useContext(TabsContext);
  const active = tabs?.current === value;
  return <button type="button" role="tab" aria-selected={active} disabled={disabled} data-state={active ? "active" : "inactive"} onClick={() => tabs?.setCurrent(value)}
    className={cn("inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all disabled:opacity-50", active && "bg-white text-slate-950 shadow-sm", className)} {...props} />;
}
export function TabsContent({ value, className, ...props }) {
  const tabs = useContext(TabsContext);
  if (tabs?.current !== value) return null;
  return <div role="tabpanel" className={cn("mt-2", className)} {...props} />;
}

// select
const SelectContext = createContext(null);
export function Select({ value, defaultValue, onValueChange, open, onOpenChange, disabled, children }) {
  const [current, setCurrent] = useControlled(value, defaultValue, onValueChange);
  const [isOpen, setOpen] = useControlled(open, false, onOpenChange);
  const labels = useRef(new Map());
  return (
    <SelectContext.Provider value={{ current, setCurrent, isOpen, setOpen, disabled, labels: labels.current }}>
      <div className="relative">{children}</div>
    </SelectContext.Provider>
  );
}
export const SelectTrigger = forwardRef(({ className, children, ...props }, ref) => {
  const select = useContext(SelectContext);
  return (
    <button ref={ref} type="button" disabled={select?.disabled} onClick={() => select?.setOpen(!select.isOpen)}
      className={cn("flex h-10 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2 text-sm disabled:opacity-50", className)} {...props}>
      {children}<span aria-hidden="true" className="ml-2 opacity-50">▾</span>
    </button>
  );
});
export function SelectValue({ placeholder }) {
  const select = useContext(SelectContext);
  const [, rerender] = useState(0);
  useEffect(() => { rerender((n) => n + 1); }, [select?.current]);
  if (select?.current === undefined || select?.current === "") return <span className="text-slate-400">{placeholder}</span>;
  return <span>{select.labels.get(select.current) ?? select.current}</span>;
}
export function SelectContent({ className, children }) {
  const select = useContext(SelectContext);
  return (
    <div hidden={!select?.isOpen} className={cn("absolute z-50 mt-1 max-h-72 w-full min-w-[8rem] overflow-auto rounded-md border border-slate-200 bg-white p-1 text-slate-950 shadow-md", className)}>
      {children}
    </div>
  );
}
export function SelectItem({ value, className, children, disabled }) {
  const select = useContext(SelectContext);
  const text = typeof children === "string" || typeof children === "number" ? String(children) : undefined;
  if (select && text !== undefined) select.labels.set(value, text);
  const chosen = select?.current === value;
  return (
    <div role="option" aria-selected={chosen} aria-disabled={disabled} onClick={() => { if (!disabled) { select?.setCurrent(value); select?.setOpen(false); } }}
      className={cn("relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm hover:bg-slate-100", disabled && "opacity-50", className)}>
      {chosen ? <span className="absolute left-2">✓</span> : null}{children}
    </div>
  );
}
export const SelectGroup = el("div", "");
export const SelectLabel = el("div", "py-1.5 pl-8 pr-2 text-sm font-semibold");
export const SelectSeparator = el("div", "-mx-1 my-1 h-px bg-slate-100");

// dialog and alert dialog
const DialogContext = createContext(null);
export function Dialog({ open, defaultOpen, onOpenChange, children }) {
  const [isOpen, setOpen] = useControlled(open, defaultOpen ?? false, onOpenChange);
  return <DialogContext.Provider value={{ isOpen, setOpen }}>{children}</DialogContext.Provider>;
}
export function DialogTrigger({ asChild, children, ...props }) {
  const dialog = useContext(DialogContext);
  const Tag = asChild ? Slot : "button";
  return <Tag onClick={() => dialog?.setOpen(true)} {...props}>{children}</Tag>;
}
export function DialogClose({ asChild, children, ...props }) {
  const dialog = useContext(DialogContext);
  const Tag = asChild ? Slot : "button";
  return <Tag onClick={() => dialog?.setOpen(false)} {...props}>{children}</Tag>;
}
export function DialogContent({ className, children, ...props }) {
  const dialog = useContext(DialogContext);
  if (!dialog?.isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => dialog.setOpen(false)}>
      <div role="dialog" onClick={(event) => event.stopPropagation()}
        className={cn("relative grid w-full max-w-lg gap-4 border bg-white p-6 shadow-lg sm:rounded-lg", className)} {...props}>
        {children}
        <button type="button" aria-label="Close" onClick={() => dialog.setOpen(false)} className="absolute right-4 top-4 opacity-70 hover:opacity-100">✕</button>
      </div>
    </div>
  );
}
export const DialogHeader = el("div", "flex flex-col space-y-1.5 text-center sm:text-left");
export const DialogFooter = el("div", "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2");
export const DialogTitle = el("h2", "text-lg font-semibold leading-none tracking-tight");
export const DialogDescription = el("p", "text-sm text-slate-500");
export const AlertDialog = Dialog;
export const AlertDialogTrigger = DialogTrigger;
export function AlertDialogContent({ className, children, ...props }) {
  const dialog = useContext(DialogContext);
  if (!dialog?.isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80">
      <div role="alertdialog" className={cn("grid w-full max-w-lg gap-4 border bg-white p-6 shadow-lg sm:rounded-lg", className)} {...props}>{children}</div>
    </div>
  );
}
export const AlertDialogHeader = DialogHeader;
export const AlertDialogFooter = DialogFooter;
export const AlertDialogTitle = DialogTitle;
export const AlertDialogDescription = DialogDescription;
export function AlertDialogAction({ className, onClick, ...props }) {
  const dialog = useContext(DialogContext);
  return <button type="button" className={buttonVariants({ className })} onClick={(event) => { onClick?.(event); dialog?.setOpen(false); }} {...props} />;
}
export function AlertDialogCancel({ className, onClick, ...props }) {
  const dialog = useContext(DialogContext);
  return <button type="button" className={buttonVariants({ variant: "outline", className: cn("mt-2 sm:mt-0", className) })} onClick={(event) => { onClick?.(event); dialog?.setOpen(false); }} {...props} />;
}
export const Sheet = Dialog;
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export function SheetContent({ className, side = "right", children, ...props }) {
  const dialog = useContext(DialogContext);
  if (!dialog?.isOpen) return null;
  const edge = { right: "inset-y-0 right-0 h-full w-3/4 max-w-sm", left: "inset-y-0 left-0 h-full w-3/4 max-w-sm", top: "inset-x-0 top-0", bottom: "inset-x-0 bottom-0" }[side];
  return (
    <div className="fixed inset-0 z-50 bg-black/80" onClick={() => dialog.setOpen(false)}>
      <div role="dialog" onClick={(event) => event.stopPropagation()} className={cn("fixed gap-4 bg-white p-6 shadow-lg", edge, className)} {...props}>{children}</div>
    </div>
  );
}
export const SheetHeader = DialogHeader;
export const SheetFooter = DialogFooter;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

// popover, tooltip, hover card, dropdown menu: open next to their trigger
function floating(name, openOn) {
  const Context = createContext(null);
  function Root({ open, defaultOpen, onOpenChange, children }) {
    const [isOpen, setOpen] = useControlled(open, defaultOpen ?? false, onOpenChange);
    return <Context.Provider value={{ isOpen, setOpen }}><span className="relative inline-block">{children}</span></Context.Provider>;
  }
  function Trigger({ asChild, children, ...props }) {
    const state = useContext(Context);
    const Tag = asChild ? Slot : "button";
    const handlers = openOn === "hover"
      ? { onMouseEnter: () => state?.setOpen(true), onMouseLeave: () => state?.setOpen(false), onFocus: () => state?.setOpen(true), onBlur: () => state?.setOpen(false) }
      : { onClick: () => state?.setOpen(!state.isOpen) };
    return <Tag {...handlers} {...props}>{children}</Tag>;
  }
  function Content({ className, children, align, side, sideOffset, ...props }) {
    const state = useContext(Context);
    if (!state?.isOpen) return null;
    return <div data-floating={name} className={cn("absolute left-0 top-full z-50 mt-2 min-w-[8rem] rounded-md border border-slate-200 bg-white p-2 text-sm text-slate-950 shadow-md", className)} {...props}>{children}</div>;
  }
  return { Root, Trigger, Content, Context };
}
const popover = floating("popover", "click");
export const Popover = popover.Root;
export const PopoverTrigger = popover.Trigger;
export const PopoverContent = popover.Content;
const tooltip = floating("tooltip", "hover");
export function TooltipProvider({ children }) { return children; }
export const Tooltip = tooltip.Root;
export const TooltipTrigger = tooltip.Trigger;
export const TooltipContent = tooltip.Content;
const hoverCard = floating("hover-card", "hover");
export const HoverCard = hoverCard.Root;
export const HoverCardTrigger = hoverCard.Trigger;
export const HoverCardContent = hoverCard.Content;
const menu = floating("menu", "click");
export const DropdownMenu = menu.Root;
export const DropdownMenuTrigger = menu.Trigger;
export const DropdownMenuContent = menu.Content;
export function DropdownMenuItem({ className, onClick, onSelect, ...props }) {
  const state = useContext(menu.Context);
  return <div role="menuitem" onClick={(event) => { onClick?.(event); onSelect?.(event); state?.setOpen(false); }}
    className={cn("relative flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm hover:bg-slate-100", className)} {...props} />;
}
export const DropdownMenuLabel = el("div", "px-2 py-1.5 text-sm font-semibold");
export const DropdownMenuSeparator = el("div", "-mx-1 my-1 h-px bg-slate-100");
export const DropdownMenuGroup = el("div", "");

// accordion, collapsible
const AccordionContext = createContext(null);
const AccordionItemContext = createContext(null);
export function Accordion({ type = "single", value, defaultValue, onValueChange, collapsible, className, children, ...props }) {
  const [open, setOpen] = useControlled(value, defaultValue ?? (type === "multiple" ? [] : ""), onValueChange);
  const isOpen = (item) => type === "multiple" ? (open ?? []).includes(item) : open === item;
  const toggle = (item) => {
    if (type === "multiple") setOpen(isOpen(item) ? open.filter((entry) => entry !== item) : [...(open ?? []), item]);
    else setOpen(isOpen(item) ? (collapsible === false ? item : "") : item);
  };
  return <AccordionContext.Provider value={{ isOpen, toggle }}><div className={className} {...props}>{children}</div></AccordionContext.Provider>;
}
export function AccordionItem({ value, className, ...props }) {
  return <AccordionItemContext.Provider value={value}><div className={cn("border-b", className)} {...props} /></AccordionItemContext.Provider>;
}
export function AccordionTrigger({ className, children, ...props }) {
  const accordion = useContext(AccordionContext);
  const item = useContext(AccordionItemContext);
  const open = accordion?.isOpen(item);
  return (
    <button type="button" aria-expanded={open} onClick={() => accordion?.toggle(item)}
      className={cn("flex w-full flex-1 items-center justify-between py-4 font-medium transition-all hover:underline", className)} {...props}>
      {children}<span aria-hidden="true" className={cn("transition-transform", open && "rotate-180")}>▾</span>
    </button>
  );
}
export function AccordionContent({ className, children, ...props }) {
  const accordion = useContext(AccordionContext);
  const item = useContext(AccordionItemContext);
  if (!accordion?.isOpen(item)) return null;
  return <div className={cn("overflow-hidden pb-4 pt-0 text-sm", className)} {...props}>{children}</div>;
}
const CollapsibleContext = createContext(null);
export function Collapsible({ open, defaultOpen, onOpenChange, className, children, ...props }) {
  const [isOpen, setOpen] = useControlled(open, defaultOpen ?? false, onOpenChange);
  return <CollapsibleContext.Provider value={{ isOpen, setOpen }}><div className={className} {...props}>{children}</div></CollapsibleContext.Provider>;
}
export function CollapsibleTrigger({ asChild, children, ...props }) {
  const state = useContext(CollapsibleContext);
  const Tag = asChild ? Slot : "button";
  return <Tag onClick={() => state?.setOpen(!state.isOpen)} {...props}>{children}</Tag>;
}
export function CollapsibleContent({ children, ...props }) {
  const state = useContext(CollapsibleContext);
  return state?.isOpen ? <div {...props}>{children}</div> : null;
}

// radio group
const RadioContext = createContext(null);
export function RadioGroup({ value, defaultValue, onValueChange, className, children, ...props }) {
  const [current, setCurrent] = useControlled(value, defaultValue, onValueChange);
  const name = useId();
  return <RadioContext.Provider value={{ current, setCurrent, name }}><div role="radiogroup" className={cn("grid gap-2", className)} {...props}>{children}</div></RadioContext.Provider>;
}
export function RadioGroupItem({ value, className, id, ...props }) {
  const radio = useContext(RadioContext);
  return <input type="radio" id={id} name={radio?.name} value={value} checked={radio?.current === value}
    onChange={() => radio?.setCurrent(value)} className={cn("h-4 w-4 accent-slate-900", className)} {...props} />;
}

// table, scroll area, avatar, aspect ratio
export const Table = forwardRef(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto"><table ref={ref} className={cn("w-full caption-bottom text-sm", className)} {...props} /></div>
));
export const TableHeader = el("thead", "[&_tr]:border-b");
export const TableBody = el("tbody", "[&_tr:last-child]:border-0");
export const TableFooter = el("tfoot", "border-t bg-slate-100/50 font-medium");
export const TableRow = el("tr", "border-b transition-colors hover:bg-slate-100/50");
export const TableHead = el("th", "h-12 px-4 text-left align-middle font-medium text-slate-500");
export const TableCell = el("td", "p-4 align-middle");
export const TableCaption = el("caption", "mt-4 text-sm text-slate-500");
export const ScrollArea = el("div", "relative overflow-auto");
export const ScrollBar = () => null;
export const Avatar = el("span", "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full");
export function AvatarImage({ className, ...props }) {
  return <img className={cn("aspect-square h-full w-full", className)} {...props} />;
}
export const AvatarFallback = el("span", "flex h-full w-full items-center justify-center rounded-full bg-slate-100");
export function AspectRatio({ ratio = 1, style, ...props }) {
  return <div style={{ aspectRatio: String(ratio), ...style }} {...props} />;
}
