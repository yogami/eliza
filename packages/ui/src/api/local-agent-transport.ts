import { Capacitor } from "@capacitor/core";
import { isMobileLocalAgentUrl } from "../onboarding/local-agent-token";
import { createIttpAgentTransport } from "./ittp-agent-transport";
import {
  handleLocalAgentRequest,
  startLocalAgentKernel,
} from "./local-agent-kernel";
import type { AgentRequestTransport } from "./transport";

let transport: AgentRequestTransport | null = null;
let androidBunReachableProbe: Promise<boolean> | null = null;

type AgentWithLocalToken = {
  getLocalAgentToken?: () => Promise<{
    available?: boolean;
    token?: string | null;
  }>;
};

function isNativeMobile(): "ios" | "android" | null {
  try {
    if (!Capacitor.isNativePlatform()) return null;
    const platform = Capacitor.getPlatform();
    if (platform === "ios" || platform === "android") return platform;
    return null;
  } catch {
    return null;
  }
}

/**
 * On Android Capacitor we have two distinct local-agent shapes:
 *
 *   - AOSP / branded device builds spawn the bun-based ElizaAgentService
 *     foreground service, which listens at http://127.0.0.1:31337. The
 *     native @elizaos/capacitor-agent plugin proxies requests to that
 *     loopback over its own JNI request method (avoids WebView mixed-
 *     content + cleartext friction). `androidNativeAgentTransportForUrl`
 *     handles those.
 *
 *   - Non-AOSP store-shippable Capacitor builds DON'T ship the bun
 *     runtime (the [app-thinning] gradle hook strips assets/agent/) and
 *     ElizaAgentService.shouldAutoStart() returns false. There's nothing
 *     listening on :31337. We need to handle local-agent fetches in JS,
 *     same as iOS — via the local-agent-kernel.
 *
 * Probe `Agent.getLocalAgentToken()`: when bun is up the AOSP service
 * generated and persisted a per-boot token, so `available === true`. When
 * non-AOSP, no service ever wrote one and we get `available === false`.
 * Cached for the rest of the page lifetime — the runtime mode doesn't
 * change without a process restart.
 */
async function isAndroidBunReachable(): Promise<boolean> {
  androidBunReachableProbe ??= (async () => {
    try {
      const capacitorWithPlugins = Capacitor as typeof Capacitor & {
        Plugins?: Record<string, AgentWithLocalToken | undefined>;
      };
      const agent =
        capacitorWithPlugins.Plugins?.Agent ??
        Capacitor.registerPlugin<AgentWithLocalToken>("Agent");
      const result = await agent?.getLocalAgentToken?.();
      return Boolean(result?.available && result.token);
    } catch {
      return false;
    }
  })();
  return androidBunReachableProbe;
}

/**
 * Should the JS-side in-WebView local-agent kernel handle this request?
 *
 * - iOS Capacitor: always (the iOS app never ships a bun process).
 * - Android Capacitor: only when no bun process is reachable. AOSP /
 *   branded builds defer to `androidNativeAgentTransportForUrl`.
 * - Web / desktop: never — the dashboard talks to a real backend.
 */
async function shouldHandleInProcess(url: string): Promise<boolean> {
  if (!isMobileLocalAgentUrl(url)) return false;
  const platform = isNativeMobile();
  if (platform === "ios") return true;
  if (platform === "android") return !(await isAndroidBunReachable());
  return false;
}

export function isMobileInProcessLocalAgentUrl(url: string): boolean {
  if (!isMobileLocalAgentUrl(url)) return false;
  const platform = isNativeMobile();
  return platform !== null;
}

export function isMobileInProcessLocalAgentBase(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl) return false;
  return isMobileInProcessLocalAgentUrl(
    `${baseUrl.replace(/\/+$/, "")}/api/health`,
  );
}

export async function inProcessAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  if (!(await shouldHandleInProcess(url))) return null;
  startLocalAgentKernel();
  transport ??= createIttpAgentTransport((request, context) =>
    handleLocalAgentRequest(request, context),
  );
  return transport;
}

// ── Back-compat aliases ────────────────────────────────────────────────
//
// Pre-Android-port callers used `iosInProcessAgent*`. The behaviour on iOS
// is identical, so we keep the old names exported as thin re-aliases until
// every callsite migrates.

/** @deprecated Use `inProcessAgentTransportForUrl`. */
export const iosInProcessAgentTransportForUrl = inProcessAgentTransportForUrl;

/**
 * @deprecated Use `isMobileInProcessLocalAgentUrl`.
 *
 * Note: the old function was iOS-only; the new function returns `true` on
 * Android Capacitor as well. Existing callers that expect iOS-only semantics
 * should migrate to the new name and re-evaluate the call.
 */
export const isIosInProcessLocalAgentUrl = isMobileInProcessLocalAgentUrl;

/** @deprecated Use `isMobileInProcessLocalAgentBase`. */
export const isIosInProcessLocalAgentBase = isMobileInProcessLocalAgentBase;
