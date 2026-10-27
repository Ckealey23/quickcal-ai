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
    recurrence: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            frequency: { type: "string", enum: ["weekly"] },
            weekdays: {
              type: "array",
              items: { type: "string", enum: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] },
            },
            until: { anyOf: [{ type: "string" }, { type: "null" }] },
            count: { anyOf: [{ type: "integer" }, { type: "null" }] },
          },
          required: ["frequency", "weekdays", "until", "count"],
        },
      ],
    },
    notificationAction: {
      type: "string",
      enum: ["preserve", "replace", "add", "remove", "default"],
    },
    notificationOverrides: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          method: { type: "string", enum: ["popup", "email"] },
          minutes: { type: "integer", minimum: 0, maximum: 40320 },
        },
        required: ["method", "minutes"],
      },
    },
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
    "recurrence",
    "notificationAction",
    "notificationOverrides",
    "needsClarification",
    "clarificationQuestions",
  ],
};
