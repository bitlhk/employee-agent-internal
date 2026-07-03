import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import { TRPCClientError } from "@trpc/client";
import { useCallback, useEffect, useMemo } from "react";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

const LOGOUT_CACHE_KEY_PREFIXES = [
  "agent_web_sessions_",
  "agent_web_sessions_hidden_",
  "agent_web_conversation_",
  "agent_web_messages_",
  "agent_web_draft_",
  "agent_web_input_history_",
  "agent_claw_status_",
  "agent_claw_model_",
  "lingxia_web_sessions_",
  "lingxia_web_sessions_hidden_",
  "lingxia_web_conversation_",
  "lingxia_web_draft_",
  "lingxia_web_input_history_",
  "lingxia_claw_status_",
  "lingxia_claw_model_",
  "lgc_msgs_",
];

const LOGOUT_LEGACY_CACHE_KEYS = [
  "lingxia-chat-history",
];
const USER_INFO_CACHE_KEY = "workforce-agent-user-info";

function clearLogoutLocalCache() {
  if (typeof window === "undefined") return;
  try {
    for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (LOGOUT_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        window.localStorage.removeItem(key);
      }
    }
    for (const key of LOGOUT_LEGACY_CACHE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {}
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath = getLoginUrl() } =
    options ?? {};
  const utils = trpc.useUtils();

  const meQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const logoutMutation = trpc.auth.logout.useMutation({
    onSuccess: () => {
      utils.auth.me.setData(undefined, null);
    },
  });

  const logout = useCallback(async () => {
    try {
      await logoutMutation.mutateAsync();
    } catch (error: unknown) {
      if (
        error instanceof TRPCClientError &&
        error.data?.code === "UNAUTHORIZED"
      ) {
        return;
      }
      throw error;
    } finally {
      clearLogoutLocalCache();
      utils.auth.me.setData(undefined, null);
      await utils.auth.me.invalidate();
    }
  }, [logoutMutation, utils]);

  const state = useMemo(() => {
    if (meQuery.data) {
      localStorage.setItem(
        USER_INFO_CACHE_KEY,
        JSON.stringify(meQuery.data)
      );
    } else {
      localStorage.removeItem(USER_INFO_CACHE_KEY);
    }
    return {
      user: meQuery.data ?? null,
      loading: meQuery.isLoading || logoutMutation.isPending,
      error: meQuery.error ?? logoutMutation.error ?? null,
      isAuthenticated: Boolean(meQuery.data),
    };
  }, [
    meQuery.data,
    meQuery.error,
    meQuery.isLoading,
    logoutMutation.error,
    logoutMutation.isPending,
  ]);

  useEffect(() => {
    if (!redirectOnUnauthenticated) return;
    if (meQuery.isLoading || logoutMutation.isPending) return;
    if (state.user) return;
    if (typeof window === "undefined") return;
    if (window.location.pathname === redirectPath) return;

    window.location.href = redirectPath
  }, [
    redirectOnUnauthenticated,
    redirectPath,
    logoutMutation.isPending,
    meQuery.isLoading,
    state.user,
  ]);

  return {
    ...state,
    refresh: () => meQuery.refetch(),
    logout,
  };
}
