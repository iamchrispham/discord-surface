export class TransportRejection {
  #failure: { reason: unknown } | undefined;

  capture(reason: unknown): void {
    this.#failure = { reason };
  }

  get rejected(): boolean {
    return this.#failure !== undefined;
  }

  get reason(): unknown {
    return this.#failure?.reason;
  }
}
