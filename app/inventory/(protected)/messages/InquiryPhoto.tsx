"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Position = { scale: number; x: number; y: number };
const fit: Position = { scale: 1, x: 0, y: 0 };
export function InquiryPhoto({
  url,
  urls = [url],
}: {
  url: string;
  urls?: string[];
}) {
  const [open, setOpen] = useState(false),
    [index, setIndex] = useState(0),
    [position, setPosition] = useState<Position>(fit),
    [failed, setFailed] = useState(false),
    [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLDivElement>(null),
    img = useRef<HTMLImageElement>(null),
    pointers = useRef(new Map<number, { x: number; y: number }>()),
    gesture = useRef<{
      points: { x: number; y: number }[];
      position: Position;
    } | null>(null),
    current = useRef(position);
  current.current = position;
  const reset = () => {
    setPosition(fit);
    setFailed(false);
    pointers.current.clear();
    gesture.current = null;
  };
  const change = (n: number) => {
    setIndex(Math.max(0, Math.min(urls.length - 1, n)));
    reset();
  };
  function bounded(p: Position) {
    const c = canvas.current,
      image = img.current;
    if (!c || !image?.naturalWidth) return p;
    const ratio = Math.min(
        c.clientWidth / image.naturalWidth,
        c.clientHeight / image.naturalHeight,
      ),
      scale = Math.min(4, Math.max(1, p.scale)),
      mx = Math.max(
        0,
        (image.naturalWidth * ratio * scale - c.clientWidth) / 2,
      ),
      my = Math.max(
        0,
        (image.naturalHeight * ratio * scale - c.clientHeight) / 2,
      );
    return {
      scale,
      x: Math.max(-mx, Math.min(mx, p.x)),
      y: Math.max(-my, Math.min(my, p.y)),
    };
  }
  function start() {
    gesture.current = {
      points: [...pointers.current.values()],
      position: current.current,
    };
  }
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const activePointers = pointers.current;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    const observer = new ResizeObserver(() => setPosition((p) => bounded(p)));
    if (canvas.current) observer.observe(canvas.current);
    return () => {
      document.body.style.overflow = old;
      window.removeEventListener("keydown", close);
      observer.disconnect();
      activePointers.clear();
      gesture.current = null;
      previousFocus?.focus();
    };
  }, [open]);
  return (
    <>
      <button
        className="mt-3 block rounded-lg border bg-slate-50 p-1"
        aria-label="添付写真を拡大"
        onClick={() => {
          setIndex(Math.max(0, urls.indexOf(url)));
          reset();
          setOpen(true);
        }}
      >
        <img
          src={url}
          alt="問い合わせの添付写真"
          className="h-32 w-40 rounded object-contain"
          loading="lazy"
        />
      </button>
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="添付写真"
            className="fixed inset-0 z-[100] flex flex-col bg-black text-white"
            style={{
              paddingTop: "env(safe-area-inset-top)",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          >
            <div className="flex items-center justify-between px-4 py-3">
              <span>
                {index + 1} / {urls.length}
              </span>
              <button
                autoFocus
                className="min-h-12 rounded-lg border border-white/40 px-5"
                onClick={() => setOpen(false)}
              >
                閉じる
              </button>
            </div>
            <div
              ref={canvas}
              className="relative min-h-0 flex-1 overflow-hidden"
              style={{ touchAction: "none" }}
              onDoubleClick={() =>
                setPosition((p) =>
                  p.scale > 1 ? fit : bounded({ scale: 2.5, x: 0, y: 0 }),
                )
              }
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                pointers.current.set(e.pointerId, {
                  x: e.clientX,
                  y: e.clientY,
                });
                start();
              }}
              onPointerMove={(e) => {
                if (!pointers.current.has(e.pointerId) || !gesture.current)
                  return;
                pointers.current.set(e.pointerId, {
                  x: e.clientX,
                  y: e.clientY,
                });
                const points = [...pointers.current.values()],
                  g = gesture.current;
                if (points.length === 2 && g.points.length === 2) {
                  const dist = (p: { x: number; y: number }[]) =>
                    Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
                  const scale = Math.min(
                    4,
                    Math.max(
                      1,
                      (g.position.scale * dist(points)) /
                        Math.max(1, dist(g.points)),
                    ),
                  );
                  const rect = e.currentTarget.getBoundingClientRect(),
                    cx = rect.left + rect.width / 2,
                    cy = rect.top + rect.height / 2;
                  const old = {
                      x: (g.points[0].x + g.points[1].x) / 2 - cx,
                      y: (g.points[0].y + g.points[1].y) / 2 - cy,
                    },
                    now = {
                      x: (points[0].x + points[1].x) / 2 - cx,
                      y: (points[0].y + points[1].y) / 2 - cy,
                    };
                  setPosition(
                    bounded({
                      scale,
                      x:
                        now.x -
                        ((old.x - g.position.x) * scale) / g.position.scale,
                      y:
                        now.y -
                        ((old.y - g.position.y) * scale) / g.position.scale,
                    }),
                  );
                } else if (
                  points.length === 1 &&
                  g.points.length === 1 &&
                  g.position.scale > 1
                ) {
                  setPosition(
                    bounded({
                      ...g.position,
                      x: g.position.x + points[0].x - g.points[0].x,
                      y: g.position.y + points[0].y - g.points[0].y,
                    }),
                  );
                }
              }}
              onPointerUp={(e) => {
                const g = gesture.current;
                if (
                  pointers.current.size === 1 &&
                  g?.points.length === 1 &&
                  g.position.scale === 1 &&
                  current.current.scale === 1
                ) {
                  const dx = e.clientX - g.points[0].x,
                    dy = e.clientY - g.points[0].y;
                  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
                    change(index + (dx < 0 ? 1 : -1));
                }
                pointers.current.delete(e.pointerId);
                start();
              }}
              onPointerCancel={(e) => {
                pointers.current.delete(e.pointerId);
                start();
              }}
            >
              {failed ? (
                <div className="grid h-full place-content-center gap-4 text-center">
                  <p>写真を読み込めませんでした。</p>
                  <button
                    className="rounded-lg border p-3"
                    onClick={() => {
                      setRetry((n) => n + 1);
                      setFailed(false);
                    }}
                  >
                    再読み込み
                  </button>
                </div>
              ) : (
                <img
                  ref={img}
                  key={index + ":" + retry}
                  src={urls[index]}
                  draggable={false}
                  alt={"添付写真 " + (index + 1)}
                  className="h-full w-full select-none object-contain"
                  style={{
                    transform: `translate(${position.x}px,${position.y}px) scale(${position.scale})`,
                    willChange: "transform",
                  }}
                  onError={() => setFailed(true)}
                />
              )}
            </div>
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <button
                disabled={index === 0}
                className="min-h-12 rounded-lg border px-4 disabled:opacity-30"
                onClick={() => change(index - 1)}
              >
                前へ
              </button>
              <button
                className="min-h-12 rounded-lg border px-4"
                onClick={() => setPosition(fit)}
              >
                全体を表示
              </button>
              <button
                disabled={index === urls.length - 1}
                className="min-h-12 rounded-lg border px-4 disabled:opacity-30"
                onClick={() => change(index + 1)}
              >
                次へ
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
