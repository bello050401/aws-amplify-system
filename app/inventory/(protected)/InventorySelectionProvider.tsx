"use client";

import { useSearchParams } from "next/navigation";
import { createContext, useCallback, useContext, useMemo, useState, useEffect } from "react";

/** Selection is keyed by immutable product IDs and survives pagination. Only filter changes clear it. */
interface InventorySelectionContextValue {
  selected: Set<string>;
  editable: boolean;
  remove: (ids:string[]) => void;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  clear: () => void;
}

const InventorySelectionContext = createContext<InventorySelectionContextValue | null>(null);

export function InventorySelectionProvider({ children, editable }: { children: React.ReactNode; editable:boolean }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const params=useSearchParams();
  const filterKey=JSON.stringify([params.get("q"),params.get("categoryIds"),params.get("locationId"),params.get("statusId"),params.get("adv")]);
  useEffect(()=>{setSelected(new Set());},[filterKey]);
  const remove=useCallback((ids:string[])=>setSelected(prev=>new Set([...prev].filter(id=>!ids.includes(id)))),[]);
  const isSelected = useCallback((id: string) => selected.has(id), [selected]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const allSelected = ids.length > 0 && ids.every((id) => prev.has(id));
      const next=new Set(prev); for(const id of ids){if(allSelected)next.delete(id);else next.add(id);} return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo(() => ({ selected, isSelected, toggle, toggleAll, clear, remove, editable }), [selected, isSelected, toggle, toggleAll, clear, remove, editable]);

  return <InventorySelectionContext.Provider value={value}><div className="contents" style={{"--inventory-selection-space": selected.size?"76px":"0px"} as React.CSSProperties}>{children}</div></InventorySelectionContext.Provider>;
}

export function useInventorySelection(): InventorySelectionContextValue {
  const ctx = useContext(InventorySelectionContext);
  if (!ctx) throw new Error("useInventorySelection must be used within InventorySelectionProvider");
  return ctx;
}
