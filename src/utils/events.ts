/**
 * Event Emitter - Type-safe event handling
 */

type EventCallback<T = unknown> = (data: T) => void;

export class EventEmitter<
  Events extends Record<string, unknown> = Record<string, unknown>,
> {
  private listeners = new Map<keyof Events, Set<EventCallback<unknown>>>();

  /**
   * Subscribe to an event.
   */
  on<K extends keyof Events>(
    event: K,
    callback: EventCallback<Events[K]>,
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event)!.add(callback as EventCallback<unknown>);

    // Return unsubscribe function
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event once.
   */
  once<K extends keyof Events>(
    event: K,
    callback: EventCallback<Events[K]>,
  ): () => void {
    const wrapper: EventCallback<Events[K]> = (data) => {
      this.off(event, wrapper);
      callback(data);
    };

    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event.
   */
  off<K extends keyof Events>(
    event: K,
    callback: EventCallback<Events[K]>,
  ): void {
    this.listeners.get(event)?.delete(callback as EventCallback<unknown>);
  }

  /**
   * Emit an event.
   */
  emit<K extends keyof Events>(event: K, data: Events[K]): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const callback of callbacks) {
        try {
          callback(data);
        } catch (error) {
          console.error(
            `Error in event handler for "${String(event)}":`,
            error,
          );
        }
      }
    }
  }

  /**
   * Remove all listeners for an event, or all events if no event specified.
   */
  removeAllListeners(event?: keyof Events): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  /**
   * Get the number of listeners for an event.
   */
  listenerCount(event: keyof Events): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
