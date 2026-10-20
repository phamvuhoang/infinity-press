import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useReaderAnnotations } from "@/components/reader/use-reader-annotations";
import type { AnnotationDraft, ReaderAnnotation } from "@/lib/reader/annotations";

const publicationId = "c0000000-0000-4000-8000-000000000001";
const locator = { href: "/chapter.xhtml", progression: 0, totalProgression: 0, locations: { position: 1 }, text: { highlight: "A line" } };
const draft: AnnotationDraft = { kind: "highlight", locator, selectedText: "A line", color: "yellow", noteText: null };
const saved: ReaderAnnotation = { ...draft, id: "d0000000-0000-4000-8000-000000000001", publicationId, createdAt: "now", updatedAt: "now" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("useReaderAnnotations", () => {
  it("preserves an edit during create and sends it after the server assigns an ID", async () => {
    const creation = deferred<{ annotation: ReaderAnnotation }>();
    const patch = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn().mockReturnValueOnce(creation.promise).mockReturnValueOnce(patch.promise);
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    let creating!: Promise<void>;
    act(() => { creating = result.current.create(draft); });
    const itemKey = result.current.items[0].key;
    await act(() => result.current.update(itemKey, { kind: "highlight", noteText: "My pending note" }));
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { noteText: "My pending note" }, status: "saving" });
    await act(async () => { creation.resolve({ annotation: saved }); await creation.promise; });
    expect(request).toHaveBeenLastCalledWith(`/api/reader/annotations/${saved.id}?publicationId=${publicationId}`, expect.objectContaining({ method: "PATCH", body: JSON.stringify({ kind: "highlight", color: "yellow", noteText: "My pending note" }) }));
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { id: saved.id, noteText: "My pending note" }, status: "saving" });
    await act(async () => { patch.resolve({ annotation: { ...saved, noteText: "My pending note" } }); await creating; });
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { noteText: "My pending note" }, status: "synced" });
  });

  it("merges an edit into a failed create so retry sends the edited draft", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ annotation: { ...saved, noteText: "My retry note" } });
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    await act(() => result.current.create(draft));
    const itemKey = result.current.items[0].key;
    await act(() => result.current.update(itemKey, { kind: "highlight", noteText: "My retry note" }));
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { noteText: "My retry note" }, status: "unsynced" });
    await act(() => result.current.retry(itemKey));
    expect(request).toHaveBeenLastCalledWith(`/api/reader/publications/${publicationId}/annotations`, expect.objectContaining({ method: "POST", body: JSON.stringify({ ...draft, noteText: "My retry note" }) }));
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { noteText: "My retry note" }, status: "synced" });
  });

  it("keeps a queued note after its follow-up update fails and retries the server row without another create", async () => {
    const creation = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn().mockReturnValueOnce(creation.promise).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ annotation: { ...saved, noteText: "Recover my note" } });
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    let creating!: Promise<void>;
    act(() => { creating = result.current.create(draft); });
    const itemKey = result.current.items[0].key;
    await act(() => result.current.update(itemKey, { kind: "highlight", noteText: "Recover my note" }));
    await act(async () => { creation.resolve({ annotation: saved }); await creating; });
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { id: saved.id, noteText: "Recover my note" }, status: "unsynced" });
    await act(() => result.current.retry(itemKey));
    expect(request.mock.calls.map((call) => call[1].method)).toEqual(["POST", "PATCH", "PATCH"]);
    expect(result.current.items[0]).toMatchObject({ key: itemKey, annotation: { noteText: "Recover my note" }, status: "synced" });
  });

  it("clears private rows and prevents new mutations when disabled", async () => {
    const request = vi.fn().mockResolvedValue({ annotations: [saved] });
    const { result, rerender } = renderHook(({ enabled }) => useReaderAnnotations({ publicationId, enabled, request }), { initialProps: { enabled: true } });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    rerender({ enabled: false });
    expect(result.current.items).toEqual([]);
    await act(() => result.current.create(draft));
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.current.items).toEqual([]);
  });
  it("starts the new publication load while the old publication request is still pending", async () => {
    const oldLoad = deferred<{ annotations: ReaderAnnotation[] }>();
    const nextPublication = "c0000000-0000-4000-8000-000000000002";
    const nextRow = { ...saved, publicationId: nextPublication };
    const request = vi.fn().mockReturnValueOnce(oldLoad.promise).mockResolvedValueOnce({ annotations: [nextRow] });
    const { result, rerender } = renderHook(({ id }) => useReaderAnnotations({ publicationId: id, enabled: true, request }), { initialProps: { id: publicationId } });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender({ id: nextPublication });
    await waitFor(() => expect(result.current.items).toMatchObject([{ annotation: nextRow }]));
    expect(request).toHaveBeenLastCalledWith(`/api/reader/publications/${nextPublication}/annotations`);
    await act(async () => { oldLoad.resolve({ annotations: [saved] }); await oldLoad.promise; });
    expect(result.current.items).toMatchObject([{ annotation: nextRow }]);
    expect(result.current.loadState).toBe("ready");
  });
  it("replaces an optimistic client row when creation succeeds", async () => {
    const create = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn((path: string) => path === `/api/reader/publications/${publicationId}/annotations` ? create.promise : Promise.resolve({ annotations: [] }));
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request: request as never }));

    let pending!: Promise<void>;
    act(() => { pending = result.current.create(draft); });
    expect(result.current.items).toMatchObject([{ annotation: draft, status: "saving" }]);
    await act(async () => { create.resolve({ annotation: saved }); await pending; });
    expect(result.current.items).toEqual([{ key: expect.any(String), annotation: saved, status: "synced", unresolved: false }]);
  });

  it("keeps a failed create in memory and retries its exact draft", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ annotation: saved });
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    await act(() => result.current.create(draft));
    expect(result.current.items[0]).toMatchObject({ annotation: draft, status: "unsynced" });
    await act(() => result.current.retry(result.current.items[0].key));
    expect(result.current.items[0]).toMatchObject({ annotation: saved, status: "synced" });
  });

  it("restores a recoverable item after a failed update or delete", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ annotations: [saved] })
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(() => result.current.update(result.current.items[0].key, { kind: "highlight", color: "green" }));
    expect(result.current.items[0]).toMatchObject({ annotation: saved, status: "unsynced" });
    await act(() => result.current.remove(result.current.items[0].key));
    expect(result.current.items[0]).toMatchObject({ annotation: saved, status: "unsynced" });
  });

  it("optimistically changes a highlight and rolls it back when the deferred update fails", async () => {
    const update = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn().mockResolvedValueOnce({ annotations: [saved] }).mockReturnValueOnce(update.promise);
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const itemKey = result.current.items[0].key;
    act(() => { void result.current.update(itemKey, { kind: "highlight", color: "green" }); });
    expect(result.current.items[0]).toMatchObject({ status: "saving", annotation: { color: "green" } });
    await act(async () => { update.reject(new Error("offline")); await Promise.resolve(); });
    expect(result.current.items[0]).toMatchObject({ status: "unsynced", annotation: saved });
  });

  it("removes an item immediately and restores it for retry when a deferred delete fails", async () => {
    const deletion = deferred<unknown>();
    const request = vi.fn().mockResolvedValueOnce({ annotations: [saved] }).mockReturnValueOnce(deletion.promise);
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => { void result.current.remove(result.current.items[0].key); });
    expect(result.current.items).toEqual([]);
    await act(async () => { deletion.reject(new Error("offline")); await Promise.resolve(); });
    expect(result.current.items[0]).toMatchObject({ status: "unsynced", annotation: saved });
  });

  it("does not apply a second same-row transition while a deferred update is in flight", async () => {
    const update = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn().mockResolvedValueOnce({ annotations: [saved] }).mockReturnValueOnce(update.promise);
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    const itemKey = result.current.items[0].key;
    act(() => { void result.current.update(itemKey, { kind: "highlight", color: "green" }); void result.current.remove(itemKey); });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.items).toMatchObject([{ key: itemKey, status: "saving", annotation: { color: "green" } }]);
    await act(async () => { update.reject(new Error("offline")); await Promise.resolve(); });
    expect(result.current.items).toMatchObject([{ key: itemKey, status: "unsynced", annotation: saved }]);
  });

  it("discards an unsaved item locally without sending a delete", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    await act(() => result.current.create(draft));
    await act(() => result.current.remove(result.current.items[0].key));
    expect(result.current.items).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate a submission when an action is clicked repeatedly", async () => {
    const create = deferred<{ annotation: ReaderAnnotation }>();
    const request = vi.fn().mockReturnValue(create.promise);
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, autoLoad: false, request }));
    act(() => { void result.current.create(draft); void result.current.create(draft); });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores late work after the publication changes or unmounts", async () => {
    const load = deferred<{ annotations: ReaderAnnotation[] }>();
    const request = vi.fn().mockReturnValue(load.promise);
    const { result, rerender, unmount } = renderHook(({ id }) => useReaderAnnotations({ publicationId: id, enabled: true, request }), { initialProps: { id: publicationId } });
    rerender({ id: "c0000000-0000-4000-8000-000000000002" });
    unmount();
    await act(async () => { load.resolve({ annotations: [saved] }); await Promise.resolve(); });
    expect(result.current.items).toEqual([]);
  });

  it("clears old publication rows synchronously and ignores its late mutation response", async () => {
    const update = deferred<{ annotation: ReaderAnnotation }>();
    const nextPublication = "c0000000-0000-4000-8000-000000000002";
    const request = vi.fn().mockResolvedValueOnce({ annotations: [saved] }).mockReturnValueOnce(update.promise);
    const { result, rerender } = renderHook(({ id }) => useReaderAnnotations({ publicationId: id, enabled: true, request }), { initialProps: { id: publicationId } });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => { void result.current.update(result.current.items[0].key, { kind: "highlight", color: "green" }); });
    rerender({ id: nextPublication });
    expect(result.current.items).toEqual([]);
    await act(async () => { update.resolve({ annotation: { ...saved, color: "green", publicationId } }); await Promise.resolve(); });
    expect(result.current.items).toEqual([]);
  });

  it("normalizes an empty note to null and preserves unresolvable stored annotations", async () => {
    const request = vi.fn().mockResolvedValueOnce({ annotations: [saved] }).mockResolvedValueOnce({ annotation: { ...saved, noteText: null } });
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    act(() => result.current.setUnresolvedIds([saved.id]));
    expect(result.current.items[0]).toMatchObject({ unresolved: true, annotation: saved });
    await act(() => result.current.update(result.current.items[0].key, { kind: "highlight", noteText: "" }));
    expect(request).toHaveBeenLastCalledWith(expect.stringContaining(saved.id), expect.objectContaining({ body: JSON.stringify({ kind: "highlight", noteText: null }) }));
  });

  it("surfaces a scoped load error instead of admitting malformed server data", async () => {
    const request = vi.fn().mockResolvedValue({ annotations: [{ ...saved, selectedText: "other" }] });
    const { result } = renderHook(() => useReaderAnnotations({ publicationId, enabled: true, request }));
    await waitFor(() => expect(result.current.loadState).toBe("error"));
    expect(result.current.items).toEqual([]);
  });
});
