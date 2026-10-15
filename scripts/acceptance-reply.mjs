/** A historical reply cannot prove that this prompt completed successfully. */
export function requireNewCompletedReply(before, after, marker) {
  const prior = new Set(before.messages.map((message) => message.id));
  const reply = after.messages.find((message) =>
    message.type === "assistant" &&
    !prior.has(message.id) &&
    typeof message.time?.completed === "number" &&
    Number.isFinite(message.time.completed) &&
    message.content?.some((part) => part.type === "text" && part.text === marker),
  );
  if (!reply) throw new Error("No new completed assistant with the request's local stub marker");
  return reply;
}
