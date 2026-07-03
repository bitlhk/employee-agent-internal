/**
 * Runtime WebSocket client facade.
 *
 * The current WebSocket implementation is the legacy lgc-* runtime transport.
 * Product code should import this neutral facade; runtime-specific protocol
 * details stay inside the implementation module.
 */

export {
  OpenClawWSClient as RuntimeWSClient,
  type ChatDelta as RuntimeChatDelta,
  type WSState as RuntimeWSState,
} from "./openclaw-ws";
