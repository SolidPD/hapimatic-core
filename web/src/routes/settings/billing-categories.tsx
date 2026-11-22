// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BillingCategoriesPage — `/settings/billing-categories` (issue #6779, plan
 * section 6). The one list of billing categories, each with an optional
 * default hourly rate. Editable on the node that keeps the list while the
 * billable gate is `on`; read-only while it is `closed` and on every other node,
 * which reads the list through the owner (`place.kind === "owner"`).
 *
 * Facts of PR-1 that bind it: a reader's list can be shorter than the owner's
 * (a category whose rate currency its table lacks is left out), so nothing here
 * assumes a category seen earlier is still present; `defaultCategoryId` can be
 * null, and then no row is marked Default; and the list's own currency is
 * passed on unchanged, so it is checked with `isBillingCurrency` before any
 * money helper sees it (PR2-R3).
 *
 * Registered in BOTH `router.tsx` (route) and `settings/index.tsx` (menu row).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Tags } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  billingCurrencies,
  isBillingCurrency,
  type BillingCategoryList,
  type BillingCategoryListItem,
} from "@hapi/protocol";
import {
  SettingsSectionHeader,
  TitleChip,
} from "@/components/settings/SettingsSectionHeader";
import { SettingsPage } from "@/components/layouts/SettingsPage";
import { SettingsRow } from "@/components/ui/SettingsRow";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CollapsibleSection } from "@/components/ui/CollapsibleSection";
import {
  SortableListEntry,
  splitDragHandle,
} from "@/components/SessionList/SortableListEntry";
import {
  DRAG_ACTIVATION,
  GuardedPointerSensor,
  GuardedTouchSensor,
} from "@/components/SessionList/guardedDragSensors";
import {
  BillingCategoryRow,
  unknownCurrencyTitle,
} from "@/components/billingCategories/BillingCategoryRow";
import {
  BillingCategoryEditor,
  EDITOR_INLINE_FAILURES,
} from "@/components/billingCategories/BillingCategoryEditor";
import { BillingCategoryHistoryList } from "@/components/billingCategories/BillingCategoryHistoryList";
import { NotFoundPage } from "@/components/NotFoundPage";
import {
  BILLING_CLOSED_LINE,
  billingCategoryFailureMessage,
  describeBillingCategoryFailure,
  useBillingCategoryList,
  useBillingCategoryWrite,
  type BillingCategoryWriteOutcome,
  type BillingCategoryWriteRequest,
} from "@/hooks/queries/useBillingCategories";
import { useToast } from "@/components/Toast";
import { useVersion } from "@/hooks/useVersion";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";
import { resolveNodeHref } from "@/lib/nodeSwitcher";
import { moveCategory } from "@/lib/billingCategoryOrder";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useEmojiFavicon } from "@/hooks/useEmojiFavicon";
import type { ApiClient } from "@/api/client";

const ACCENT = "var(--accent-amber-300)";
const PAGE_PATH = "/settings/billing-categories";

/** The owner's web address for "Open on <owner>", or null to hide the button. */
function useOwnerHref(
  api: ApiClient | null,
  ownerNodeId: string | null
): string | null {
  const { data } = useQuery({
    queryKey: queryKeys.federationNodes,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getFederationNodes();
    },
    enabled: Boolean(api) && ownerNodeId !== null,
    staleTime: 60_000,
    retry: 1,
  });
  if (!ownerNodeId) return null;
  const node = data?.nodes?.find(n => n.config.id === ownerNodeId);
  if (!node || node.status === "offline") return null;
  let href = resolveNodeHref(node);
  if (!href) return null;
  while (href.endsWith("/")) href = href.slice(0, -1);
  return `${href}${PAGE_PATH}`;
}

function offeredOf(list: BillingCategoryList): BillingCategoryListItem[] {
  return list.local.categories
    .filter(c => c.retiredAt === null)
    .sort((a, b) => a.position - b.position);
}

/**
 * The route's gate (ruling GATEOFF-1): with billable sessions off (no
 * `billableSwitch` on the version answer) both addresses show the app's own
 * not-found view, as an address it does not know, and nothing names the
 * feature while the version answer is still loading.
 */
export default function BillingCategoriesPage() {
  const version = useVersion();
  if (version.isPending) return null;
  const mode = version.data?.billableSwitch;
  if (mode === undefined) return <NotFoundPage />;
  return <BillingCategoriesView mode={mode} />;
}

function BillingCategoriesView({ mode }: { mode: "on" | "closed" }) {
  useDocumentTitle("Billing Categories - Hapimatic");
  useEmojiFavicon(null);
  const { api } = useAppContext();
  const listQuery = useBillingCategoryList(api);
  const { write, pending } = useBillingCategoryWrite(api);
  const list = listQuery.data;
  const place = list?.place;
  const ownerNodeId = place?.kind === "owner" ? place.nodeId : null;
  const ownerHref = useOwnerHref(api, ownerNodeId);

  // The dialog holds the edited category's id, and reads the category from the
  // list as it stands, so a reread after a stale token reaches it (F1).
  const [editing, setEditing] = useState<
    { kind: "add" } | { kind: "edit"; id: string } | null
  >(null);
  const [retiring, setRetiring] = useState<BillingCategoryListItem | null>(
    null
  );
  const menuRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const addRef = useRef<HTMLButtonElement | null>(null);

  const sensors = useSensors(
    useSensor(GuardedPointerSensor, { activationConstraint: DRAG_ACTIVATION }),
    useSensor(GuardedTouchSensor, { activationConstraint: DRAG_ACTIVATION })
  );

  const offered = useMemo(() => (list ? offeredOf(list) : []), [list]);
  const retired = useMemo(
    () => (list ? list.local.categories.filter(c => c.retiredAt !== null) : []),
    [list]
  );
  const names = useMemo(
    () => new Map((list?.local.categories ?? []).map(c => [c.id, c.name])),
    [list]
  );
  const editable = mode === "on" && place?.kind === "local";
  const defaultId = list?.local.defaultCategoryId ?? null;
  const editingCategory =
    editing?.kind === "edit"
      ? (offered.find(c => c.id === editing.id) ?? null)
      : null;
  // The dialog shows only while the page is editable: a save that finds the
  // gate closed or the list kept elsewhere closes it, and the page says why (F2).
  const dialogOpen =
    editable &&
    editing !== null &&
    list !== undefined &&
    (editing.kind === "add" || editingCategory !== null);
  useEffect(() => {
    if (editing !== null && !dialogOpen) setEditing(null);
  }, [editing, dialogOpen]);

  const queryClient = useQueryClient();
  const { showToast } = useToast();
  /**
   * The dialog's save. A stale token rereads the list before the write
   * resolves; when the reread list has retired the category or no longer holds
   * it, the dialog closes as on a 404, with its reason (F1).
   */
  const saveEdit = async (
    request: BillingCategoryWriteRequest
  ): Promise<BillingCategoryWriteOutcome> => {
    const outcome = await write(request, EDITOR_INLINE_FAILURES);
    if (outcome.ok || outcome.failure.kind !== "stale") return outcome;
    if (request.op !== "update") return outcome;
    const reread = queryClient.getQueryData<BillingCategoryList>(
      queryKeys.billingCategories
    );
    const now = reread?.local.categories.find(c => c.id === request.id);
    if (now && now.retiredAt === null) return outcome;
    showToast(
      billingCategoryFailureMessage(
        now
          ? { kind: "refused", code: "category_retired" }
          : { kind: "not-found" }
      ),
      { type: "error" }
    );
    return { ok: false, failure: { kind: "not-found" } };
  };

  const reorder = (id: string, toIndex: number) => {
    const ids = offered.map(c => c.id);
    const next = moveCategory(ids, id, toIndex);
    if (next.join("\0") === ids.join("\0")) return;
    void write({ op: "order", ids: next });
  };

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const toIndex = offered.findIndex(c => c.id === String(over.id));
    if (toIndex >= 0) reorder(String(active.id), toIndex);
  };

  const confirmRetire = async () => {
    if (!retiring) return;
    const ids = offered.map(c => c.id);
    const nextId = ids[ids.indexOf(retiring.id) + 1] ?? null;
    const outcome = await write({
      op: "update",
      id: retiring.id,
      retired: true,
    });
    setRetiring(null);
    if (outcome.ok) {
      // Focus the next row's actions menu, or Add when no row follows.
      requestAnimationFrame(() => {
        const target =
          (nextId && menuRefs.current.get(nextId)) || addRef.current;
        target?.focus();
      });
    }
  };

  const statusLine = (() => {
    if (listQuery.isLoading) return { warn: false, text: "Loading…" };
    if (listQuery.isError) {
      const failure = describeBillingCategoryFailure(listQuery.error);
      return {
        warn: true,
        text:
          failure.kind === "other"
            ? "The billing categories could not be loaded. Check your connection, then reload the page."
            : billingCategoryFailureMessage(failure),
      };
    }
    return null;
  })();

  const currencyKnown = list ? isBillingCurrency(list.currency) : true;

  return (
    <SettingsPage
      data-testid="settings-billing-categories-root"
      header={
        <SettingsSectionHeader
          icon={<TitleChip icon={Tags} accent={ACCENT} />}
          title="Billing Categories"
        />
      }
    >
      <div className="mx-auto flex w-full max-w-content flex-col gap-4 p-4">
        {statusLine ? (
          <p
            className={`text-sm ${statusLine.warn ? "text-[var(--status-warn)]" : "text-[var(--app-hint)]"}`}
            role="status"
          >
            {statusLine.text}
          </p>
        ) : list ? (
          <>
            {place?.kind === "owner" ? (
              <div className="flex items-center justify-between gap-2">
                {/* A node label has no length cap (F3): the line breaks it,
                    and the button keeps to 60% of the row, truncating it. */}
                <p
                  className="min-w-0 flex-1 break-words text-sm text-[var(--app-hint)]"
                  data-testid="billing-categories-reason"
                >
                  Kept on {place.nodeLabel}. Change it there.
                </p>
                {ownerHref && (
                  <Button asChild size="sm" variant="outline">
                    <a
                      href={ownerHref}
                      title={`Open this page on ${place.nodeLabel}`}
                      className="min-w-0 max-w-[60%]"
                    >
                      <span className="min-w-0 truncate">
                        Open on {place.nodeLabel}
                      </span>
                    </a>
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-sm text-[var(--app-hint)]">
                The categories a tracked session is billed under, each with an
                optional default hourly rate.
              </p>
            )}
            {place?.kind === "local" && mode === "closed" && (
              <p
                className="text-sm text-[var(--app-hint)]"
                data-testid="billing-categories-reason"
              >
                {BILLING_CLOSED_LINE}
              </p>
            )}

            <SettingsRow
              label="Currency for a new rate"
              description="Offered for a new rate. Existing rates keep their own currency; nothing is converted."
              control={
                editable ? (
                  // PR2-R3: a code this version lacks stays the selected option,
                  // with its reason, ahead of the table's codes.
                  <Select
                    aria-label="Currency for a new rate"
                    value={list.currency}
                    title={
                      currencyKnown
                        ? undefined
                        : unknownCurrencyTitle(list.currency)
                    }
                    className="w-24"
                    onChange={e =>
                      void write({ op: "settings", currency: e.target.value })
                    }
                  >
                    {(currencyKnown
                      ? billingCurrencies()
                      : [list.currency, ...billingCurrencies()]
                    ).map(code => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span
                    className="text-sm text-[var(--app-fg)]"
                    title={
                      currencyKnown
                        ? undefined
                        : unknownCurrencyTitle(list.currency)
                    }
                  >
                    {list.currency}
                  </span>
                )
              }
            />

            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={offered.map(c => c.id)}
                strategy={verticalListSortingStrategy}
                disabled={!editable}
              >
                <div
                  className="flex flex-col gap-1"
                  data-testid="billing-category-list"
                >
                  {offered.map((category, index) => (
                    <SortableListEntry key={category.id} id={category.id}>
                      {handle => (
                        <BillingCategoryRow
                          ref={el => {
                            menuRefs.current.set(category.id, el);
                          }}
                          category={category}
                          isDefault={category.id === defaultId}
                          isDragging={handle.isDragging}
                          dragListeners={
                            editable
                              ? splitDragHandle(handle).rowListeners
                              : undefined
                          }
                          actions={
                            editable
                              ? {
                                  onEdit: () =>
                                    setEditing({
                                      kind: "edit",
                                      id: category.id,
                                    }),
                                  onSetDefault:
                                    category.id === defaultId
                                      ? undefined
                                      : () =>
                                          void write({
                                            op: "settings",
                                            defaultCategoryId: category.id,
                                          }),
                                  onMoveUp:
                                    index === 0
                                      ? undefined
                                      : () => reorder(category.id, index - 1),
                                  onMoveDown:
                                    index === offered.length - 1
                                      ? undefined
                                      : () => reorder(category.id, index + 1),
                                  // Retiring the default is not offered.
                                  onRetire:
                                    category.id === defaultId
                                      ? undefined
                                      : () => setRetiring(category),
                                }
                              : undefined
                          }
                        />
                      )}
                    </SortableListEntry>
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {editable && (
              <div>
                <Button
                  ref={addRef}
                  size="sm"
                  disabled={pending}
                  title="Add a billing category"
                  onClick={() => setEditing({ kind: "add" })}
                >
                  Add
                </Button>
              </div>
            )}

            {retired.length > 0 && (
              <CollapsibleSection title={`Retired (${retired.length})`}>
                <div className="flex flex-col gap-1">
                  {retired.map(category => (
                    <BillingCategoryRow
                      key={category.id}
                      category={category}
                      isDefault={false}
                      actions={
                        editable
                          ? {
                              onRestore: () =>
                                void write({
                                  op: "update",
                                  id: category.id,
                                  retired: false,
                                }),
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              </CollapsibleSection>
            )}

            {place?.kind === "local" && (
              <BillingCategoryHistoryList api={api} names={names} />
            )}
          </>
        ) : null}
      </div>

      {dialogOpen && list && (
        <BillingCategoryEditor
          category={editingCategory}
          listCurrency={list.currency}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}
      <ConfirmDialog
        isOpen={retiring !== null}
        onClose={() => setRetiring(null)}
        title="Retire category"
        description={
          retiring
            ? `Retire ${retiring.name}? It is no longer offered for new sessions. Sessions and entries that used it keep its name.`
            : ""
        }
        confirmLabel="Retire"
        confirmingLabel="Retiring…"
        onConfirm={confirmRetire}
        isPending={pending}
      />
    </SettingsPage>
  );
}
