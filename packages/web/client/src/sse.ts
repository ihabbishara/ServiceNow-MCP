// packages/web/client/src/sse.ts
import { useEffect, useReducer, useState } from "react";
import { applyServerEvent, initialState, type ChatState } from "./state.js";
import type { ServerEvent } from "../../shared/events.js";

export const useServerStream = (): { state: ChatState; connected: boolean } => {
  const [state, dispatch] = useReducer(applyServerEvent, initialState);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onmessage = (m) => dispatch(JSON.parse(m.data) as ServerEvent);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);
  return { state, connected };
};
