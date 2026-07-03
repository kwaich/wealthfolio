import type {
  DiagnosticAction,
  FixAction,
  HealthCategory,
  HealthDiagnostic,
  HealthIssue,
  HealthSeverity,
} from "@/lib/types";
import {
  ActionConfirm,
  Badge,
  Button,
  Icons,
  ScrollArea,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";
import { cn } from "@wealthfolio/ui/lib/utils";
import { Link } from "react-router-dom";

interface IssueDetailSheetProps {
  issue: HealthIssue | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDismiss: () => void;
  onFix: () => void;
  /** Runs a specific fix action from a diagnostic's "How to fix" list. */
  onRunFixAction: (action: FixAction) => void;
  isDismissing: boolean;
  isFixing: boolean;
}

/** Builds a route string from a diagnostic navigate action ({ route, query }). */
function buildDiagnosticRoute(action: Extract<DiagnosticAction, { kind: "navigate" }>): string {
  const query = new URLSearchParams(
    Object.entries(action.query ?? {}).map(([key, value]) => [key, String(value)]),
  ).toString();
  return `${action.route}${query ? `?${query}` : ""}`;
}

const SEVERITY_CONFIG: Record<HealthSeverity, { label: string; color: string }> = {
  INFO: { label: "Info", color: "text-muted-foreground" },
  WARNING: { label: "Warning", color: "text-yellow-600 dark:text-yellow-400" },
  ERROR: { label: "Error", color: "text-destructive" },
  CRITICAL: { label: "Critical", color: "text-destructive" },
};

const CATEGORY_LABELS: Record<HealthCategory, { label: string; description: string }> = {
  PRICE_STALENESS: {
    label: "Price Staleness",
    description:
      "Market prices are outdated and need to be refreshed. This can affect the accuracy of your portfolio valuation.",
  },
  FX_INTEGRITY: {
    label: "Exchange Rates",
    description:
      "Missing or outdated exchange rates for currency conversion. This may impact multi-currency portfolio calculations.",
  },
  CLASSIFICATION: {
    label: "Classification",
    description:
      "Assets are missing categories or classifications. This affects portfolio breakdowns and allocation analysis.",
  },
  DATA_CONSISTENCY: {
    label: "Data Consistency",
    description:
      "Inconsistencies detected in portfolio data. This may cause inaccurate reporting or calculations.",
  },
  ACCOUNT_CONFIGURATION: {
    label: "Account Setup",
    description:
      "Some accounts need configuration before data can be synced. Set tracking mode to start importing data.",
  },
  SETTINGS_CONFIGURATION: {
    label: "Settings",
    description:
      "Some application settings need attention to ensure data is interpreted correctly.",
  },
};

function getCategoryConfigForIssue(issue: HealthIssue): { label: string; description: string } {
  if (issue.category !== "SETTINGS_CONFIGURATION") {
    return CATEGORY_LABELS[issue.category];
  }

  if (issue.id.startsWith("timezone_missing:")) {
    return {
      label: "Timezone Settings",
      description:
        "Your app timezone is not configured. Until you set it, user-facing dates may not match your locale.",
    };
  }

  if (issue.id.startsWith("timezone_invalid:")) {
    return {
      label: "Timezone Settings",
      description:
        "Your configured timezone is invalid. Update it in General settings to restore consistent date handling.",
    };
  }

  if (issue.id.startsWith("timezone_mismatch:")) {
    return {
      label: "Timezone Settings",
      description:
        "Your browser timezone differs from the configured app timezone. Portfolio dates follow the configured timezone.",
    };
  }

  return CATEGORY_LABELS.SETTINGS_CONFIGURATION;
}

function buildNavigateActionRoute(
  navigateAction: HealthIssue["navigateAction"],
  queryOverrides: Record<string, string> = {},
): string | null {
  if (!navigateAction) return null;

  const query = new URLSearchParams(
    Object.entries({ ...(navigateAction.query ?? {}), ...queryOverrides }).map(([key, value]) => [
      key,
      String(value),
    ]),
  ).toString();

  return `${navigateAction.route}${query ? `?${query}` : ""}`;
}

function getDetailDate(lines: string[]): string | null {
  const dateLine = lines.find((line) => line.startsWith("Date:"));
  const match = dateLine?.match(/^Date:\s*(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function diagnosticCodeFromIssueId(id: string): string {
  const groupingKey = id.includes(":") ? id.slice(0, id.lastIndexOf(":")) : id;
  return groupingKey
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toUpperCase())
    .join("_");
}

function isFallbackDiagnosticIssue(issue: HealthIssue, diagnostics: HealthDiagnostic[]): boolean {
  if (diagnostics.length !== 1) return false;
  const [diagnostic] = diagnostics;
  return (
    diagnostic.code === diagnosticCodeFromIssueId(issue.id) &&
    diagnostic.title === issue.title &&
    diagnostic.explanation === issue.message
  );
}

interface DiagnosticGroup {
  key: string;
  title: string;
  explanation: string;
  diagnostics: HealthDiagnostic[];
}

interface DiagnosticEvidenceRow {
  key: string;
  label: string;
  value: string;
  detail?: string;
  route?: string;
}

interface PriceDiagnosticAssetGroup {
  key: string;
  label: string;
  dates: string[];
  route?: string;
}

interface DiagnosticActionEntry {
  key: string;
  action: DiagnosticAction;
}

const GENERIC_EVIDENCE_LABELS = new Set([
  "asset",
  "holding",
  "transaction",
  "transfer",
  "account",
  "item",
]);

function groupDiagnostics(diagnostics: HealthDiagnostic[]): DiagnosticGroup[] {
  const groups = new Map<string, DiagnosticGroup>();
  diagnostics.forEach((diagnostic) => {
    const key = `${diagnostic.code}:${diagnostic.title}:${diagnostic.explanation}`;
    const existing = groups.get(key);
    if (existing) {
      existing.diagnostics.push(diagnostic);
      return;
    }
    groups.set(key, {
      key,
      title: diagnostic.title,
      explanation: diagnostic.explanation,
      diagnostics: [diagnostic],
    });
  });
  return Array.from(groups.values());
}

function getPrimaryDiagnosticAction(diagnostic: HealthDiagnostic): DiagnosticAction | undefined {
  return diagnostic.actions.find((action) => action.primary) ?? diagnostic.actions[0];
}

function getOrderedDiagnosticActions(diagnostic: HealthDiagnostic): DiagnosticAction[] {
  const primary = diagnostic.actions.filter((action) => action.primary);
  const secondary = diagnostic.actions.filter((action) => !action.primary);
  return [...primary, ...secondary];
}

function stringifyActionPart(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function getDiagnosticActionSignature(action: DiagnosticAction): string {
  if (action.kind === "navigate") {
    return `navigate:${action.route}:${action.label}:${stringifyActionPart(action.query)}`;
  }
  return `fix:${action.id}:${action.label}:${stringifyActionPart(action.payload)}`;
}

function getDiagnosticActionEntries(
  diagnostics: HealthDiagnostic[],
  includePrimary: boolean,
): DiagnosticActionEntry[] {
  const seen = new Set<string>();
  return diagnostics.flatMap((diagnostic) =>
    getOrderedDiagnosticActions(diagnostic).flatMap((action) => {
      if (!includePrimary && action.primary) return [];
      const signature = getDiagnosticActionSignature(action);
      if (seen.has(signature)) return [];
      seen.add(signature);
      return [{ key: `${diagnostic.fingerprint}:${signature}`, action }];
    }),
  );
}

function isPriceDateDiagnostic(diagnostic: HealthDiagnostic): boolean {
  return (
    diagnostic.code === "MISSING_MARKET_QUOTE" || diagnostic.code === "MISSING_MANUAL_VALUATION"
  );
}

function isDateEvidence(label: string): boolean {
  return /date/i.test(label);
}

function getEvidenceDisplay(row: HealthDiagnostic["evidence"][number]): {
  label: string;
  value: string;
} {
  if (GENERIC_EVIDENCE_LABELS.has(row.label.toLowerCase())) {
    return { label: row.value, value: row.label };
  }
  return { label: row.label, value: row.value };
}

function buildDiagnosticRows(diagnostic: HealthDiagnostic): DiagnosticEvidenceRow[] {
  const dateRow = diagnostic.evidence.find((row) => isDateEvidence(row.label));
  const objectRows = diagnostic.evidence.filter((row) => !isDateEvidence(row.label));
  const sourceRows = objectRows.length > 0 ? objectRows : diagnostic.evidence;

  if (sourceRows.length === 0) {
    const entity = diagnostic.entities[0];
    return [
      {
        key: `${diagnostic.fingerprint}:diagnostic`,
        label: entity?.label ?? diagnostic.title,
        value: entity?.kind ?? "",
        detail: diagnostic.date,
        route: entity?.route,
      },
    ];
  }

  return sourceRows.map((row, index) => {
    const display = getEvidenceDisplay(row);
    return {
      key: `${diagnostic.fingerprint}:${index}:${row.label}:${row.value}`,
      label: display.label,
      value: display.value,
      detail: dateRow && dateRow !== row ? dateRow.value : undefined,
      route: row.route,
    };
  });
}

function compactHealthDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function stripGroupedDateParam(route: string, dates: string[]): string {
  if (dates.length <= 1) return route;
  try {
    const url = new URL(route, "http://localhost");
    url.searchParams.delete("date");
    return `${url.pathname}${url.search}`;
  } catch {
    return route;
  }
}

function summarizePriceDates(dates: string[]): string {
  const uniqueDates = Array.from(new Set(dates)).sort();
  if (uniqueDates.length === 0) return "Price history needs review";

  if (uniqueDates.length === 1) {
    return `1 missing trading day: ${compactHealthDate(uniqueDates[0])}`;
  }

  if (uniqueDates.length <= 3) {
    return `${uniqueDates.length} missing trading days: ${uniqueDates
      .map(compactHealthDate)
      .join(", ")}`;
  }

  return `${uniqueDates.length} missing trading days: ${compactHealthDate(
    uniqueDates[0],
  )} to ${compactHealthDate(uniqueDates[uniqueDates.length - 1])}`;
}

function buildPriceAssetGroups(diagnostics: HealthDiagnostic[]): PriceDiagnosticAssetGroup[] {
  const groups = new Map<string, PriceDiagnosticAssetGroup>();

  diagnostics.forEach((diagnostic) => {
    const assetEvidence = diagnostic.evidence.find((row) => !isDateEvidence(row.label));
    const dateEvidence = diagnostic.evidence.find((row) => isDateEvidence(row.label));
    const label = assetEvidence?.value ?? diagnostic.entities[0]?.label ?? diagnostic.title;
    const route = assetEvidence?.route ?? diagnostic.entities[0]?.route;
    const key = diagnostic.entities.find((entity) => entity.kind === "asset")?.id ?? route ?? label;
    const date = diagnostic.date ?? dateEvidence?.value;
    const existing = groups.get(key);

    if (existing) {
      if (date) existing.dates.push(date);
      if (!existing.route && route) existing.route = route;
      return;
    }

    groups.set(key, {
      key,
      label,
      dates: date ? [date] : [],
      route,
    });
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    dates: Array.from(new Set(group.dates)).sort(),
    route: group.route ? stripGroupedDateParam(group.route, group.dates) : undefined,
  }));
}

function isGroupedPriceIssue(diagnosticGroups: DiagnosticGroup[]): boolean {
  return (
    diagnosticGroups.length === 1 &&
    diagnosticGroups[0].diagnostics.length > 1 &&
    diagnosticGroups[0].diagnostics.every(isPriceDateDiagnostic)
  );
}

function priceIssueSummary(diagnosticCount: number, assetCount: number): string {
  const assetLabel = assetCount === 1 ? "investment" : "investments";
  return `${diagnosticCount} price ${diagnosticCount === 1 ? "date" : "dates"} across ${assetCount} ${assetLabel}`;
}

export function IssueDetailSheet({
  issue,
  open,
  onOpenChange,
  onDismiss,
  onFix,
  onRunFixAction,
  isDismissing,
  isFixing,
}: IssueDetailSheetProps) {
  if (!issue) return null;

  const severityConfig = SEVERITY_CONFIG[issue.severity];
  const categoryConfig = getCategoryConfigForIssue(issue);
  const navigateActionRoute = buildNavigateActionRoute(issue.navigateAction);
  const diagnostics = issue.diagnostics ?? [];
  const hasDiagnostics = diagnostics.length > 0;
  const diagnosticGroups = groupDiagnostics(diagnostics);
  const isGroupedPrice = isGroupedPriceIssue(diagnosticGroups);
  const hasDiagnosticActions = diagnostics.some((diagnostic) => diagnostic.actions.length > 0);
  const shouldRenderDetails = !hasDiagnostics || isFallbackDiagnosticIssue(issue, diagnostics);
  const detailItems =
    issue.details
      ?.split(/\n\s*\n/)
      .map((detail) => detail.trim())
      .filter(Boolean) ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-xl lg:max-w-2xl">
        <SheetHeader className="shrink-0 space-y-3 pb-6">
          <div className="flex items-center gap-2 text-xs">
            <span className={cn("font-medium", severityConfig.color)}>{severityConfig.label}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground">{categoryConfig.label}</span>
          </div>
          <SheetTitle className="text-xl leading-tight">{issue.title}</SheetTitle>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {isGroupedPrice
              ? "Wealthfolio is using carried-forward prices for these dates. Refetch or add prices for real trading days; dismiss the issue if the dates were holidays or non-trading days."
              : issue.message}
          </p>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 pr-4">
            {!hasDiagnostics && issue.affectedItems && issue.affectedItems.length > 0 && (
              <div className="space-y-3">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Affected Items ({issue.affectedItems.length})
                </h4>
                <div className="rounded-md border p-1">
                  {issue.affectedItems.map((item) => (
                    <div key={item.id} className="group">
                      {item.route ? (
                        <Link
                          to={item.route}
                          className="hover:bg-muted flex items-center justify-between gap-2 rounded-md px-2 py-2 transition-colors"
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            {item.symbol && (
                              <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                                {item.symbol}
                              </Badge>
                            )}
                            <span className="truncate text-sm">{item.name}</span>
                          </div>
                          <Icons.ChevronRight className="text-muted-foreground h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
                        </Link>
                      ) : (
                        <div className="flex items-center gap-2 px-2 py-2">
                          {item.symbol && (
                            <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                              {item.symbol}
                            </Badge>
                          )}
                          <span className="truncate text-sm">{item.name}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(issue.affectedCount > 0 ||
              (issue.affectedMvPct != null && issue.affectedMvPct > 0)) &&
              !issue.affectedItems &&
              !isGroupedPrice && (
                <div className="space-y-3">
                  <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Impact
                  </h4>
                  <div className="grid grid-cols-2 gap-4">
                    {issue.affectedCount > 0 && (
                      <div>
                        <p className="text-2xl font-semibold tabular-nums">{issue.affectedCount}</p>
                        <p className="text-muted-foreground text-xs">Affected items</p>
                      </div>
                    )}
                    {issue.affectedMvPct != null && issue.affectedMvPct > 0 && (
                      <div>
                        <p className="text-2xl font-semibold tabular-nums">
                          {(issue.affectedMvPct * 100).toFixed(1)}%
                        </p>
                        <p className="text-muted-foreground text-xs">Portfolio impact</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

            {hasDiagnostics && (
              <div className="space-y-4">
                {diagnosticGroups.map((group) => {
                  const shouldGroupByAsset =
                    group.diagnostics.length > 1 && group.diagnostics.every(isPriceDateDiagnostic);
                  const priceAssetGroups = shouldGroupByAsset
                    ? buildPriceAssetGroups(group.diagnostics)
                    : [];
                  const actionEntries = shouldGroupByAsset
                    ? []
                    : getDiagnosticActionEntries(group.diagnostics, group.diagnostics.length === 1);

                  return (
                    <div key={group.key} className="space-y-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-sm font-medium">
                            {shouldGroupByAsset ? "Prices by investment" : group.title}
                          </p>
                          {shouldGroupByAsset && (
                            <p className="text-muted-foreground text-xs">
                              {priceIssueSummary(group.diagnostics.length, priceAssetGroups.length)}
                            </p>
                          )}
                        </div>
                        {!shouldGroupByAsset && (
                          <p className="text-muted-foreground text-xs leading-relaxed">
                            {group.explanation}
                          </p>
                        )}
                        {shouldGroupByAsset && (
                          <p className="text-muted-foreground text-xs leading-relaxed">
                            Open an investment to refetch or add prices. If the dates were holidays
                            or non-trading days, dismiss the issue.
                          </p>
                        )}
                      </div>

                      <div className="divide-y overflow-hidden rounded-md border">
                        {shouldGroupByAsset
                          ? priceAssetGroups.map((assetGroup) => {
                              const row = (
                                <div className="flex items-center justify-between gap-3 px-3 py-2">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm">{assetGroup.label}</p>
                                    <p className="text-muted-foreground mt-0.5 truncate text-xs">
                                      {summarizePriceDates(assetGroup.dates)}
                                    </p>
                                  </div>
                                  {assetGroup.route && (
                                    <Icons.ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                                  )}
                                </div>
                              );

                              return assetGroup.route ? (
                                <Link
                                  key={assetGroup.key}
                                  to={assetGroup.route}
                                  className="hover:bg-muted/40 block transition-colors"
                                >
                                  {row}
                                </Link>
                              ) : (
                                <div key={assetGroup.key}>{row}</div>
                              );
                            })
                          : group.diagnostics.flatMap((diagnostic) => {
                              const action = getPrimaryDiagnosticAction(diagnostic);
                              const rows = buildDiagnosticRows(diagnostic);
                              return rows.map((evidenceRow) => {
                                const rowRoute =
                                  action?.kind === "navigate" && rows.length === 1
                                    ? buildDiagnosticRoute(action)
                                    : evidenceRow.route;
                                const row = (
                                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                                    <div className="min-w-0">
                                      <p className="truncate text-sm">{evidenceRow.label}</p>
                                      <div className="text-muted-foreground mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                                        {evidenceRow.value && <span>{evidenceRow.value}</span>}
                                        {evidenceRow.detail && (
                                          <span className="font-mono tabular-nums">
                                            {evidenceRow.detail}
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                    {rowRoute && (
                                      <Icons.ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" />
                                    )}
                                  </div>
                                );

                                return rowRoute ? (
                                  <Link
                                    key={evidenceRow.key}
                                    to={rowRoute}
                                    className="hover:bg-muted/40 block transition-colors"
                                  >
                                    {row}
                                  </Link>
                                ) : (
                                  <div key={evidenceRow.key}>{row}</div>
                                );
                              });
                            })}
                      </div>

                      {actionEntries.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {actionEntries.map(({ key, action }) =>
                            action.kind === "navigate" ? (
                              <Button key={key} variant="outline" size="sm" asChild>
                                <Link to={buildDiagnosticRoute(action)}>
                                  <Icons.ArrowRight className="mr-2 h-4 w-4" />
                                  {action.label}
                                </Link>
                              </Button>
                            ) : (
                              <Button
                                key={key}
                                type="button"
                                variant={action.primary ? "default" : "outline"}
                                size="sm"
                                disabled={isFixing}
                                onClick={() =>
                                  onRunFixAction({
                                    id: action.id,
                                    label: action.label,
                                    payload: action.payload,
                                  })
                                }
                              >
                                {isFixing ? (
                                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                  <Icons.Wand2 className="mr-2 h-4 w-4" />
                                )}
                                {action.label}
                              </Button>
                            ),
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {shouldRenderDetails && detailItems.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Details
                </h4>
                <div className="space-y-2">
                  {detailItems.map((detail, index) => {
                    const lines = detail.split("\n").filter(Boolean);
                    const [title, ...body] = lines;
                    const detailDate = getDetailDate(lines);
                    const detailRoute =
                      detailDate && issue.navigateAction?.route === "/activities"
                        ? buildNavigateActionRoute(issue.navigateAction, {
                            from: detailDate,
                            to: detailDate,
                          })
                        : null;
                    const detailContent = (
                      <div
                        className={cn(
                          "bg-muted/20 rounded-md border px-3 py-2",
                          detailRoute && "hover:bg-muted/40 transition-colors",
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            {title && <p className="text-sm font-medium">{title}</p>}
                            {body.map((line, lineIndex) => {
                              const isDateLine = line.startsWith("Date:");
                              return (
                                <p
                                  key={`${line}-${lineIndex}`}
                                  className={cn(
                                    "mt-1 text-sm",
                                    isDateLine
                                      ? "text-foreground font-mono tabular-nums"
                                      : "text-muted-foreground",
                                  )}
                                >
                                  {line}
                                </p>
                              );
                            })}
                          </div>
                          {detailRoute && (
                            <Icons.ChevronRight className="text-muted-foreground mt-1 h-4 w-4 shrink-0" />
                          )}
                        </div>
                      </div>
                    );
                    return detailRoute ? (
                      <Link key={`${title}-${index}`} to={detailRoute} className="block">
                        {detailContent}
                      </Link>
                    ) : (
                      <div key={`${title}-${index}`}>{detailContent}</div>
                    );
                  })}
                </div>
              </div>
            )}

            {!isGroupedPrice && (
              <div className="space-y-2 border-t pt-6">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  About this issue
                </h4>
                <p className="text-muted-foreground text-sm">{categoryConfig.description}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="shrink-0 space-y-2 border-t pt-4">
          {issue.fixAction && !hasDiagnosticActions && (
            <Button onClick={onFix} disabled={isFixing} className="w-full">
              {isFixing ? (
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Icons.Wand2 className="mr-2 h-4 w-4" />
              )}
              {issue.fixAction.label}
            </Button>
          )}

          {issue.navigateAction && !hasDiagnosticActions && (
            <Button variant="outline" className="w-full" asChild>
              <Link to={navigateActionRoute ?? issue.navigateAction.route}>
                <Icons.ArrowRight className="mr-2 h-4 w-4" />
                {issue.navigateAction.label}
              </Link>
            </Button>
          )}

          <ActionConfirm
            confirmTitle="Dismiss this issue?"
            confirmMessage="This will hide the issue from your health center. It will reappear if the underlying data changes."
            confirmButtonText="Dismiss"
            confirmButtonVariant="default"
            handleConfirm={onDismiss}
            isPending={isDismissing}
            pendingText="Dismissing..."
            button={
              <Button variant="ghost" className="text-muted-foreground w-full">
                <Icons.EyeOff className="mr-2 h-4 w-4" />
                Dismiss
              </Button>
            }
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
