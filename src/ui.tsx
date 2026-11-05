import React, { useState, useEffect, useCallback, useRef } from "react";
import { api } from "./api";
export function PageHeading({ children }: { children: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = children + " · Betterloop";
    heading.current?.focus();
  }, [children]);
  return (
    <h1 ref={heading} tabIndex={-1}>
      {children}
    </h1>
  );
}
let navigationGuard: (() => boolean) | null = null;
export function setNavigationGuard(guard: (() => boolean) | null) {
  navigationGuard = guard;
}
export function canNavigate() {
  return !navigationGuard || navigationGuard();
}
export function go(path: string) {
  if (!canNavigate()) return;
  history.pushState(null, "", path);
  dispatchEvent(
    new PopStateEvent("popstate", { state: { betterloopNavigation: true } }),
  );
  window.scrollTo(0, 0);
}
export function Button({
  children,
  to,
  onClick,
  secondary = false,
  disabled = false,
}: {
  children: React.ReactNode;
  to?: string;
  onClick?: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={secondary ? "button secondary" : "button"}
      disabled={disabled}
      onClick={() => (to ? go(to) : onClick?.())}
    >
      {children}
    </button>
  );
}
export function ErrorMessage({ error }: { error: string }) {
  return error ? (
    <p className="error" role="alert">
      {error}
    </p>
  ) : null;
}
export function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState("");
  const serial = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++serial.current;
    try {
      setError("");
      const d = await api<T>(path);
      if (current === serial.current) setData(d);
      return d;
    } catch (e) {
      if (current === serial.current) setError((e as Error).message);
      return null;
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      serial.current++;
    };
  }, [refresh]);
  return { data, error, refresh };
}
export const when = (stamp: number, zone?: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(zone ? { timeZone: zone, timeZoneName: "short" } : {}),
  }).format(stamp);
