import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { DESKTOP_QUERY, useMediaQuery } from "./use-media-query";

/**
 * Phone drill-in for menu submenus. Radix opens a submenu as a fly-out beside
 * its trigger, which on a phone lands off-screen or under a neighbouring
 * control, and a tap on the trigger does not reliably open it. Below the
 * desktop breakpoint the menu instead replaces its own content with the
 * submenu's items under a "Back" row. Desktop keeps the Radix fly-out.
 */

type Level = {
  openSub: string | null;
  setOpenSub: (id: string | null) => void;
  slot: HTMLElement | null;
};

const LevelContext = React.createContext<Level | null>(null);
const SubContext = React.createContext<{ id: string; level: Level } | null>(null);

type ItemComponent = React.ComponentType<
  Omit<React.ComponentProps<"div">, "onSelect"> & {
    onSelect?: (event: Event) => void;
    disabled?: boolean;
  }
>;

/** True when menus drill in instead of flying out. */
export function useDrillIn(): boolean {
  return !useMediaQuery(DESKTOP_QUERY);
}

/** True inside a drill-in submenu, where Radix portals must not be used. */
export function useInDrillSub(): boolean {
  return React.useContext(SubContext) !== null;
}

/** One menu page. Hides its own children while one of its submenus is open and
 *  gives that submenu a place to render. */
export function DrillLevel({ children }: { children: React.ReactNode }) {
  const [openSub, setOpenSub] = React.useState<string | null>(null);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const level = React.useMemo(() => ({ openSub, setOpenSub, slot }), [openSub, slot]);
  return (
    <LevelContext.Provider value={level}>
      <div className={openSub === null ? "contents" : "hidden"}>{children}</div>
      <div ref={setSlot} className="contents" />
    </LevelContext.Provider>
  );
}

export function DrillSub({ children }: { children: React.ReactNode }) {
  const id = React.useId();
  const level = React.useContext(LevelContext);
  const value = React.useMemo(() => (level ? { id, level } : null), [id, level]);
  return <SubContext.Provider value={value}>{children}</SubContext.Provider>;
}

export function DrillSubTrigger({
  Item,
  children,
  disabled,
  onSelect,
  ...props
}: Omit<React.ComponentProps<"div">, "onSelect"> & {
  Item: ItemComponent;
  disabled?: boolean;
  onSelect?: (event: Event) => void;
}) {
  const sub = React.useContext(SubContext);
  return (
    <Item
      {...props}
      disabled={disabled}
      onSelect={(event) => {
        // Drilling in keeps the menu open.
        event.preventDefault();
        onSelect?.(event);
        sub?.level.setOpenSub(sub.id);
      }}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3.5" />
    </Item>
  );
}

export function DrillSubContent({
  Item,
  children,
  "data-testid": testId,
}: {
  Item: ItemComponent;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const sub = React.useContext(SubContext);
  if (!sub || sub.level.openSub !== sub.id) return null;
  const { level } = sub;
  const slot = level.slot;
  if (!slot) return null;
  return createPortal(
    <div className="contents" data-testid={testId}>
      <DrillLevel>
        <Item
          data-testid="menu-drill__back"
          onSelect={(event) => {
            event.preventDefault();
            level.setOpenSub(null);
          }}
        >
          <ChevronLeftIcon className="size-3.5" />
          Back
        </Item>
        {children}
      </DrillLevel>
    </div>,
    slot,
  );
}
