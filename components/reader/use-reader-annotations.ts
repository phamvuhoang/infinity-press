"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";

import { ReaderApiError } from "@/lib/reader/api-client";
import { parseAnnotationDraft, type AnnotationDraft, type AnnotationPatch, type ReaderAnnotation } from "@/lib/reader/annotations";

export type ReaderAnnotationItem = { key: string; annotation: ReaderAnnotation | AnnotationDraft; status: "synced" | "saving" | "unsynced"; unresolved: boolean };
export type ReaderAnnotationLoadState = "idle" | "loading" | "ready" | "error";
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
type Pending =
  | { type: "create"; draft: AnnotationDraft }
  | { type: "update"; id: string; patch: AnnotationPatch; previous: ReaderAnnotationItem }
  | { type: "remove"; id: string; previous: ReaderAnnotationItem; index: number };
const annotationResponse = z.object({ annotation: z.unknown() }).strict();
const annotationsResponse = z.object({ annotations: z.array(z.unknown()) }).strict();

function annotationFromDto(value: unknown): ReaderAnnotation {
  const data = z.object({ id: z.string().uuid(), publicationId: z.string().uuid(), createdAt: z.string(), updatedAt: z.string() }).passthrough().parse(value);
  const { id, publicationId, createdAt, updatedAt, ...draft } = data;
  return { ...parseAnnotationDraft(draft), id, publicationId, createdAt, updatedAt };
}
function emptyToNull(patch: AnnotationPatch): AnnotationPatch {
  return patch.kind === "highlight" && patch.noteText === "" ? { ...patch, noteText: null } : patch;
}
function key(): string { return crypto.randomUUID(); }
function patched(annotation: ReaderAnnotation, patch: AnnotationPatch): ReaderAnnotation {
  return annotation.kind === "highlight" && patch.kind === "highlight" ? { ...annotation, ...patch } : { ...annotation, ...patch } as ReaderAnnotation;
}
function draftPatch(draft: AnnotationDraft): AnnotationPatch {
  return draft.kind === "highlight"
    ? { kind: "highlight", color: draft.color, noteText: draft.noteText }
    : { kind: "bookmark", label: draft.label };
}

export function useReaderAnnotations({ publicationId, enabled, request, autoLoad = true }: { publicationId: string; enabled: boolean; request: Request; autoLoad?: boolean }) {
  const [items, setItems] = useState<ReaderAnnotationItem[]>([]);
  const [loadState, setLoadState] = useState<ReaderAnnotationLoadState>("idle");
  const [itemsPublication, setItemsPublication] = useState(publicationId);
  const [itemsEnabled, setItemsEnabled] = useState(enabled);
  const generation = useRef(0);
  const mounted = useRef(true);
  const pending = useRef(new Map<string, Pending>());
  const submitting = useRef(new Set<string>());
  const creating = useRef(new Set<string>());
  const publicationRef = useRef(publicationId);
  const enabledRef = useRef(enabled);
  const initialized = useRef(false);
  const loading = useRef<Promise<ReaderAnnotationItem[]> | null>(null);
  const isCurrent = useCallback((token: number, identity: string) => mounted.current && enabledRef.current && token === generation.current && publicationRef.current === identity, []);
  const collectionPath = `/api/reader/publications/${publicationId}/annotations`;

  // A layout effect runs before a queued promise continuation can update the committed new
  // publication. Rendering is nevertheless immediately scoped by `itemsPublication` below.
  useLayoutEffect(() => {
    enabledRef.current = enabled;
    if (!initialized.current) { initialized.current = true; return; }
    publicationRef.current = publicationId;
    generation.current += 1;
    pending.current.clear();
    loading.current = null;
    submitting.current.clear();
    creating.current.clear();
    queueMicrotask(() => {
      if (publicationRef.current !== publicationId) return;
      setItems([]);
      setLoadState(enabled ? "loading" : "idle");
      setItemsPublication(publicationId);
      setItemsEnabled(enabled);
    });
  }, [enabled, publicationId]);

  const reload = useCallback((): Promise<ReaderAnnotationItem[]> => {
    if (!enabled) { setLoadState("idle"); return Promise.resolve([]); }
    if (loading.current) return loading.current;
    const run = async (): Promise<ReaderAnnotationItem[]> => {
      const token = ++generation.current;
      setLoadState("loading");
      try {
        const response = annotationsResponse.parse(await request<{ annotations: unknown[] }>(collectionPath));
        const received = response.annotations.map(annotationFromDto);
        const next = received.map((annotation) => ({ key: key(), annotation, status: "synced" as const, unresolved: false }));
        if (!isCurrent(token, publicationId)) return [];
        setItemsPublication(publicationId);
        setItems(next);
        setLoadState("ready");
        return next;
      } catch (error) {
        if (!isCurrent(token, publicationId)) return [];
        setItemsPublication(publicationId);
        setItems([]); setLoadState("error");
        // The shared authenticated client has already torn the reader down for a definitive
        // refusal. Let its 401/404 reach the opening controller as well: returning an empty list
        // here would let the mount continuation publish a ready, released engine.
        if (error instanceof ReaderApiError && (error.status === 401 || error.status === 404)) throw error;
        return [];
      }
    };
    const promise = run();
    loading.current = promise;
    void promise.then(
      () => { if (loading.current === promise) loading.current = null; },
      () => { if (loading.current === promise) loading.current = null; },
    );
    return promise;
  }, [collectionPath, enabled, isCurrent, publicationId, request]);

  useEffect(() => {
    // Defer the initial network synchronisation so this effect subscribes to external work rather
    // than causing a synchronous render cascade. The cleanup also makes a Strict Mode probe inert.
    if (!autoLoad) return;
    const timer = window.setTimeout(() => void reload().catch(() => undefined), 0);
    return () => window.clearTimeout(timer);
  }, [autoLoad, reload]);
  useEffect(() => () => { mounted.current = false; generation.current += 1; }, []);
  useEffect(() => { mounted.current = true; }, [publicationId]);

  const execute = useCallback(async (itemKey: string, operation: Pending): Promise<void> => {
    if (!enabledRef.current || publicationRef.current !== publicationId) return;
    if (submitting.current.has(itemKey)) return;
    submitting.current.add(itemKey);
    pending.current.set(itemKey, operation);
    const token = generation.current;
    try {
      if (operation.type === "create") {
        let sentDraft = operation.draft;
        const response = annotationResponse.parse(await request<{ annotation: unknown }>(collectionPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sentDraft) }));
        let annotation = annotationFromDto(response.annotation);
        if (!isCurrent(token, publicationId)) return;
        // Save may edit the stable client row before POST returns. Keep that local draft visible
        // and serialize its updates after the server assigns an ID, including edits during PATCH.
        while (sentDraft !== operation.draft) {
          sentDraft = operation.draft;
          const local = { ...annotation, ...sentDraft } as ReaderAnnotation;
          setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation: local, status: "saving" } : item));
          try {
            const updated = annotationResponse.parse(await request<{ annotation: unknown }>(`/api/reader/annotations/${annotation.id}?publicationId=${publicationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draftPatch(sentDraft)) }));
            if (!isCurrent(token, publicationId)) return;
            annotation = annotationFromDto(updated.annotation);
          } catch {
            if (!isCurrent(token, publicationId)) return;
            // Creation succeeded: retry must PATCH this ID, never replay POST. Preserve the most
            // recent local note even when an edit arrived while the failed PATCH was in flight.
            const retained: ReaderAnnotationItem = { key: itemKey, annotation: { ...annotation, ...operation.draft } as ReaderAnnotation, status: "unsynced", unresolved: false };
            pending.current.set(itemKey, { type: "update", id: annotation.id, patch: draftPatch(operation.draft), previous: retained });
            setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation: retained.annotation, status: "unsynced" } : item));
            return;
          }
        }
        pending.current.delete(itemKey);
        setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation, status: "synced" } : item));
      } else if (operation.type === "update") {
        const response = annotationResponse.parse(await request<{ annotation: unknown }>(`/api/reader/annotations/${operation.id}?publicationId=${publicationId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation.patch) }));
        const annotation = annotationFromDto(response.annotation);
        if (!isCurrent(token, publicationId)) return;
        pending.current.delete(itemKey);
        setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation, status: "synced" } : item));
      } else {
        await request<unknown>(`/api/reader/annotations/${operation.id}?publicationId=${publicationId}`, { method: "DELETE" });
        if (!isCurrent(token, publicationId)) return;
        pending.current.delete(itemKey);
        setItems((previous) => previous.filter((item) => item.key !== itemKey));
      }
    } catch {
      if (!isCurrent(token, publicationId)) return;
      if (operation.type === "remove") {
        setItems((previous) => [...previous.slice(0, operation.index), { ...operation.previous, status: "unsynced" }, ...previous.slice(operation.index)]);
      } else if (operation.type === "update") {
        setItems((previous) => previous.map((item) => item.key === itemKey ? { ...operation.previous, status: "unsynced" } : item));
      } else {
        setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, status: "unsynced" } : item));
      }
    } finally { submitting.current.delete(itemKey); }
  }, [collectionPath, isCurrent, publicationId, request]);

  const create = useCallback(async (draft: AnnotationDraft) => {
    if (!enabledRef.current) return;
    const local = parseAnnotationDraft(draft.kind === "highlight" && draft.noteText === "" ? { ...draft, noteText: null } : draft);
    const fingerprint = JSON.stringify(local);
    if (creating.current.has(fingerprint)) return;
    creating.current.add(fingerprint);
    const itemKey = key();
    setItems((previous) => [...previous, { key: itemKey, annotation: local, status: "saving", unresolved: false }]);
    try { await execute(itemKey, { type: "create", draft: local }); } finally { creating.current.delete(fingerprint); }
  }, [execute]);
  const update = useCallback(async (itemKey: string, patch: AnnotationPatch) => {
    if (!enabledRef.current) return;
    const normalized = emptyToNull(patch);
    const creation = pending.current.get(itemKey);
    if (creation?.type === "create") {
      if (creation.draft.kind !== normalized.kind) return;
      const local = parseAnnotationDraft({ ...creation.draft, ...normalized });
      creation.draft = local;
      setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation: { ...item.annotation, ...local } as ReaderAnnotation | AnnotationDraft } : item));
      return;
    }
    if (submitting.current.has(itemKey)) return;
    const item = items.find((candidate) => candidate.key === itemKey);
    if (!item || !("id" in item.annotation)) return;
    if (item.annotation.kind !== normalized.kind) return;
    setItems((previous) => previous.map((candidate) => candidate.key === itemKey ? { ...candidate, annotation: patched(item.annotation as ReaderAnnotation, normalized), status: "saving" } : candidate));
    await execute(itemKey, { type: "update", id: item.annotation.id, patch: normalized, previous: item });
  }, [execute, items]);
  const remove = useCallback(async (itemKey: string) => {
    if (!enabledRef.current) return;
    if (submitting.current.has(itemKey)) return;
    const item = items.find((candidate) => candidate.key === itemKey);
    if (!item) return;
    if (!("id" in item.annotation)) { pending.current.delete(itemKey); setItems((previous) => previous.filter((candidate) => candidate.key !== itemKey)); return; }
    const index = items.findIndex((candidate) => candidate.key === itemKey);
    setItems((previous) => previous.filter((candidate) => candidate.key !== itemKey));
    await execute(itemKey, { type: "remove", id: item.annotation.id, previous: item, index });
  }, [execute, items]);
  const retry = useCallback(async (itemKey: string) => {
    if (!enabledRef.current) return;
    if (submitting.current.has(itemKey)) return;
    const operation = pending.current.get(itemKey); if (!operation) return;
    if (operation.type === "remove") setItems((previous) => previous.filter((item) => item.key !== itemKey));
    else if (operation.type === "update") setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, annotation: patched(operation.previous.annotation as ReaderAnnotation, operation.patch), status: "saving" } : item));
    else setItems((previous) => previous.map((item) => item.key === itemKey ? { ...item, status: "saving" } : item));
    await execute(itemKey, operation);
  }, [execute]);
  const setUnresolvedIds = useCallback((ids: string[]) => {
    const unresolved = new Set(ids);
    setItems((previous) => {
      let changed = false;
      const next = previous.map((item) => {
        const nextUnresolved = unresolved.has(item.key) || ("id" in item.annotation && unresolved.has(item.annotation.id));
        if (nextUnresolved !== item.unresolved) changed = true;
        return nextUnresolved === item.unresolved ? item : { ...item, unresolved: nextUnresolved };
      });
      return changed ? next : previous;
    });
  }, []);
  const active = enabled && itemsEnabled === enabled && itemsPublication === publicationId;
  return { items: active ? items : [], loadState: active ? loadState : "idle", reload, create, update, remove, retry, setUnresolvedIds };
}
