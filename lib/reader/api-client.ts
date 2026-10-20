export class ReaderApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Reader request failed with status ${status}.`);
    this.name = "ReaderApiError";
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

// Rejects with the signal's reason once it aborts, whatever `work` is still waiting on.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createReaderApiClient(input: {
  publicationId: string;
  remint: () => Promise<void>;
  onLostAccess: (status: 401 | 404) => void;
}): { request<T>(path: string, init?: RequestInit): Promise<T> } {
  let reminting: Promise<void> | null = null;
  let sessionGeneration = 0;
  let lostAccess: 401 | 404 | null = null;
  const activeRequests = new Set<AbortController>();

  function reportLostAccess(status: 401 | 404) {
    if (lostAccess !== null) return;
    lostAccess = status;
    for (const controller of activeRequests) controller.abort();
    input.onLostAccess(status);
  }

  function remintOnce(): Promise<void> {
    if (reminting) return reminting;
    const current = Promise.resolve()
      .then(input.remint)
      .then(() => {
        sessionGeneration += 1;
      });
    reminting = current;
    void current.then(
      () => {
        if (reminting === current) reminting = null;
      },
      () => {
        if (reminting === current) reminting = null;
      },
    );
    return current;
  }

  async function fetchOnce(path: string, init: RequestInit): Promise<Response> {
    if (lostAccess !== null) throw new ReaderApiError(lostAccess);
    const controller = new AbortController();
    const suppliedSignal = init.signal;
    const abort = () => controller.abort(suppliedSignal?.reason);
    if (suppliedSignal?.aborted) abort();
    else suppliedSignal?.addEventListener("abort", abort, { once: true });
    activeRequests.add(controller);

    try {
      return await fetch(path, {
        ...init,
        credentials: "same-origin",
        signal: controller.signal,
      });
    } finally {
      activeRequests.delete(controller);
      suppliedSignal?.removeEventListener("abort", abort);
    }
  }

  // The caller's deadline covers the whole request: headers, a remint, and reading the body.
  function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return untilAborted(requestOnce<T>(path, init), init.signal);
  }

  async function requestOnce<T>(path: string, init: RequestInit): Promise<T> {
    const requestGeneration = sessionGeneration;
    let response = await fetchOnce(path, init);
    if (lostAccess !== null) throw new ReaderApiError(lostAccess);
    if (response.status === 401) {
      reportLostAccess(401);
      throw new ReaderApiError(401);
    }

    if (response.status === 404) {
      try {
        if (requestGeneration === sessionGeneration) await untilAborted(remintOnce(), init.signal);
      } catch (error) {
        // The caller gave up (for example a timeout); that says nothing about the session.
        if (init.signal?.aborted) throw error;
        if (!isAbortError(error) && !(error instanceof ReaderApiError && error.status === 502)) {
          reportLostAccess(error instanceof ReaderApiError && error.status === 401 ? 401 : 404);
        }
        throw error;
      }

      response = await fetchOnce(path, init);
      if (response.status === 401) {
        reportLostAccess(401);
        throw new ReaderApiError(401);
      }
      if (response.status === 404) {
        reportLostAccess(404);
        throw new ReaderApiError(404);
      }
    }

    if (!response.ok) throw new ReaderApiError(response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return { request };
}
