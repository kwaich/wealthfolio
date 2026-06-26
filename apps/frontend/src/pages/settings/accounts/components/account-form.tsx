import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Switch } from "@wealthfolio/ui/components/ui/switch";

import { newAccountSchema } from "@/lib/schemas";
import { AccountType } from "@/lib/constants";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { cn } from "@/lib/utils";
import {
  CurrencyInput,
  RadioGroup,
  RadioGroupItem,
  ResponsiveSelect,
  ToggleGroup,
  ToggleGroupItem,
  type ResponsiveSelectOption,
} from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";

import { useAccountMutations } from "./use-account-mutations";

const CASH_ALLOCATION_DEFAULT_VALUE = "__default__";
const CASH_FIXED_INCOME_CATEGORY_ID = "FIXED_INCOME";

function getCashCategoryFromMeta(meta?: string | null): string | null {
  if (!meta) return null;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    const allocation = parsed.allocation as Record<string, unknown> | undefined;
    return (allocation?.cashCategoryId as string) ?? null;
  } catch {
    return null;
  }
}

function setCashCategoryInMeta(meta: string | null | undefined, categoryId: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (meta) {
    try {
      parsed = JSON.parse(meta) as Record<string, unknown>;
    } catch {
      // ignore
    }
  }
  if (categoryId) {
    parsed.allocation = { cashCategoryId: categoryId };
  } else {
    delete parsed.allocation;
  }
  return JSON.stringify(parsed);
}

function getSelectableCashCategoryFromMeta(meta?: string | null): string {
  const categoryId = getCashCategoryFromMeta(meta);
  return categoryId === CASH_FIXED_INCOME_CATEGORY_ID
    ? CASH_FIXED_INCOME_CATEGORY_ID
    : CASH_ALLOCATION_DEFAULT_VALUE;
}

const accountTypes: ResponsiveSelectOption[] = [
  { label: "Securities", value: "SECURITIES" },
  { label: "Cash", value: "CASH" },
  { label: "Credit Card", value: "CREDIT_CARD" },
  { label: "Crypto", value: "CRYPTOCURRENCY" },
];

const accountTypeIcons = {
  [AccountType.SECURITIES]: Icons.Briefcase,
  [AccountType.CASH]: Icons.DollarSign,
  [AccountType.CREDIT_CARD]: Icons.CreditCard,
  [AccountType.CRYPTOCURRENCY]: Icons.Bitcoin,
} as const;

const formCardClassName =
  "rounded-xl border border-border bg-background p-4 sm:p-5 dark:border-border/70 dark:bg-muted/20";
const formSectionLabelClassName =
  "text-muted-foreground text-xs font-semibold uppercase tracking-[0.18em]";
const trackingOptionClassName =
  "hover:bg-accent/50 relative flex cursor-pointer gap-3 rounded-xl border bg-card p-4 transition-colors dark:bg-muted/20 dark:hover:bg-muted/30";
const cashClassificationItemClassName =
  "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground h-9 rounded-md text-sm data-[state=on]:shadow-sm dark:data-[state=on]:bg-secondary dark:data-[state=on]:text-foreground";

// Input type (what the form receives)
type AccountFormInput = z.input<typeof newAccountSchema>;
// Output type after zod parsing (with defaults applied)
type AccountFormOutput = z.output<typeof newAccountSchema>;

interface AccountFormlProps {
  defaultValues?: AccountFormInput;
  onSuccess?: () => void;
}

export function AccountForm({ defaultValues, onSuccess = () => undefined }: AccountFormlProps) {
  const { createAccountMutation, updateAccountMutation } = useAccountMutations({ onSuccess });

  // Track initial tracking mode to detect changes
  const initialTrackingMode = defaultValues?.trackingMode;
  const needsSetup = initialTrackingMode === "NOT_SET" || initialTrackingMode === undefined;

  // State for mode switch confirmation dialog
  const [showModeConfirmation, setShowModeConfirmation] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<AccountFormOutput | null>(null);

  const form = useForm<AccountFormInput, unknown, AccountFormOutput>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: {
      ...defaultValues,
      // Don't default to any mode if account needs setup (must come after spread)
      trackingMode: needsSetup ? undefined : defaultValues?.trackingMode,
    },
  });

  const currentTrackingMode = form.watch("trackingMode");
  const currentAccountType = form.watch("accountType");
  const isCreditCardAccount = currentAccountType === AccountType.CREDIT_CARD;
  const isCashAccount = currentAccountType === AccountType.CASH;

  const { data: assetClassesTaxonomy } = useTaxonomy(isCashAccount ? "asset_classes" : null);
  const fixedIncomeCategoryName = useMemo(() => {
    return (
      assetClassesTaxonomy?.categories.find(
        (c) => !c.parentId && c.id === CASH_FIXED_INCOME_CATEGORY_ID,
      )?.name ?? "Fixed Income"
    );
  }, [assetClassesTaxonomy]);

  useEffect(() => {
    if (isCreditCardAccount && currentTrackingMode !== "TRANSACTIONS") {
      form.setValue("trackingMode", "TRANSACTIONS", { shouldDirty: true, shouldValidate: true });
    }
  }, [currentTrackingMode, form, isCreditCardAccount]);

  // Perform the actual submit (after confirmation if needed)
  // Returns a promise when updating so it can be chained with other operations
  const doSubmit = useCallback(
    (data: AccountFormOutput, options?: { async?: boolean }) => {
      const { id, trackingMode, ...rest } = data;

      if (id) {
        if (options?.async) {
          return updateAccountMutation.mutateAsync({
            id,
            trackingMode,
            ...rest,
          });
        }
        return updateAccountMutation.mutate({ id, trackingMode, ...rest });
      }
      return createAccountMutation.mutate({ trackingMode, ...rest });
    },
    [createAccountMutation, updateAccountMutation],
  );

  function onSubmit(data: AccountFormOutput) {
    // Check if this is an existing account (update) and mode is switching from HOLDINGS to TRANSACTIONS
    const isExistingAccount = !!data.id;
    const isSwitchingFromHoldingsToTransactions =
      !needsSetup && initialTrackingMode === "HOLDINGS" && data.trackingMode === "TRANSACTIONS";

    if (isExistingAccount && isSwitchingFromHoldingsToTransactions) {
      // Show confirmation dialog
      setPendingFormData(data);
      setShowModeConfirmation(true);
      return;
    }

    // Otherwise, submit directly
    doSubmit(data);
  }

  // Handle confirmation dialog actions
  const handleConfirmModeSwitch = async () => {
    setShowModeConfirmation(false);
    if (pendingFormData?.id) {
      try {
        // Save all account details including tracking mode
        await doSubmit(pendingFormData, { async: true });
      } finally {
        setPendingFormData(null);
      }
    }
  };

  const handleCancelModeSwitch = () => {
    setShowModeConfirmation(false);
    setPendingFormData(null);
    // Revert the tracking mode in the form
    form.setValue("trackingMode", initialTrackingMode);
  };

  const formTitle = defaultValues?.id ? "Update Account" : "Add Account";
  const formDescription = defaultValues?.id
    ? "Update account information"
    : "Add an investment account to track.";
  const AccountTypeIcon = accountTypeIcons[currentAccountType] ?? Icons.Wallet;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6 p-5 sm:p-6">
        <DialogHeader className="pr-10 text-left">
          <div className="flex items-start gap-3">
            <div className="bg-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
              <AccountTypeIcon className="text-muted-foreground h-5 w-5" />
            </div>
            <div className="min-w-0 space-y-1">
              <DialogTitle>{formTitle}</DialogTitle>
              <DialogDescription>{formDescription}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <input type="hidden" name="id" />
          <section className={formCardClassName}>
            <h3 className={formSectionLabelClassName}>Identity</h3>
            <div className="mt-4 grid gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Name</FormLabel>
                    <FormControl>
                      <Input placeholder="Account display name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="group"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Account Group</FormLabel>
                    <FormControl>
                      <Input placeholder="Retirement, 401K, RRSP, TFSA,..." {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>Account Type</FormLabel>
                    <FormControl>
                      <ResponsiveSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={accountTypes}
                        placeholder="Select an account type"
                        sheetTitle="Select Account Type"
                        sheetDescription="Choose the account type that best matches."
                        triggerClassName="h-11"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {!defaultValues?.id ? (
                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem className="flex flex-col">
                      <FormLabel>Currency</FormLabel>
                      <FormControl>
                        <CurrencyInput
                          value={field.value}
                          onChange={(value: string) => field.onChange(value)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

              {isCashAccount && (
                <div className="flex flex-col gap-2">
                  <div>
                    <label className="text-sm font-medium">Cash Classification</label>
                    <p className="text-muted-foreground text-xs">
                      How this cash is counted in allocation reports
                    </p>
                  </div>
                  <ToggleGroup
                    type="single"
                    aria-label="Cash Classification"
                    value={getSelectableCashCategoryFromMeta(form.watch("meta"))}
                    onValueChange={(v) => {
                      if (!v) return;
                      const categoryId = v === CASH_ALLOCATION_DEFAULT_VALUE ? null : v;
                      const updatedMeta = setCashCategoryInMeta(form.getValues("meta"), categoryId);
                      form.setValue("meta", updatedMeta, { shouldDirty: true });
                    }}
                    className="bg-muted grid h-11 grid-cols-2 rounded-lg p-1"
                  >
                    <ToggleGroupItem
                      value={CASH_ALLOCATION_DEFAULT_VALUE}
                      className={cashClassificationItemClassName}
                    >
                      Cash
                    </ToggleGroupItem>
                    <ToggleGroupItem
                      value={CASH_FIXED_INCOME_CATEGORY_ID}
                      className={cashClassificationItemClassName}
                    >
                      {fixedIncomeCategoryName}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              )}
            </div>
          </section>

          <div className="grid content-start gap-4">
            <FormField
              control={form.control}
              name="trackingMode"
              render={({ field }) => (
                <FormItem className={cn(formCardClassName, "space-y-4")}>
                  <FormLabel className={formSectionLabelClassName}>Tracking Mode</FormLabel>
                  {needsSetup && !currentTrackingMode && (
                    <Alert
                      variant="warning"
                      className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                    >
                      <Icons.AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        Choose how to track this account. This affects what data you enter and what
                        metrics are available.{" "}
                        <a
                          href="https://wealthfolio.app/docs/concepts/activity-types"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-foreground underline"
                        >
                          Learn more
                        </a>
                      </AlertDescription>
                    </Alert>
                  )}
                  <FormControl>
                    <RadioGroup
                      onValueChange={field.onChange}
                      value={field.value}
                      className="grid gap-3"
                    >
                      <label
                        className={cn(
                          trackingOptionClassName,
                          field.value === "TRANSACTIONS"
                            ? "border-primary bg-primary/5 dark:border-foreground/60 dark:bg-secondary/30"
                            : "border-border",
                        )}
                      >
                        <RadioGroupItem value="TRANSACTIONS" className="mt-0.5" />
                        <div className="flex flex-col">
                          <span className="text-sm font-medium">Transactions</span>
                          <span className="text-muted-foreground text-xs">
                            Track every trade for performance analytics
                          </span>
                        </div>
                      </label>
                      {!isCreditCardAccount && (
                        <label
                          className={cn(
                            trackingOptionClassName,
                            field.value === "HOLDINGS"
                              ? "border-primary bg-primary/5 dark:border-foreground/60 dark:bg-secondary/30"
                              : "border-border",
                          )}
                        >
                          <RadioGroupItem value="HOLDINGS" className="mt-0.5" />
                          <div className="flex flex-col">
                            <span className="text-sm font-medium">Holdings</span>
                            <span className="text-muted-foreground text-xs">
                              Add holdings directly as snapshots
                            </span>
                          </div>
                        </label>
                      )}
                    </RadioGroup>
                  </FormControl>
                  {field.value === "HOLDINGS" && (
                    <Alert
                      variant="warning"
                      className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                    >
                      <Icons.AlertTriangle className="h-4 w-4" />
                      <AlertDescription className="text-xs">
                        Performance metrics will be limited without transaction history.{" "}
                        <a
                          href="https://wealthfolio.app/docs/concepts/activity-types"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:text-foreground underline"
                        >
                          Learn more
                        </a>
                      </AlertDescription>
                    </Alert>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <section className={formCardClassName}>
              <h3 className={formSectionLabelClassName}>Visibility</h3>
              <div className="mt-4 grid gap-4">
                <FormField
                  control={form.control}
                  name="isActive"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4 space-y-0">
                      <div className="min-w-0">
                        <FormLabel className="text-sm font-normal">
                          Hide this account
                          <span className="text-muted-foreground ml-1 text-xs font-normal">
                            — keeps in Total & history
                          </span>
                        </FormLabel>
                        <FormMessage />
                      </div>
                      <FormControl>
                        <Switch
                          checked={!field.value}
                          onCheckedChange={(checked) => field.onChange(!checked)}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />

                {defaultValues?.id && (
                  <FormField
                    control={form.control}
                    name="isArchived"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between gap-4 space-y-0">
                        <div className="min-w-0">
                          <FormLabel className="text-sm font-normal">
                            Archive this account
                            <span className="text-muted-foreground ml-1 text-xs font-normal">
                              — removes from portfolio, can restore later
                            </span>
                          </FormLabel>
                          <FormMessage />
                        </div>
                        <FormControl>
                          <Switch checked={field.value} onCheckedChange={field.onChange} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                )}
              </div>
            </section>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={needsSetup && !currentTrackingMode}>
            {defaultValues?.id ? (
              <Icons.Save className="h-4 w-4" />
            ) : (
              <Icons.Plus className="h-4 w-4" />
            )}
            <span>{defaultValues?.id ? "Update Account" : "Add Account"}</span>
          </Button>
        </DialogFooter>
      </form>

      {/* Mode Switch Confirmation Dialog */}
      <AlertDialog open={showModeConfirmation} onOpenChange={setShowModeConfirmation}>
        <AlertDialogContent className="max-w-105 gap-0 overflow-hidden p-0">
          <div className="px-5 pb-4 pt-5">
            <AlertDialogHeader className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100/30 dark:bg-orange-100/20">
                  <Icons.ArrowRightLeft className="h-4 w-4 text-orange-500 dark:text-orange-300" />
                </div>
                <AlertDialogTitle className="text-base font-semibold">
                  Switch to Transactions mode
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription>
                Your account value and performance history will be rebuilt entirely from
                transactions. Existing holdings snapshots will be deleted.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Checklist */}
            <div className="mt-4 rounded-lg border border-orange-100/40 bg-orange-100/30 p-3 dark:border-orange-100/20 dark:bg-orange-100/20">
              <p className="mb-2 text-xs font-medium text-orange-600 dark:text-orange-200">
                Make sure your transactions are complete
              </p>
              <ul className="space-y-2 text-[13px]">
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    All buys, sells, deposits &amp; withdrawals are recorded
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    Dates, quantities &amp; prices are accurate
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    Gaps in history will lead to incorrect balances &amp; returns
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <AlertDialogFooter className="bg-muted/30 border-t px-5 py-3">
            <AlertDialogCancel onClick={handleCancelModeSwitch}>Keep Holdings</AlertDialogCancel>
            <Button onClick={handleConfirmModeSwitch}>Switch to Transactions</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
