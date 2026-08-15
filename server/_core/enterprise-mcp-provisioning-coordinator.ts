type ProvisioningEntry = {
  expiresAt: number;
  promise: Promise<void>;
};

export class EnterpriseMcpProvisioningCoordinator {
  private readonly entries = new Map<string, ProvisioningEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  ensure(fingerprint: string, provision: () => Promise<void>): Promise<void> {
    const key = String(fingerprint || "").trim();
    if (!key) return provision();

    const current = this.entries.get(key);
    if (current && current.expiresAt > this.now()) return current.promise;
    if (current) this.entries.delete(key);

    const promise = provision()
      .then(() => undefined)
      .catch((error) => {
        const active = this.entries.get(key);
        if (active?.promise === promise) this.entries.delete(key);
        throw error;
      });
    this.entries.set(key, {
      expiresAt: this.now() + this.ttlMs,
      promise,
    });
    return promise;
  }

  clear(fingerprint?: string): void {
    const key = String(fingerprint || "").trim();
    if (key) this.entries.delete(key);
    else this.entries.clear();
  }
}

