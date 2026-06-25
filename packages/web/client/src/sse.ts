// packages/web/client/src/sse.ts
import { useEffect, useReducer } from "react";
import { applyServerEvent, initialState, type ChatState } from "./state.js";
import type { ServerEvent } from "../../shared/events.js";

export const useServerStream = (): ChatState => {
  const [state, dispatch] = useReducer(applyServerEvent, initialState);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (m) => dispatch(JSON.parse(m.data) as ServerEvent);
    return () => es.close();
  }, []);
  return state;
};
