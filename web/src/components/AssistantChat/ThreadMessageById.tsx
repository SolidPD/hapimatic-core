// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useMemo, type ComponentType, type ReactNode } from "react";
import {
  AssistantProvider,
  useAssistantApi,
  useAssistantState,
  type AssistantApi,
  type AssistantEvent,
  type AssistantEventCallback,
  type AssistantEventSelector,
} from "@assistant-ui/react";

/**
 * #6122: one thread row that resolves its message by id.
 *
 * `ThreadPrimitive.MessageByIndex` resolves its message by position. Its scope reads the
 * message through a closure that assistant-ui (0.11.53, `utils/tap-store/derived-scopes.js`)
 * updates only in an effect. So when a load-older moves a mounted row to a new index, the
 * render that commits it still reads the message at the row's old index. That is another
 * message, and when its role differs the row remounts twice and loses its state (open tool
 * cards, open reasoning). This row's id never changes while it is mounted, so its lookup
 * cannot go stale.
 *
 * It mirrors assistant-ui's `MessageByIndexProvider` and the role switch in
 * `ThreadPrimitive.MessageByIndex`, with `thread().message({ id })` (which the thread client
 * resolves by message id) in place of `{ index }`.
 */
export type ThreadMessageComponents = {
  readonly UserMessage: ComponentType;
  readonly AssistantMessage: ComponentType;
  readonly SystemMessage: ComponentType;
};

// assistant-ui types its message field for index or root lookups only. The query is
// metadata (devtools and memo keys), so an id query is stated as what it is and cast once.
function apiField<T>(
  get: () => T,
  source: string,
  query: Record<string, unknown>
): () => T {
  return Object.assign(() => get(), { source, query });
}

function MessageByIdProvider(props: {
  id: string;
  children: ReactNode;
}): ReactNode {
  const baseApi = useAssistantApi();
  const { id } = props;
  const api = useMemo((): AssistantApi => {
    const getMessage = (): ReturnType<AssistantApi["message"]> =>
      baseApi.thread().message({ id });
    const message = apiField(getMessage, "thread", {
      type: "id",
      id,
    }) as AssistantApi["message"];
    const composer = apiField(
      () => getMessage().composer,
      "message",
      {}
    ) as AssistantApi["composer"];
    // Message and composer events are thread events filtered to this message, as in
    // assistant-ui's MessageByIndexProvider.
    const on = <TEvent extends AssistantEvent>(
      selector: AssistantEventSelector<TEvent>,
      callback: AssistantEventCallback<TEvent>
    ): ReturnType<AssistantApi["on"]> => {
      const { scope, event } =
        typeof selector === "string"
          ? { scope: selector.split(".")[0], event: selector }
          : selector;
      if (scope !== "message" && scope !== "composer") {
        return baseApi.on(selector, callback);
      }
      const forThisMessage = ((payload: { messageId?: string }) => {
        if (payload.messageId === id) callback(payload as never);
      }) as AssistantEventCallback<TEvent>;
      return baseApi.on(
        { scope: "thread", event } as AssistantEventSelector<TEvent>,
        forThisMessage
      );
    };
    return { ...baseApi, message, composer, on };
  }, [baseApi, id]);
  return <AssistantProvider api={api}>{props.children}</AssistantProvider>;
}

function MessageByRole(props: {
  components: ThreadMessageComponents;
}): ReactNode {
  const role = useAssistantState(({ message }) => message.role);
  const { UserMessage, AssistantMessage, SystemMessage } = props.components;
  if (role === "user") return <UserMessage />;
  if (role === "assistant") return <AssistantMessage />;
  return <SystemMessage />;
}

export const ThreadMessageById = memo(function ThreadMessageById(props: {
  id: string;
  components: ThreadMessageComponents;
}): ReactNode {
  return (
    <MessageByIdProvider id={props.id}>
      <MessageByRole components={props.components} />
    </MessageByIdProvider>
  );
});
