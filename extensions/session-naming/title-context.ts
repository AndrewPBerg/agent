export const SESSION_TITLE_MESSAGE_TYPE = "session-title-update";

type MaybeCustomMessage = {
  role?: string;
  customType?: string;
};

export function isSessionTitleContextMessage(message: unknown): message is MaybeCustomMessage {
  return (
    message !== null &&
    typeof message === "object" &&
    (message as MaybeCustomMessage).role === "custom" &&
    (message as MaybeCustomMessage).customType === SESSION_TITLE_MESSAGE_TYPE
  );
}

export function filterSessionTitleMessagesFromContext<T>(messages: T[]): T[] {
  return messages.filter((message) => !isSessionTitleContextMessage(message));
}
