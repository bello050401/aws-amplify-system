import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { PullToRefreshListProps } from "./PullToRefreshList";
import { PULL_THRESHOLD, PullToRefreshGesture } from "../domain/pullToRefresh";
import { colors } from "./theme";

/** React Native Web's RefreshControl is a placeholder, so handle the web gesture explicitly. */
export function PullToRefreshList<T>({ onRefresh, refreshing, ...props }: PullToRefreshListProps<T>) {
  const list = useRef<FlatList<T>>(null);
  const latest = useRef({ onRefresh, refreshing });
  latest.current = { onRefresh, refreshing };
  const [distance, setDistance] = useState(0);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const node = list.current?.getScrollableNode() as HTMLElement | undefined;
    if (!node?.addEventListener) return;
    const gesture = new PullToRefreshGesture();
    let busy = false, disposed = false, touchId: number | null = null, pointerId: number | null = null;
    let suppressClickUntil = 0;
    const overscroll = node.style.overscrollBehaviorY, userSelect = node.style.userSelect;
    node.style.overscrollBehaviorY = "contain";
    const editable = (target: EventTarget | null) => target instanceof Element && !!target.closest("input,textarea,select,[contenteditable=true]");
    const begin = (x: number, y: number, target: EventTarget | null) => {
      gesture.begin(x, y, node.scrollTop, busy || !!latest.current.refreshing || editable(target));
    };
    const move = (x: number, y: number, event: Event) => {
      if (gesture.move(x, y, node.scrollTop)) {
        if (event.cancelable) event.preventDefault();
        node.style.userSelect = "none";
      }
      setDistance(gesture.distance);
    };
    const finish = (cancelled: boolean) => {
      if (gesture.active) suppressClickUntil = Date.now() + 500;
      const shouldRefresh = !cancelled && gesture.release();
      gesture.cancel(); setDistance(0); node.style.userSelect = userSelect;
      if (!shouldRefresh || busy || latest.current.refreshing) return;
      busy = true; setPending(true);
      // The owner reports read failures and keeps the displayed inventory on screen.
      void Promise.resolve().then(() => latest.current.onRefresh()).catch(() => {}).finally(() => {
        busy = false;
        if (!disposed) setPending(false);
      });
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) { touchId = null; finish(true); return; }
      const touch = event.touches[0]; touchId = touch.identifier;
      begin(touch.clientX, touch.clientY, event.target);
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) { touchId = null; finish(true); return; }
      const touch = event.touches[0];
      if (touch.identifier === touchId) move(touch.clientX, touch.clientY, event);
    };
    const touchEnd = (event: TouchEvent) => {
      if (touchId === null || !Array.from(event.changedTouches).some(touch => touch.identifier === touchId)) return;
      touchId = null; finish(event.type === "touchcancel");
    };
    // Mouse/pen dragging gives desktop users the same action; touch uses the non-passive listeners above.
    const pointerDown = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.button !== 0) return;
      pointerId = event.pointerId; begin(event.clientX, event.clientY, event.target);
    };
    const pointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      move(event.clientX, event.clientY, event);
      if (gesture.active && !node.hasPointerCapture(event.pointerId)) node.setPointerCapture(event.pointerId);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null; finish(event.type === "pointercancel");
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
    };
    const pointerLeave = () => { if (!gesture.active) pointerId = null; };
    const stopClick = (event: MouseEvent) => {
      if (event.detail && Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); }
    };
    const stopImageDrag = (event: DragEvent) => { if (pointerId !== null) event.preventDefault(); };
    const stopSelection = (event: Event) => { if (pointerId !== null) event.preventDefault(); };
    node.addEventListener("touchstart", touchStart, { passive: true });
    node.addEventListener("touchmove", touchMove, { passive: false });
    node.addEventListener("touchend", touchEnd);
    node.addEventListener("touchcancel", touchEnd);
    node.addEventListener("pointerdown", pointerDown);
    node.addEventListener("pointermove", pointerMove);
    node.addEventListener("pointerup", pointerEnd);
    node.addEventListener("pointercancel", pointerEnd);
    node.addEventListener("pointerleave", pointerLeave);
    node.addEventListener("click", stopClick, true);
    node.addEventListener("dragstart", stopImageDrag);
    node.addEventListener("selectstart", stopSelection);
    return () => {
      disposed = true;
      node.style.overscrollBehaviorY = overscroll; node.style.userSelect = userSelect;
      node.removeEventListener("touchstart", touchStart); node.removeEventListener("touchmove", touchMove);
      node.removeEventListener("touchend", touchEnd); node.removeEventListener("touchcancel", touchEnd);
      node.removeEventListener("pointerdown", pointerDown); node.removeEventListener("pointermove", pointerMove);
      node.removeEventListener("pointerup", pointerEnd); node.removeEventListener("pointercancel", pointerEnd);
      node.removeEventListener("pointerleave", pointerLeave); node.removeEventListener("click", stopClick, true);
      node.removeEventListener("dragstart", stopImageDrag);
      node.removeEventListener("selectstart", stopSelection);
    };
  }, []);

  const ready = distance >= PULL_THRESHOLD;
  return <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
    <div role="status" aria-live="polite" aria-hidden={!pending && distance === 0}
      style={{ height: pending ? 52 : distance, flexShrink: 0, overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        transition: distance ? "none" : "height 180ms ease", color: colors.muted, fontSize: 12 }}>
      {pending ? <ActivityIndicator size="small" color={colors.turquoise} /> : <span style={{ display: "flex", transform: `rotate(${ready ? 180 : 0}deg)`, transition: "transform 150ms ease" }}><Ionicons name="arrow-down" size={19} color={colors.turquoise} /></span>}
      <span>{pending ? "更新中…" : ready ? "指を離して更新" : "下に引いて更新"}</span>
    </div>
    <FlatList {...props} ref={list} />
  </div>;
}
