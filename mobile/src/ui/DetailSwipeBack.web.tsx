import React, { useLayoutEffect, useRef, useState } from "react";
import { EdgeSwipeBackGesture } from "../domain/edgeSwipeBack";
import type { DetailSwipeBackProps } from "./DetailSwipeBack";
import { colors } from "./theme";

export function DetailSwipeBack({ enabled, onBack, children }: DetailSwipeBackProps) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(onBack); latest.current = onBack;
  const [offset, setOffset] = useState(0), [settling, setSettling] = useState(false);
  useLayoutEffect(() => {
    const node = root.current;
    setOffset(0); setSettling(false);
    if (!enabled || !node) return;
    const gesture = new EdgeSwipeBackGesture();
    let left = 0, width = 0, touchId: number | null = null, pointerId: number | null = null;
    let busy = false, suppressClickUntil = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const begin = (x: number, y: number, target: EventTarget | null) => {
      const bounds = node.getBoundingClientRect(); left = bounds.left; width = bounds.width;
      const interactive = target instanceof Element && !!target.closest("input,textarea,select,a,button,[role=button],[contenteditable=true]");
      return gesture.begin(x - left, y, width, !busy && !interactive);
    };
    const move = (x: number, y: number, event: Event) => {
      if (gesture.move(x - left, y) && event.cancelable) event.preventDefault();
      setOffset(gesture.distance);
    };
    const finish = (cancelled: boolean) => {
      if (gesture.active) suppressClickUntil = Date.now() + 500;
      const moved = gesture.distance > 0;
      const back = !cancelled && gesture.release(); gesture.cancel();
      if (busy) return;
      if (!moved) { setOffset(0); return; }
      setSettling(true); setOffset(back ? width : 0); busy = true;
      timer = setTimeout(() => {
        busy = false; setSettling(false); setOffset(0);
        if (back) latest.current();
      }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 160);
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { touchId = null; finish(true); return; }
      const touch = event.touches[0];
      if (!begin(touch.clientX, touch.clientY, event.target)) return;
      touchId = touch.identifier;
      // Reserve only the detail's left edge so Safari's page-back gesture cannot leave the app.
      if (event.cancelable) event.preventDefault();
    };
    const touchMove = (event: TouchEvent) => {
      if (touchId === null) return;
      if (event.touches.length !== 1) { touchId = null; finish(true); return; }
      const touch = event.touches[0];
      if (touch.identifier === touchId) move(touch.clientX, touch.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (touchId === null || !Array.from(event.changedTouches).some(touch => touch.identifier === touchId)) return;
      touchId = null; finish(event.type === "touchcancel");
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0 || !begin(event.clientX, event.clientY, event.target)) return;
      pointerId = event.pointerId; node.setPointerCapture(pointerId);
    };
    const pointerMove = (event: PointerEvent) => { if (event.pointerId === pointerId) move(event.clientX, event.clientY, event); };
    const pointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null; finish(event.type === "pointercancel");
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };
    const stopClick = (event: MouseEvent) => {
      if (event.detail && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    };
    const stopSelection = (event: Event) => { if (pointerId !== null) event.preventDefault(); };
    node.addEventListener("touchstart", touchStart, { passive: false });
    node.addEventListener("touchmove", touchMove, { passive: false });
    node.addEventListener("touchend", touchEnd); node.addEventListener("touchcancel", touchEnd);
    node.addEventListener("pointerdown", pointerDown); node.addEventListener("pointermove", pointerMove);
    node.addEventListener("pointerup", pointerEnd); node.addEventListener("pointercancel", pointerEnd);
    node.addEventListener("click", stopClick, true); node.addEventListener("selectstart", stopSelection);
    node.addEventListener("dragstart", stopSelection);
    return () => {
      if (timer) clearTimeout(timer); gesture.cancel();
      node.removeEventListener("touchstart", touchStart); node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("touchend", touchEnd); node.removeEventListener("touchcancel", touchEnd);
      node.removeEventListener("pointerdown", pointerDown); node.removeEventListener("pointermove", pointerMove);
      node.removeEventListener("pointerup", pointerEnd); node.removeEventListener("pointercancel", pointerEnd);
      node.removeEventListener("click", stopClick, true); node.removeEventListener("selectstart", stopSelection);
      node.removeEventListener("dragstart", stopSelection);
    };
  }, [enabled]);
  return <div ref={root} style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden", background: enabled ? colors.cream : undefined }}>
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative", background: enabled ? colors.cream : undefined,
      transform: offset ? `translateX(${offset}px)` : undefined, transition: settling ? "transform 160ms ease-out" : "none" }}>
      {children}
    </div>
  </div>;
}
