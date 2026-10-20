import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { CatalogFilterOptions, CatalogFilters } from "@/lib/catalog/browse";
import type { Dictionary } from "@/lib/i18n/dictionary";

type Copy = Dictionary["catalog"]["books"];

// A plain GET form. It needs no client JavaScript, and filters live in the URL.
export function CatalogFilterForm({
  action,
  clearHref,
  filters,
  options,
  copy,
}: {
  action: string;
  clearHref: string;
  filters: CatalogFilters;
  options: CatalogFilterOptions;
  copy: Copy;
}) {
  const selects = [
    { name: "topic", label: copy.topic, value: filters.topic, entries: options.topics },
    { name: "author", label: copy.author, value: filters.author, entries: options.authors },
    { name: "series", label: copy.series, value: filters.series, entries: options.series },
  ] as const;

  return (
    <form action={action} aria-label={copy.filtersTitle} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto] lg:items-end" method="get">
      {selects.map((select) => (
        <div className="space-y-2" key={select.name}>
          <Label htmlFor={`filter-${select.name}`}>{select.label}</Label>
          <NativeSelect defaultValue={select.value ?? ""} id={`filter-${select.name}`} name={select.name}>
            <option value="">{copy.any}</option>
            {select.entries.map((entry) => (
              <option key={entry.slug} value={entry.slug}>
                {entry.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ))}
      <div className="space-y-2">
        <Label htmlFor="filter-price">{copy.price}</Label>
        <NativeSelect defaultValue={filters.price ?? ""} id="filter-price" name="price">
          <option value="">{copy.any}</option>
          <option value="free">{copy.free}</option>
          <option value="paid">{copy.paid}</option>
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="filter-sort">{copy.sort}</Label>
        <NativeSelect defaultValue={filters.sort} id="filter-sort" name="sort">
          <option value="featured">{copy.sortFeatured}</option>
          <option value="newest">{copy.sortNewest}</option>
          <option value="title">{copy.sortTitle}</option>
        </NativeSelect>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit">{copy.apply}</Button>
        <Link className="inline-flex min-h-11 items-center text-sm text-forest underline underline-offset-4" href={clearHref}>
          {copy.clear}
        </Link>
      </div>
    </form>
  );
}
