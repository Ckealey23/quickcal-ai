export const EVENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: ["string", "null"] },
    date: { type: ["string", "null"] },
    startTime: { type: ["string", "null"] },
    endTime: { type: ["string", "null"] },
    timeZone: { type: "string" },
    location: { type: ["string", "null"] },
    needsClarification: { type: "boolean" },
    clarificationQuestions: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "title",
    "date",
    "startTime",
    "endTime",
    "timeZone",
    "location",
    "needsClarification",
    "clarificationQuestions",
  ],
};
