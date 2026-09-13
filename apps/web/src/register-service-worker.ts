/** The one method this client needs; injected so the registration is testable without a browser. */
export interface ServiceWorkerContainerLike {
  register(url: string, options: { scope: string }): Promise<unknown>;
}

export async function registerServiceWorker(
  container: ServiceWorkerContainerLike | undefined,
  url: string,
  onError: (error: unknown) => void = () => undefined,
): Promise<boolean> {
  // A browser without service workers still gets a working client; it just does not work offline.
  if (container === undefined) return false;
  try {
    await container.register(url, { scope: '/' });
    return true;
  } catch (error) {
    // A refused registration (private mode, blocked storage) must not take the client down with it.
    onError(error);
    return false;
  }
}
