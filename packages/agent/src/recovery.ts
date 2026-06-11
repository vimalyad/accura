/**
 * Recovery policy enforced in code, not just prompted: prompt rules degrade
 * as context grows, so the two highest-impact loop-breakers are hard rules.
 *
 *  - an identical action (same name + params) that failed twice is forbidden;
 *  - three consecutive steps on the same URL with no successful action
 *    triggers an explicit change-approach demand.
 */
export class RecoveryPolicy {
  private readonly failureCounts = new Map<string, number>();
  private urlHistory: Array<{ url: string; anySuccess: boolean }> = [];

  private keyFor(name: string, params: unknown): string {
    return `${name}:${JSON.stringify(params ?? {})}`;
  }

  noteResult(name: string, params: unknown, ok: boolean): void {
    const key = this.keyFor(name, params);
    if (ok) {
      this.failureCounts.delete(key);
    } else {
      this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1);
    }
  }

  isForbidden(name: string, params: unknown): boolean {
    return (this.failureCounts.get(this.keyFor(name, params)) ?? 0) >= 2;
  }

  noteStep(url: string, anySuccess: boolean): void {
    this.urlHistory.push({ url, anySuccess });
    if (this.urlHistory.length > 5) this.urlHistory.shift();
  }

  isStuck(): boolean {
    if (this.urlHistory.length < 3) return false;
    const recent = this.urlHistory.slice(-3);
    const sameUrl = recent.every((entry) => entry.url === recent[0]!.url);
    const noProgress = recent.every((entry) => !entry.anySuccess);
    return sameUrl && noProgress;
  }

  /** Injected into the prompt each step; empty when there is nothing to say. */
  advice(): string[] {
    const lines: string[] = [];
    for (const [key, count] of this.failureCounts) {
      if (count >= 2) {
        lines.push(
          `FORBIDDEN (failed ${count}x): ${key} - this exact action is blocked. Use a different element or approach.`,
        );
      }
    }
    if (this.isStuck()) {
      lines.push(
        'STUCK: 3 steps on the same URL with no successful action. You MUST change strategy: scroll, use findText, navigate elsewhere, or reconsider the task.',
      );
    }
    return lines;
  }
}
