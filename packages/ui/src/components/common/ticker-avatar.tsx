import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";

interface TickerAvatarProps {
  symbol: string;
  className?: string;
}

export const TickerAvatar = ({ symbol, className = "size-8" }: TickerAvatarProps) => {
  // Extract the base symbol (before any dot, hyphen, or colon) for fallback
  const baseSymbol = symbol ? symbol.split(/[.:-]/)[0].toUpperCase() : "";
  const fullSymbol = symbol ? symbol.toUpperCase() : "";
  const fallbackAvatarLabel = baseSymbol ? baseSymbol.slice(0, 4) : "•";

  // Try full symbol first, then fallback to base symbol
  const primaryLogoUrl = fullSymbol ? `/ticker-logos/${fullSymbol}.png` : "";
  const fallbackLogoUrl = baseSymbol ? `/ticker-logos/${baseSymbol}.png` : "";
  const [logoUrl, setLogoUrl] = useState(primaryLogoUrl);

  useEffect(() => {
    setLogoUrl(primaryLogoUrl);
  }, [primaryLogoUrl]);

  return (
    <Avatar className={cn("bg-primary/80 dark:bg-primary/20 border-white/20 backdrop-blur-md", className)}>
      <AvatarImage
        src={logoUrl}
        alt={fullSymbol}
        className="object-contain p-2"
        onLoadingStatusChange={(status) => {
          if (status === "error" && logoUrl === primaryLogoUrl && fallbackLogoUrl !== primaryLogoUrl) {
            setLogoUrl(fallbackLogoUrl);
          }
        }}
      />
      <AvatarFallback className="bg-primary/80 dark:bg-primary/20 font-medium text-white">
        <span
          className={cn("px-0.5 leading-none", fallbackAvatarLabel.length >= 4 ? "text-[10px]" : "text-xs")}
          title={fullSymbol}
        >
          {fallbackAvatarLabel}
        </span>
      </AvatarFallback>
    </Avatar>
  );
};
