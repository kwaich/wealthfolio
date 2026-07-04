import { useLayoutEffect, useRef, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { addonIframeManager, type AddonRouteRenderStatus } from "./addon-iframe-manager";

interface AddonIframeRouteProps {
  addonId: string;
  routeId: string;
}

export function AddonIframeRoute({ addonId, routeId }: AddonIframeRouteProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const params = useParams();
  const [routeStatus, setRouteStatus] = useState<AddonRouteRenderStatus>({ status: "idle" });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const unsubscribe = addonIframeManager.subscribeRouteStatus(addonId, setRouteStatus);
    addonIframeManager.attachRoute(addonId, container);

    return () => {
      unsubscribe();
      addonIframeManager.detachRoute(addonId, container);
    };
  }, [addonId]);

  useLayoutEffect(() => {
    const routeLocation = {
      hash: location.hash,
      params,
      pathname: location.pathname,
      search: location.search,
    };
    setRouteStatus(addonIframeManager.getRouteStatus(addonId, routeId, routeLocation));
    addonIframeManager.updateRoute(addonId, routeId, routeLocation);
  }, [addonId, routeId, location.hash, location.pathname, location.search, params]);

  const isColdLoading = routeStatus.status === "rendering" && routeStatus.cold;
  const isError = routeStatus.status === "error";

  return (
    <div className="relative min-h-[calc(100vh-96px)] w-full overflow-hidden">
      <div
        ref={containerRef}
        className={cn(
          "min-h-[calc(100vh-96px)] w-full overflow-hidden transition-opacity duration-150",
          isColdLoading && "opacity-0",
        )}
        data-addon-id={addonId}
        data-addon-route-id={routeId}
      />
      {isColdLoading ? <AddonRouteSkeleton /> : null}
      {isError ? (
        <AddonRouteError
          error={routeStatus.error}
          onRetry={() => addonIframeManager.retryRoute(addonId)}
        />
      ) : null}
    </div>
  );
}

function AddonRouteSkeleton() {
  return (
    <div
      className="bg-background text-foreground absolute inset-0 px-6 py-5"
      aria-label="Loading add-on"
      aria-live="polite"
    >
      <div className="space-y-6">
        <div className="bg-muted h-9 w-72 max-w-full animate-pulse rounded-md" />
        <div className="bg-muted h-5 w-[min(28rem,70%)] animate-pulse rounded-md" />
        <div className="grid gap-4 md:grid-cols-3">
          <div className="bg-muted/80 h-28 animate-pulse rounded-md" />
          <div className="bg-muted/80 h-28 animate-pulse rounded-md" />
          <div className="bg-muted/80 h-28 animate-pulse rounded-md" />
        </div>
        <div className="bg-muted/60 h-64 animate-pulse rounded-md" />
      </div>
    </div>
  );
}

function AddonRouteError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="bg-background/95 text-foreground absolute inset-0 px-6 py-5">
      <div className="border-border bg-card max-w-xl rounded-md border p-4 shadow-sm">
        <h2 className="text-lg font-semibold">Add-on view failed to load</h2>
        <p className="text-muted-foreground mt-2 text-sm">{error}</p>
        <button
          type="button"
          className="bg-primary text-primary-foreground hover:bg-primary/90 mt-4 rounded-md px-3 py-2 text-sm font-medium"
          onClick={onRetry}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
