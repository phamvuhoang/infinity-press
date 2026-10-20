const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isSecureOrLoopbackUrl(value: string) {
  const url = parse(value);
  return url !== null && (url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname)));
}

// next/image refuses to optimize images from loopback hosts, so local covers render unoptimized.
export function isLoopbackUrl(value: string) {
  const url = parse(value);
  return url !== null && loopbackHosts.has(url.hostname);
}
