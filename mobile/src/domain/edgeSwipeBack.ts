export const BACK_EDGE_WIDTH = 28;

/** Only a deliberate rightward swipe beginning at the left edge can navigate back. */
export class EdgeSwipeBackGesture {
  private origin: { x: number; y: number } | null = null;
  private threshold = 96;
  private width = 0;
  active = false;
  distance = 0;

  begin(x: number, y: number, width: number, enabled = true): boolean {
    this.cancel();
    if (!enabled || x < 0 || x > BACK_EDGE_WIDTH || width <= 0) return false;
    this.origin = { x, y }; this.width = width;
    this.threshold = Math.min(96, Math.max(64, width * .24));
    return true;
  }

  move(x: number, y: number): boolean {
    if (!this.origin) return false;
    const dx = x - this.origin.x, dy = Math.abs(y - this.origin.y);
    if (dx < -6 || (dy >= 8 && dy >= Math.max(8, dx * .8))) {
      this.cancel(); return false;
    }
    if (!this.active && (dx < 8 || dx < dy * 1.4)) return false;
    this.active = true; this.distance = Math.min(this.width, Math.max(0, dx));
    return true;
  }

  release(): boolean {
    const back = this.active && this.distance >= this.threshold;
    this.cancel(); return back;
  }

  cancel() { this.origin = null; this.active = false; this.distance = 0; }
}
