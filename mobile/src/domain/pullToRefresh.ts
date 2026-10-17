export const PULL_THRESHOLD = 64;
export const MAX_PULL_DISTANCE = 96;

/** A pull must start at the top; ordinary scrolling, taps and sideways swipes stay untouched. */
export class PullToRefreshGesture {
  private origin: { x: number; y: number } | null = null;
  active = false;
  distance = 0;

  begin(x: number, y: number, scrollTop: number, blocked = false) {
    this.cancel();
    if (!blocked && scrollTop <= 1) this.origin = { x, y };
  }

  move(x: number, y: number, scrollTop: number): boolean {
    if (!this.origin) return false;
    const dx = x - this.origin.x, dy = y - this.origin.y;
    if (scrollTop > 1 || (!this.active && (dy < -8 || (Math.abs(dx) > 8 && Math.abs(dx) >= dy)))) {
      this.cancel(); return false;
    }
    // Claim the first downward touch move before Safari starts its own rubber-band scroll.
    // The visible indicator still waits for an intentional 10px pull.
    if (!this.active && dy < 10) return dy > 0 && dy >= Math.abs(dx);
    this.active = true;
    this.distance = Math.min(MAX_PULL_DISTANCE, Math.max(0, dy) * .5);
    return true;
  }

  release(): boolean {
    const refresh = this.active && this.distance >= PULL_THRESHOLD;
    this.cancel();
    return refresh;
  }

  cancel() { this.origin = null; this.active = false; this.distance = 0; }
}
