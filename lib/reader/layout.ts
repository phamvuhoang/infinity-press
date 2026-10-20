/**
 * The reader adapter, rather than the shell, creates a spread. Keeping this
 * small decision pure means resize observers and tests cannot drift apart.
 */
export function readerPageCount(width: number, desktopChoice: 1 | 2 = 2): 1 | 2 {
  return width >= 1280 ? desktopChoice : 1;
}
