// Legacy HTTP clients retain confirmationUrl; conversational tools return a
// structured placement hint so the model does not send the owner to notifications.
export function conversationConfirmation<
  T extends object,
>(kind: "draft" | "meeting" | "reschedule" | "cascade", result: T) {
  const { confirmationUrl: _legacyUrl, ...data } = result as T & { confirmationUrl?: string };
  return {
    ...data,
    confirmation: { kind, placement: "conversation" as const },
  };
}
