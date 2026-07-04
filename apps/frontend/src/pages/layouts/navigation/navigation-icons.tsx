import { Icons } from "@wealthfolio/ui/components/ui/icons";
import React from "react";

const addonIconMap = {
  addon: Icons.Addons,
  addons: Icons.Addons,
  barchart: Icons.BarChart,
  blocks: Icons.Blocks,
  calendar: Icons.Calendar,
  calendardots: Icons.CalendarDots,
  calendardays: Icons.Calendar,
  calendaricon: Icons.CalendarIcon,
  chart: Icons.Insight,
  chartbar: Icons.ChartBar,
  chartline: Icons.TrendingUp,
  dashboard: Icons.Dashboard,
  fee: Icons.Invoice,
  fees: Icons.Invoice,
  goal: Icons.Goal,
  goals: Icons.Goals,
  holdings: Icons.Holdings,
  invoice: Icons.Invoice,
  puzzle: Icons.PuzzlePiece,
  puzzlepiece: Icons.PuzzlePiece,
  receipt: Icons.ReceiptDuotone,
  receipttext: Icons.ReceiptText,
  settings: Icons.Settings,
  target: Icons.Target,
  trading: Icons.TrendingUp,
  trendingup: Icons.TrendingUp,
  wallet: Icons.Wallet,
} satisfies Record<string, React.ComponentType<{ className?: string }>>;

function normalizeIconKey(icon: string) {
  return icon.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function resolveNavigationIcon(icon: React.ReactNode, className: string) {
  if (!icon) {
    return <Icons.PuzzlePiece className={className} />;
  }

  if (typeof icon === "string") {
    const IconComponent = addonIconMap[normalizeIconKey(icon) as keyof typeof addonIconMap];
    return IconComponent ? (
      <IconComponent className={className} />
    ) : (
      <Icons.PuzzlePiece className={className} />
    );
  }

  if (React.isValidElement<{ className?: string }>(icon)) {
    return icon.props.className ? icon : React.cloneElement(icon, { className });
  }

  if (typeof icon === "function") {
    const IconComponent = icon as React.ComponentType<{ className?: string }>;
    return <IconComponent className={className} />;
  }

  return <Icons.PuzzlePiece className={className} />;
}
